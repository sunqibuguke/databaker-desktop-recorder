use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::path::Path;

const GIB: u64 = 1024 * 1024 * 1024;
const STARTUP_FIXED_RESERVE_BYTES: u64 = 2 * GIB;
const STARTUP_AUDIO_SECONDS: u64 = 2 * 60 * 60;
const CRITICAL_FIXED_RESERVE_BYTES: u64 = GIB;
const CRITICAL_AUDIO_SECONDS: u64 = 30 * 60;
const WARNING_FIXED_RESERVE_BYTES: u64 = 5 * GIB;
const WARNING_AUDIO_SECONDS: u64 = 4 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageStatus {
    Healthy,
    Warning,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StorageReport {
    pub status: StorageStatus,
    pub can_start: bool,
    pub available_bytes: u64,
    pub bytes_per_second: u64,
    /// Recording time until the volume is physically full, rounded down.
    pub remaining_recording_seconds: u64,
    /// Recording time before entering the critical reserve, rounded down.
    pub safe_recording_seconds: u64,
    pub startup_required_bytes: u64,
    pub warning_threshold_bytes: u64,
    pub critical_threshold_bytes: u64,
}

/// One sequential atomic publication in an export. `new_bytes` is the fully
/// written temporary that must coexist with the current destination;
/// `replaced_bytes` is reclaimed only after that temporary is published. A
/// removal-only step uses zero `new_bytes`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AtomicExportStep {
    pub new_bytes: u64,
    pub replaced_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportSpaceReport {
    pub available_bytes: u64,
    pub critical_reserve_bytes: u64,
    pub peak_additional_bytes: u64,
    pub required_available_bytes: u64,
    pub can_export: bool,
}

/// Queries the filesystem containing `directory` and evaluates its recording headroom.
/// The directory must already exist so the operating system can resolve its volume.
pub fn check_storage(
    directory: &Path,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
) -> Result<StorageReport> {
    let available_bytes = fs2::available_space(directory)
        .with_context(|| format!("query available storage for {}", directory.display()))?;
    evaluate_available_space(available_bytes, sample_rate, channels, bit_depth)
}

/// Pure policy evaluation used by the runtime monitor and deterministic tests.
pub fn evaluate_available_space(
    available_bytes: u64,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
) -> Result<StorageReport> {
    let bytes_per_second = audio_bytes_per_second(sample_rate, channels, bit_depth)?;
    let startup_required_bytes = threshold_bytes(
        STARTUP_FIXED_RESERVE_BYTES,
        STARTUP_AUDIO_SECONDS,
        bytes_per_second,
    )?;
    let critical_threshold_bytes = threshold_bytes(
        CRITICAL_FIXED_RESERVE_BYTES,
        CRITICAL_AUDIO_SECONDS,
        bytes_per_second,
    )?;
    let warning_threshold_bytes = threshold_bytes(
        WARNING_FIXED_RESERVE_BYTES,
        WARNING_AUDIO_SECONDS,
        bytes_per_second,
    )?;
    // Alert at the exact reserve boundary as well; the reserve itself is not
    // normal recording headroom and must remain available for safe shutdown.
    let status = if available_bytes <= critical_threshold_bytes {
        StorageStatus::Critical
    } else if available_bytes <= warning_threshold_bytes {
        StorageStatus::Warning
    } else {
        StorageStatus::Healthy
    };

    Ok(StorageReport {
        status,
        can_start: available_bytes >= startup_required_bytes,
        available_bytes,
        bytes_per_second,
        remaining_recording_seconds: available_bytes / bytes_per_second,
        safe_recording_seconds: available_bytes.saturating_sub(critical_threshold_bytes)
            / bytes_per_second,
        startup_required_bytes,
        warning_threshold_bytes,
        critical_threshold_bytes,
    })
}

/// Computes the peak additional allocation of sequential atomic replacements.
/// Unlike summing a whole new bundle, this credits each old destination only
/// after its replacement is published, matching the real export order.
pub fn evaluate_atomic_export_space(
    available_bytes: u64,
    critical_reserve_bytes: u64,
    steps: &[AtomicExportStep],
) -> Result<ExportSpaceReport> {
    let mut published_bytes = 0u64;
    let mut reclaimed_bytes = 0u64;
    let mut peak_additional_bytes = 0u64;
    for step in steps {
        let transient_published = published_bytes
            .checked_add(step.new_bytes)
            .context("export temporary byte total overflow")?;
        peak_additional_bytes =
            peak_additional_bytes.max(transient_published.saturating_sub(reclaimed_bytes));
        published_bytes = transient_published;
        reclaimed_bytes = reclaimed_bytes
            .checked_add(step.replaced_bytes)
            .context("export reclaimed byte total overflow")?;
    }
    let required_available_bytes = critical_reserve_bytes
        .checked_add(peak_additional_bytes)
        .context("export required storage overflow")?;
    Ok(ExportSpaceReport {
        available_bytes,
        critical_reserve_bytes,
        peak_additional_bytes,
        required_available_bytes,
        can_export: available_bytes >= required_available_bytes,
    })
}

pub fn audio_bytes_per_second(sample_rate: u32, channels: u16, bit_depth: u16) -> Result<u64> {
    if sample_rate == 0 {
        bail!("sample rate must be greater than zero");
    }
    if channels == 0 {
        bail!("channel count must be greater than zero");
    }
    if !matches!(bit_depth, 16 | 24 | 32) {
        bail!("bit depth must be one of 16, 24, or 32 bits");
    }
    u64::from(sample_rate)
        .checked_mul(u64::from(channels))
        .and_then(|value| value.checked_mul(u64::from(bit_depth / 8)))
        .context("audio byte rate overflow")
}

fn threshold_bytes(fixed_reserve: u64, seconds: u64, bytes_per_second: u64) -> Result<u64> {
    let duration_reserve = bytes_per_second
        .checked_mul(seconds)
        .context("storage threshold overflow")?;
    Ok(fixed_reserve.max(duration_reserve))
}
