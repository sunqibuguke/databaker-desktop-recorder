use anyhow::{Context, Result};
use std::ffi::OsString;
#[cfg(any(unix, test))]
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static DIRECTORY_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn parent_directory(path: &Path) -> Result<&Path> {
    path.parent()
        .map(|parent| {
            if parent.as_os_str().is_empty() {
                Path::new(".")
            } else {
                parent
            }
        })
        .context("durable path has no parent")
}

#[cfg(windows)]
fn move_file(source: &Path, destination: &Path, replace: bool) -> Result<()> {
    use anyhow::bail;
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x0000_0001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;

    #[link(name = "Kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    fn wide_path(path: &Path) -> Result<Vec<u16>> {
        let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if wide.contains(&0) {
            bail!("Windows path contains an interior NUL: {}", path.display());
        }
        wide.push(0);
        Ok(wide)
    }

    let source_wide = wide_path(source)?;
    let destination_wide = wide_path(destination)?;
    // SAFETY: both buffers are NUL-terminated and remain alive for the call.
    let flags = MOVEFILE_WRITE_THROUGH
        | if replace {
            MOVEFILE_REPLACE_EXISTING
        } else {
            0
        };
    let moved = unsafe { MoveFileExW(source_wide.as_ptr(), destination_wide.as_ptr(), flags) };
    if moved == 0 {
        return Err(std::io::Error::last_os_error()).with_context(|| {
            format!(
                "durably replace {} with {}",
                destination.display(),
                source.display()
            )
        });
    }
    Ok(())
}

/// Publishes a new name and requests durable namespace completion. The caller
/// must ensure both paths are on the same filesystem.
#[cfg(windows)]
pub(crate) fn durable_rename(source: &Path, destination: &Path) -> Result<()> {
    move_file(source, destination, false)
}

#[cfg(unix)]
pub(crate) fn durable_rename(source: &Path, destination: &Path) -> Result<()> {
    rename_and_sync(source, destination)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn durable_rename(source: &Path, destination: &Path) -> Result<()> {
    std::fs::rename(source, destination)
        .with_context(|| format!("rename {} as {}", source.display(), destination.display()))
}

/// Atomically replaces `destination` with `source` and requests durable
/// namespace completion before returning. Windows must opt into both replace
/// and write-through behavior explicitly; `std::fs::rename` does neither.
#[cfg(windows)]
pub(crate) fn durable_replace(source: &Path, destination: &Path) -> Result<()> {
    move_file(source, destination, true)
}

#[cfg(unix)]
pub(crate) fn durable_replace(source: &Path, destination: &Path) -> Result<()> {
    rename_and_sync(source, destination)
}

#[cfg(unix)]
fn rename_and_sync(source: &Path, destination: &Path) -> Result<()> {
    std::fs::rename(source, destination).with_context(|| {
        format!(
            "replace {} with {}",
            destination.display(),
            source.display()
        )
    })?;
    let destination_parent = parent_directory(destination)?;
    sync_directory(destination_parent)?;
    let source_parent = parent_directory(source)?;
    if source_parent != destination_parent {
        sync_directory(source_parent)?;
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn durable_replace(source: &Path, destination: &Path) -> Result<()> {
    std::fs::rename(source, destination).with_context(|| {
        format!(
            "replace {} with {}",
            destination.display(),
            source.display()
        )
    })
}

pub(crate) fn sync_parent_directory(path: &Path) -> Result<()> {
    sync_directory(parent_directory(path)?)
}

/// Creates one directory by publishing a unique empty sibling through the same
/// durable rename primitive used for files. This is important on Windows,
/// where Rust cannot portably fsync a directory handle: creating the final name
/// directly can otherwise leave an hour of synced child files reachable only
/// through a parent entry whose durability was never requested.
pub(crate) fn durable_create_directory(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .context("durable directory path has no file name")?;
    match std::fs::symlink_metadata(path) {
        Ok(_) => anyhow::bail!("refusing to overwrite directory {}", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| format!("inspect directory {}", path.display()));
        }
    }

    let temporary = loop {
        let sequence = DIRECTORY_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = OsString::from(".");
        temporary_name.push(file_name);
        temporary_name.push(format!(
            ".creating-directory-{}-{sequence}",
            std::process::id()
        ));
        let candidate = parent.join(temporary_name);
        match std::fs::create_dir(&candidate) {
            Ok(()) => break candidate,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("create temporary directory {}", candidate.display())
                });
            }
        }
    };

    let result = durable_rename(&temporary, path).with_context(|| {
        format!(
            "publish temporary directory {} as {}",
            temporary.display(),
            path.display()
        )
    });
    if result.is_err()
        && let Ok(metadata) = std::fs::symlink_metadata(&temporary)
        && metadata.is_dir()
        && !metadata.file_type().is_symlink()
    {
        let _ = std::fs::remove_dir(&temporary);
    }
    result
}

/// Durable equivalent of `create_dir_all`. Existing components are retained;
/// each missing component is published one at a time so its parent namespace
/// is committed before a child can contain authoritative recording data.
pub(crate) fn durable_create_directory_all(path: &Path) -> Result<()> {
    let mut missing = Vec::new();
    let mut cursor = path;
    loop {
        match std::fs::symlink_metadata(cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    anyhow::bail!(
                        "durable directory ancestor must be a regular directory: {}",
                        cursor.display()
                    );
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(cursor.to_path_buf());
                cursor = cursor
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .unwrap_or_else(|| Path::new("."));
            }
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("inspect directory {}", cursor.display()));
            }
        }
    }
    for directory in missing.into_iter().rev() {
        durable_create_directory(&directory)?;
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn sync_directory(directory: &Path) -> Result<()> {
    File::open(directory)
        .with_context(|| format!("open directory {} for sync", directory.display()))?
        .sync_all()
        .with_context(|| format!("sync directory {}", directory.display()))
}

#[cfg(not(unix))]
pub(crate) fn sync_directory(_directory: &Path) -> Result<()> {
    // Windows namespace publication uses MOVEFILE_WRITE_THROUGH above. Rust's
    // portable File API cannot open directory handles with backup semantics.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn durable_replace_publishes_new_and_replacement_files() {
        let root = std::env::temp_dir().join(format!(
            "recorder-durable-replace-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("value.tmp");
        let destination = root.join("value.json");

        let mut file = File::create(&source).unwrap();
        file.write_all(b"first").unwrap();
        file.sync_all().unwrap();
        // Windows does not permit MoveFileExW to move a file while this
        // process still owns an open handle to it.
        drop(file);
        durable_rename(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"first");
        assert!(!source.exists());

        let mut file = File::create(&source).unwrap();
        file.write_all(b"second").unwrap();
        file.sync_all().unwrap();
        drop(file);
        durable_replace(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"second");
        assert!(!source.exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn durable_directory_creation_publishes_every_missing_ancestor() {
        let root = std::env::temp_dir().join(format!(
            "recorder-durable-directory-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let nested = root.join("recordings/task/audio/segments");
        durable_create_directory_all(&nested).unwrap();
        assert!(nested.is_dir());
        durable_create_directory_all(&nested).unwrap();

        let sibling = root.join("recordings/task/metadata");
        durable_create_directory(&sibling).unwrap();
        assert!(sibling.is_dir());
        assert!(
            std::fs::read_dir(sibling.parent().unwrap())
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains("creating-directory"))
        );

        let _ = std::fs::remove_dir_all(root);
    }
}
