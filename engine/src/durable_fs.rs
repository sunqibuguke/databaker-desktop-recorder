use anyhow::{Context, Result};
#[cfg(any(unix, test))]
use std::fs::File;
use std::path::Path;

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
    let destination_parent = destination
        .parent()
        .context("durable replacement destination has no parent")?;
    sync_directory(destination_parent)?;
    if let Some(source_parent) = source.parent()
        && source_parent != destination_parent
    {
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
    let parent = path.parent().context("durable path has no parent")?;
    sync_directory(parent)
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
        durable_rename(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"first");
        assert!(!source.exists());

        let mut file = File::create(&source).unwrap();
        file.write_all(b"second").unwrap();
        file.sync_all().unwrap();
        durable_replace(&source, &destination).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"second");
        assert!(!source.exists());

        let _ = std::fs::remove_dir_all(root);
    }
}
