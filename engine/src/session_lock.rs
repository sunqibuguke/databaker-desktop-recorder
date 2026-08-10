use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// A process-wide lease for one recording directory.
///
/// The lock file intentionally remains on disk after a clean exit. The OS lock,
/// not file existence, is authoritative; keeping the file also leaves useful
/// diagnostic evidence after a crash or power loss.
pub struct SessionLock {
    _file: File,
    path: PathBuf,
}

#[derive(Serialize)]
struct LockOwner<'a> {
    schema_version: u32,
    pid: u32,
    acquired_at: &'a str,
}

impl SessionLock {
    pub fn acquire(session_dir: &Path, acquired_at: &str) -> Result<Self> {
        let metadata_dir = session_dir.join("metadata");
        let metadata = std::fs::symlink_metadata(&metadata_dir)
            .with_context(|| format!("inspect metadata directory {}", metadata_dir.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!("recording metadata path must be a regular directory");
        }

        let path = metadata_dir.join("session.lock");
        if let Ok(metadata) = std::fs::symlink_metadata(&path)
            && (metadata.file_type().is_symlink() || !metadata.is_file())
        {
            bail!("recording session lock must be a regular file");
        }

        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .with_context(|| format!("open recording session lock {}", path.display()))?;
        file.try_lock().with_context(|| {
            format!(
                "recording directory {} is already open in another recorder process",
                session_dir.display()
            )
        })?;

        // Write owner information only after acquiring the exclusive OS lock so
        // two contenders cannot overwrite each other's diagnostics.
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        serde_json::to_writer_pretty(
            &mut file,
            &LockOwner {
                schema_version: 1,
                pid: std::process::id(),
                acquired_at,
            },
        )?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;

        Ok(Self { _file: file, path })
    }

    #[allow(dead_code)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "databaker-session-lock-{name}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(root.join("metadata")).unwrap();
        root
    }

    #[test]
    fn prevents_two_recorders_from_opening_the_same_session() {
        let root = test_root("exclusive");
        let first = SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap();
        let second = SessionLock::acquire(&root, "2026-08-11T00:00:01Z");
        assert!(second.is_err());

        drop(first);
        let reopened = SessionLock::acquire(&root, "2026-08-11T00:00:02Z").unwrap();
        assert_eq!(reopened.path(), root.join("metadata/session.lock"));
        drop(reopened);
        let _ = std::fs::remove_dir_all(root);
    }
}
