mod crockford;
mod ticket;

use std::path::{Path, PathBuf};

pub use ticket::{
    inspect_license_ticket, issue_license, normalize_machine_code, IssueLicenseInput,
    LicenseClaims, DEFAULT_KID, LICENSE_TICKET_PREFIX,
};

#[derive(Debug)]
pub struct IssueError(pub String);

impl From<&str> for IssueError {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<String> for IssueError {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl std::fmt::Display for IssueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for IssueError {}

pub fn resolve_private_key_path(explicit: Option<&Path>) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return Some(path.to_path_buf());
    }
    if let Ok(path) = std::env::var("DATABAKER_LICENSE_PRIVATE_KEY_FILE") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("license-2026a.pem"));
            candidates.push(dir.join("keys").join("license-2026a.pem"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = cwd;
        for _ in 0..8 {
            candidates.push(dir.join("tools/license-issuer/keys/license-2026a.pem"));
            if !dir.pop() {
                break;
            }
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub fn issuer_password_ok(provided: Option<&str>) -> Result<(), IssueError> {
    let expected = std::env::var("DATABAKER_LICENSE_ISSUER_PASSWORD").ok();
    let Some(expected) = expected.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    if provided.unwrap_or_default() != expected {
        return Err(IssueError::from("注册机口令不正确"));
    }
    Ok(())
}
