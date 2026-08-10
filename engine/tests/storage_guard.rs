#[path = "../src/storage_guard.rs"]
mod storage_guard;

use storage_guard::{
    StorageStatus, audio_bytes_per_second, check_storage, evaluate_available_space,
};

const GIB: u64 = 1024 * 1024 * 1024;

#[test]
fn calculates_byte_rates_for_all_supported_bit_depths() {
    assert_eq!(audio_bytes_per_second(48_000, 1, 16).unwrap(), 96_000);
    assert_eq!(audio_bytes_per_second(48_000, 1, 24).unwrap(), 144_000);
    assert_eq!(audio_bytes_per_second(48_000, 1, 32).unwrap(), 192_000);
    assert_eq!(audio_bytes_per_second(48_000, 2, 32).unwrap(), 384_000);
}

#[test]
fn rejects_invalid_audio_formats() {
    assert!(audio_bytes_per_second(0, 1, 16).is_err());
    assert!(audio_bytes_per_second(48_000, 0, 16).is_err());
    assert!(audio_bytes_per_second(48_000, 1, 20).is_err());
}

#[test]
fn fixed_reserves_dominate_for_standard_mono_recording() {
    let report = evaluate_available_space(8 * GIB, 48_000, 1, 32).unwrap();
    assert_eq!(report.startup_required_bytes, 2 * GIB);
    assert_eq!(report.critical_threshold_bytes, GIB);
    assert_eq!(report.warning_threshold_bytes, 5 * GIB);
}

#[test]
fn duration_reserves_dominate_for_high_bandwidth_recording() {
    let bytes_per_second = audio_bytes_per_second(192_000, 2, 32).unwrap();
    let report = evaluate_available_space(u64::MAX, 192_000, 2, 32).unwrap();
    assert_eq!(
        report.startup_required_bytes,
        bytes_per_second * 2 * 60 * 60
    );
    assert_eq!(report.critical_threshold_bytes, bytes_per_second * 30 * 60);
    assert_eq!(
        report.warning_threshold_bytes,
        bytes_per_second * 4 * 60 * 60
    );
}

#[test]
fn classifies_exact_warning_and_critical_boundaries() {
    let policy = evaluate_available_space(u64::MAX, 48_000, 1, 24).unwrap();

    let below_critical =
        evaluate_available_space(policy.critical_threshold_bytes - 1, 48_000, 1, 24).unwrap();
    assert_eq!(below_critical.status, StorageStatus::Critical);

    let at_critical =
        evaluate_available_space(policy.critical_threshold_bytes, 48_000, 1, 24).unwrap();
    assert_eq!(at_critical.status, StorageStatus::Critical);
    assert_eq!(at_critical.safe_recording_seconds, 0);

    let above_critical =
        evaluate_available_space(policy.critical_threshold_bytes + 1, 48_000, 1, 24).unwrap();
    assert_eq!(above_critical.status, StorageStatus::Warning);

    let at_warning =
        evaluate_available_space(policy.warning_threshold_bytes, 48_000, 1, 24).unwrap();
    assert_eq!(at_warning.status, StorageStatus::Warning);

    let above_warning =
        evaluate_available_space(policy.warning_threshold_bytes + 1, 48_000, 1, 24).unwrap();
    assert_eq!(above_warning.status, StorageStatus::Healthy);
}

#[test]
fn startup_gate_accepts_its_exact_boundary() {
    let policy = evaluate_available_space(u64::MAX, 48_000, 1, 16).unwrap();
    let below = evaluate_available_space(policy.startup_required_bytes - 1, 48_000, 1, 16).unwrap();
    let exact = evaluate_available_space(policy.startup_required_bytes, 48_000, 1, 16).unwrap();
    assert!(!below.can_start);
    assert!(exact.can_start);
}

#[test]
fn reports_raw_and_safe_remaining_recording_time() {
    let policy = evaluate_available_space(u64::MAX, 48_000, 1, 16).unwrap();
    let available = policy.critical_threshold_bytes + 96_000 * 123 + 95_999;
    let report = evaluate_available_space(available, 48_000, 1, 16).unwrap();
    assert_eq!(report.remaining_recording_seconds, available / 96_000);
    assert_eq!(report.safe_recording_seconds, 123);
}

#[test]
fn queries_available_space_for_a_real_directory() {
    let report = check_storage(std::env::temp_dir().as_path(), 48_000, 1, 24).unwrap();
    assert_eq!(report.bytes_per_second, 144_000);
    assert_eq!(
        report.remaining_recording_seconds,
        report.available_bytes / report.bytes_per_second
    );
}
