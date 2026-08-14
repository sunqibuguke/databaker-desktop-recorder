use std::fs;
use std::path::{Path, PathBuf};

use crate::ticket::{inspect_license_ticket, LicenseClaims};
use crate::IssueError;

const LICENSE_FILE_NAME: &str = "license.json";
const APP_DIR_NAMES: &[&str] = &["标贝音频采集", "databaker-desktop-recorder"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalLicenseProbe {
    pub files: Vec<PathBuf>,
    pub claims: Option<LicenseClaims>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClearLocalLicenseResult {
    pub removed: Vec<PathBuf>,
}

pub fn probe_local_license(explicit: Option<&Path>) -> LocalLicenseProbe {
    let files = collect_existing_files(explicit);
    let claims = files.iter().find_map(|path| read_stored_claims(path));
    LocalLicenseProbe { files, claims }
}

pub fn clear_local_license(explicit: Option<&Path>) -> Result<ClearLocalLicenseResult, IssueError> {
    let files = collect_existing_files(explicit);
    if files.is_empty() {
        return Ok(ClearLocalLicenseResult {
            removed: Vec::new(),
        });
    }

    let mut removed = Vec::new();
    let mut errors = Vec::new();
    for path in files {
        match fs::remove_file(&path) {
            Ok(()) => removed.push(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => errors.push(format!("{}：{error}", path.display())),
        }
    }
    if !errors.is_empty() {
        return Err(IssueError::from(format!(
            "部分授权文件未能删除：{}",
            errors.join("；")
        )));
    }
    Ok(ClearLocalLicenseResult { removed })
}

fn collect_existing_files(explicit: Option<&Path>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for license_path in candidate_license_files(explicit) {
        for path in related_files(&license_path) {
            if !files.iter().any(|existing| existing == &path) {
                files.push(path);
            }
        }
    }
    files
}

fn candidate_license_files(explicit: Option<&Path>) -> Vec<PathBuf> {
    if let Some(path) = explicit {
        return vec![path.to_path_buf()];
    }
    if let Ok(path) = std::env::var("DATABAKER_LICENSE_FILE") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return vec![PathBuf::from(trimmed)];
        }
    }
    user_data_roots()
        .into_iter()
        .flat_map(|root| {
            APP_DIR_NAMES
                .iter()
                .map(move |name| root.join(name).join(LICENSE_FILE_NAME))
        })
        .collect()
}

fn user_data_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.push(home.join("Library/Application Support"));
        roots.push(home.join(".config"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(appdata));
    } else if let Some(profile) = std::env::var_os("USERPROFILE") {
        roots.push(PathBuf::from(profile).join("AppData/Roaming"));
    }
    roots
}

fn related_files(license_path: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if license_path.is_file() {
        files.push(license_path.to_path_buf());
    }
    let Some(dir) = license_path.parent() else {
        return files;
    };
    let Some(name) = license_path.file_name().and_then(|value| value.to_str()) else {
        return files;
    };
    let corrupt_prefix = format!("{name}.corrupt-");
    let tmp_prefix = format!("{name}.tmp-");
    let Ok(entries) = fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let entry_name = entry.file_name();
        let Some(entry_name) = entry_name.to_str() else {
            continue;
        };
        if (entry_name.starts_with(&corrupt_prefix) || entry_name.starts_with(&tmp_prefix))
            && entry.path().is_file()
        {
            files.push(entry.path());
        }
    }
    files
}

fn read_stored_claims(path: &Path) -> Option<LicenseClaims> {
    let serialized = fs::read_to_string(path).ok()?;
    let ticket = json_string_field(&serialized, "ticket")?;
    inspect_license_ticket(&ticket).ok()
}

fn json_string_field(json: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let start = json.find(&needle)? + needle.len();
    let rest = json[start..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(out),
            '\\' => out.push(chars.next()?),
            ch => out.push(ch),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir() -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "databaker-issuer-clear-{}-{}",
            std::process::id(),
            stamp
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn clears_license_and_sidecar_files() {
        let dir = temp_dir();
        let license = dir.join(LICENSE_FILE_NAME);
        let corrupt = dir.join("license.json.corrupt-1");
        let tmp = dir.join("license.json.tmp-9");
        let keep = dir.join("output-root.json");
        fs::write(&license, "{\"ticket\":\"x\"}\n").unwrap();
        fs::write(&corrupt, "broken\n").unwrap();
        fs::write(&tmp, "tmp\n").unwrap();
        fs::write(&keep, "{}\n").unwrap();

        let result = clear_local_license(Some(&license)).unwrap();
        assert_eq!(result.removed.len(), 3);
        assert!(!license.exists());
        assert!(!corrupt.exists());
        assert!(!tmp.exists());
        assert!(keep.exists());

        let empty = clear_local_license(Some(&license)).unwrap();
        assert!(empty.removed.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn probe_reads_ticket_subject() {
        let dir = temp_dir();
        let license = dir.join(LICENSE_FILE_NAME);
        fs::write(
            &license,
            "{\n  \"schemaVersion\": 1,\n  \"ticket\": \"not-a-ticket\"\n}\n",
        )
        .unwrap();
        let probe = probe_local_license(Some(&license));
        assert_eq!(probe.files, vec![license]);
        assert!(probe.claims.is_none());
        fs::remove_dir_all(dir).ok();
    }
}
