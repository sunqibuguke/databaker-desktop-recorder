#[cfg(test)]
use crate::attempt::HEAD_SILENCE_IDLE;
use crate::attempt::{
    HEAD_SILENCE_PASSED, HEAD_SILENCE_SPEECH_STARTED, HEAD_SILENCE_WAITING, HeadSilenceMonitor,
    annotate_attempt_block, begin_analysis_write, energy_is_speech, head_silence_phase_name,
};
use crate::durable_fs::{
    durable_create_directory, durable_create_directory_all, durable_replace, sync_directory,
    sync_parent_directory,
};
use crate::protocol::Emitter;
use crate::segmented_wav::{PreparedWavExport, SegmentedWav};
use crate::session_lock::SessionLock;
use crate::storage_guard::{
    AtomicExportStep, StorageReport, StorageStatus, check_storage, evaluate_atomic_export_space,
};
use crate::vad::{
    DETECTOR_ENERGY, DETECTOR_VAD, VAD_HEALTH_DEGRADED, VAD_HEALTH_HEALTHY, VAD_HEALTH_UNAVAILABLE,
    VAD_ISSUE_CLASSIFIER_FAILURE, VAD_ISSUE_FLUSH_TIMEOUT, VAD_ISSUE_QUEUE_OVERFLOW,
    VAD_ISSUE_WORKER_DISCONNECTED, VAD_QUEUE_LAGGING_MILLIS, VadAnalysisBlock, VadAnnotationSink,
    VadControlMessage, VadFlushOutcome, VadQueueBudget, VadTelemetry, run_vad_analysis_thread,
    trimmed_speech_bounds,
};
use crate::wav::{
    RecoverableWav, WavEncoding, WavExportMode, WavExportWriter, automatic_wav_container_name,
    automatic_wav_file_size, slice_wav_mono, standard_wav_file_size, validate_standard_wav_size,
    waveform_wav_mono,
};
use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    Device, I24, SampleFormat, ShareMode, SizedSample, Stream, StreamConfig, SupportedStreamConfig,
    U24,
};
use crossbeam_channel::{Receiver, Sender, TrySendError, bounded, unbounded};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
#[cfg(test)]
use std::collections::VecDeque;
use std::error::Error as StdError;
use std::ffi::OsString;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const STORAGE_LAYOUT_VERSION: u32 = 1;
const STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS: u64 = 5 * 60;
const STORAGE_LAYOUT_MIN_SEGMENT_SECONDS: u64 = 1;
const STORAGE_LAYOUT_MAX_SEGMENT_SECONDS: u64 = 60 * 60;
const LEGACY_MASTER_AUDIO: &str = "audio/master.wav";
const SEGMENTED_MASTER_AUDIO: &str = "audio/segments";
const SNAPSHOT_MAX_BYTES: u64 = 64 * 1024 * 1024;
const JOURNAL_MAX_BYTES: u64 = 128 * 1024 * 1024;
const SESSION_IDENTITY_MAX_BYTES: u64 = 1024 * 1024;
const LIVE_PREVIEW_MAX_SECONDS: u64 = 10 * 60;
const LEGACY_PREVIEW_MAX_SNAPSHOT_BYTES: u64 = 256 * 1024 * 1024;
const WRITER_QUEUE_AUDIO_BUDGET_SECONDS: u64 = 20;
// Audio is written continuously, but forcing the OS/device cache to stable
// storage on every callback is unnecessarily expensive on Windows. A normal
// automatic checkpoint is taken every ten wall-clock seconds or ten seconds of
// newly-written audio, whichever comes first. Together with the bounded writer
// queue this keeps the accepted-but-not-checkpointed tail within 30 seconds.
const WRITER_AUTOMATIC_CHECKPOINT_SECONDS: u64 = 10;
// Disk-space queries are inexpensive and remain frequent. Keep them separate
// from the audio checkpoint clock so a studio workflow with many short takes
// cannot postpone the critical-reserve guard by checkpointing every sentence.
const WRITER_STORAGE_CHECK_INTERVAL_SECONDS: u64 = 1;
const WRITER_POWER_LOSS_TAIL_BUDGET_SECONDS: u64 = 30;
const WAVEFORM_BIN_SAMPLES: usize = 64;
const _: () = {
    assert!(
        WRITER_AUTOMATIC_CHECKPOINT_SECONDS + WRITER_QUEUE_AUDIO_BUDGET_SECONDS
            <= WRITER_POWER_LOSS_TAIL_BUDGET_SECONDS
    );
    assert!(WRITER_POWER_LOSS_TAIL_BUDGET_SECONDS <= 30);
    assert!(WRITER_STORAGE_CHECK_INTERVAL_SECONDS < WRITER_AUTOMATIC_CHECKPOINT_SECONDS);
};
const WRITER_QUEUE_CLOSED: u64 = 1 << 63;
const WRITER_QUEUE_IN_FLIGHT_MASK: u64 = WRITER_QUEUE_CLOSED - 1;
const WRITER_CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(25);
const WRITER_COMMIT_DEADLINE: Duration = Duration::from_secs(30);
// A capture callback publishes its signal/silence analysis immediately after
// its sample block has entered the writer queue. Protocol commands must not
// classify a fixed capture boundary until that publication catches up.
const CAPTURE_ANALYSIS_TIMEOUT: Duration = Duration::from_secs(2);
const CAPTURE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
// A healthy real-time input stream produces non-empty buffers far more often
// than this, even with unusually large USB-interface buffers. Some Windows
// drivers can nevertheless leave the stream/process alive after unplug or an
// internal endpoint failure without invoking CPAL's error callback. Fail closed
// before such a silent stall can be mistaken for valid room silence.
const CAPTURE_CALLBACK_STALL_TIMEOUT: Duration = Duration::from_secs(5);
// Exact digital equilibrium is materially different from ordinary room
// silence. A muted interface, wrong input channel, or DSP gate can keep the
// callback healthy while delivering only zero-valued PCM. Keep recording and
// writing that valid timeline, but surface a strong operator warning after a
// sustained run so it cannot be mistaken for a healthy microphone signal.
const DIGITAL_SILENCE_WARNING_SECONDS: u64 = 10;
const CAPTURE_FAULT_NONE: u32 = 0;
const CAPTURE_FAULT_DEVICE_UNAVAILABLE: u32 = 1;
const CAPTURE_FAULT_DEVICE_STALLED: u32 = 2;
const CAPTURE_FAULT_INPUT_DISCONTINUITY: u32 = 3;
const CAPTURE_FAULT_INPUT_STREAM_ERROR: u32 = 4;
// Electron gives normal engine commands 20 seconds. Return control to the
// protocol loop before that deadline so a slow preview worker can never block
// a subsequent safe-stop request until the 90-second process kill budget.
const PREVIEW_RENDER_TIMEOUT: Duration = Duration::from_secs(15);
const WAVEFORM_RENDER_TIMEOUT: Duration = Duration::from_secs(30);
const AUDIO_FAULT_MARKER: &str = "metadata/audio-fault.json";
// Provision this small, already-synced file while the recording volume still
// has startup headroom. If a later PCM write consumes the last allocatable
// bytes, publishing a generic fail-closed marker requires only a same-directory
// rename; enriching it with the exact reason remains best effort.
const AUDIO_FAULT_RESERVE: &str = "metadata/audio-fault.reserve";
const AUDIO_FAULT_RESERVE_MAX_BYTES: u64 = 16 * 1024;
const EXPORT_METADATA_BASE_HEADROOM_BYTES: u64 = 4 * 1024 * 1024;
const EXPORT_FILE_ALLOCATION_HEADROOM_BYTES: u64 = 64 * 1024;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Default)]
struct CaptureRecoveryTelemetry {
    discontinuities: Arc<AtomicU64>,
    inserted_silence_frames: Arc<AtomicU64>,
}

#[derive(Debug)]
pub struct NoActiveSessionError;

impl fmt::Display for NoActiveSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("当前没有进行中的录制")
    }
}

impl StdError for NoActiveSessionError {}

pub fn is_no_active_session_error(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<NoActiveSessionError>().is_some())
}

fn no_active_session_error() -> anyhow::Error {
    anyhow!(NoActiveSessionError)
}

#[derive(Debug)]
struct MetadataSealError {
    metadata_fault: String,
    warnings: Vec<String>,
}

impl fmt::Display for MetadataSealError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "录制的原始母轨已停止，但元数据未能安全封存：{}",
            self.metadata_fault
        )?;
        if !self.warnings.is_empty() {
            write!(formatter, "；停止告警：{}", self.warnings.join("；"))?;
        }
        Ok(())
    }
}

impl StdError for MetadataSealError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptItem {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attempt {
    pub attempt_id: String,
    pub start_sample: u64,
    #[serde(default)]
    pub recording_started_sample: u64,
    /// Capture boundary at which the operator clicked start and the pending
    /// timer was armed.
    #[serde(default)]
    pub head_silence_armed_sample: u64,
    /// First sample at which the configured pending duration had elapsed.
    /// This is elapsed time from the click, not a VAD gate.
    #[serde(default)]
    pub head_silence_passed_sample: u64,
    /// Pending / head-pad requirement in force for this take.
    #[serde(default)]
    pub required_head_silence_samples: u64,
    #[serde(default)]
    pub content_started_sample: u64,
    pub end_sample: u64,
    /// True when the recorded tail is shorter than the configured duration.
    /// Informational only: stop is not gated on detected silence.
    #[serde(default)]
    pub forced_without_tail_silence: bool,
    /// Silence available at the fixed stop boundary, measured from the end of
    /// the most recent above-threshold capture block.
    #[serde(default)]
    pub tail_silence_samples: u64,
    /// Tail-silence requirement in force when this take was completed.
    #[serde(default)]
    pub required_tail_silence_samples: u64,
    pub status: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quality_issues: Vec<AttemptQualityIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttemptQualityIssue {
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_sample: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_sample: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detector_generation: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct VadDiagnostics {
    pub queue_capacity_samples: u64,
    pub queue_capacity_blocks: u64,
    pub queue_high_water_samples: u64,
    pub overflow_count: u64,
    pub dropped_samples: u64,
    pub classifier_failure_count: u64,
    pub flush_timeout_count: u64,
    pub worker_disconnect_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemState {
    pub id: String,
    pub text: String,
    pub label: String,
    pub status: String,
    pub attempts: Vec<Attempt>,
    pub selected_attempt_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioFormat {
    pub sample_rate: u32,
    #[serde(default = "default_bit_depth")]
    pub bit_depth: u16,
    #[serde(default = "default_audio_encoding")]
    pub encoding: String,
    pub channels: u16,
    pub input_channels: u16,
    #[serde(default = "default_input_channel")]
    pub input_channel: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CaptureProvenanceSpan {
    pub start_sample: u64,
    pub end_sample: u64,
    pub device_name: String,
    pub device_id: String,
    pub input_sample_format: String,
    pub input_channels: u16,
    pub input_channel: u16,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSnapshot {
    pub schema_version: u32,
    #[serde(default)]
    pub journal_seq: u64,
    pub session_id: String,
    #[serde(default)]
    pub script_name: String,
    pub status: String,
    pub device_name: String,
    /// Stable backend endpoint identity. Display names are not unique when two
    /// identical USB interfaces are connected.
    #[serde(default)]
    pub device_id: String,
    /// Actual sample representation selected from the input driver. This is
    /// independent from the requested WAV delivery bit depth.
    #[serde(default)]
    pub input_sample_format: String,
    /// WASAPI share mode used to open the input stream. Exclusive bypasses the
    /// Windows mixer; other hosts keep their native path and ignore the flag.
    #[serde(default)]
    pub capture_share_mode: CaptureShareMode,
    /// Durable sample ranges attributed to each actual driver configuration.
    /// Older snapshots have no spans and retain their legacy top-level source
    /// fields; the first resume upgrades them without inventing sample data.
    #[serde(default)]
    pub capture_provenance: Vec<CaptureProvenanceSpan>,
    pub audio_format: AudioFormat,
    pub master_audio: String,
    /// Version of the on-disk master-audio layout. Version 1 is the numbered
    /// `audio/segments/master-NNNNNN.wav` layout.
    #[serde(default = "default_storage_layout_version")]
    pub storage_layout_version: u32,
    /// Exact rollover boundary used when the session was created. Older
    /// snapshots did not persist it; `None` therefore means the immutable v1
    /// compatibility default of five minutes at the recorded sample rate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub segment_frames: Option<u64>,
    pub captured_samples: u64,
    pub committed_samples: u64,
    pub overflow_samples: u64,
    /// Number of bounded WASAPI input gaps recovered without stopping capture.
    #[serde(default)]
    pub input_discontinuity_count: u64,
    /// Equilibrium frames inserted to preserve the master timeline across gaps.
    #[serde(default)]
    pub input_discontinuity_silence_samples: u64,
    pub started_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub noise_check: Option<NoiseCheckResult>,
    /// Ambient-room acceptance limit. This remains stable when the operator
    /// changes the task-wide silence threshold during capture.
    #[serde(default)]
    pub noise_threshold_dbfs: Option<f32>,
    #[serde(default = "default_silence_duration_ms")]
    pub silence_duration_ms: u32,
    #[serde(default = "default_noise_threshold_dbfs")]
    pub silence_threshold_dbfs: f32,
    /// Missing on pre-VAD snapshots; those keep the energy gate.
    #[serde(default = "default_silence_detector_legacy")]
    pub silence_detector: SilenceDetector,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vad_diagnostics: Option<VadDiagnostics>,
    pub items: Vec<ItemState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoiseCheckResult {
    pub passed: bool,
    pub threshold_dbfs: f32,
    pub average_dbfs: f32,
    pub maximum_dbfs: f32,
    pub failing_windows: usize,
    pub samples: Vec<f32>,
    pub completed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fail_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bandwidth_ratio_db: Option<f32>,
}

#[derive(Debug, Deserialize)]
pub struct StartSessionPayload {
    pub session_dir: String,
    pub session_id: String,
    #[serde(default)]
    pub script_name: String,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,
    #[serde(default = "default_bit_depth")]
    pub bit_depth: u16,
    /// Requested WASAPI capture sample format (`i16` / `i24` / `i32` / `f32`).
    /// Empty keeps the previous auto-pick from delivery bit depth.
    #[serde(default)]
    pub input_sample_format: String,
    #[serde(default = "default_input_channel")]
    pub input_channel: u16,
    #[serde(default)]
    pub capture_share_mode: CaptureShareMode,
    #[serde(default = "default_silence_duration_ms")]
    pub silence_duration_ms: u32,
    #[serde(default)]
    pub noise_threshold_dbfs: Option<f32>,
    #[serde(default = "default_noise_threshold_dbfs")]
    pub silence_threshold_dbfs: f32,
    #[serde(default = "default_silence_detector_new")]
    pub silence_detector: SilenceDetector,
    pub items: Vec<ScriptItem>,
}

#[cfg(feature = "system-test")]
#[derive(Debug, Deserialize)]
pub struct SystemTestStartSessionPayload {
    #[serde(flatten)]
    pub session: StartSessionPayload,
    pub segment_frames: u64,
}

#[cfg(feature = "system-test")]
#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SystemTestSignalPattern {
    Silence,
    #[default]
    Speech,
}

#[cfg(feature = "system-test")]
impl SystemTestSignalPattern {
    fn as_str(self) -> &'static str {
        match self {
            Self::Silence => "silence",
            Self::Speech => "speech",
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ResumeSessionPayload {
    pub session_dir: String,
    pub expected_session_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportArtifact {
    FullTrack,
    CutsZip,
    TimestampsJson,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExportScope {
    #[default]
    ConfirmedOnly,
    CompleteTask,
}

#[derive(Debug)]
struct ExportSessionOptions<'a> {
    expected_session_id: Option<&'a str>,
    available_bytes_override: Option<u64>,
    requested_artifact: Option<ExportArtifact>,
    export_scope: ExportScope,
    expected_journal_seq: Option<u64>,
    acknowledged_warning_codes: &'a [String],
}

#[derive(Debug, Deserialize)]
pub struct NoiseCheckPayload {
    #[serde(default = "default_noise_threshold_dbfs")]
    pub threshold_dbfs: f32,
}

#[derive(Debug, Deserialize)]
pub struct SetSilenceSettingsPayload {
    pub threshold_dbfs: f32,
    pub silence_duration_ms: u32,
    #[serde(default)]
    pub enforce_silence: Option<bool>,
    #[serde(default)]
    pub silence_detector: Option<SilenceDetector>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureShareMode {
    #[default]
    Exclusive,
    Shared,
}

impl CaptureShareMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Exclusive => "exclusive",
            Self::Shared => "shared",
        }
    }

    fn is_exclusive(self) -> bool {
        matches!(self, Self::Exclusive)
    }
}

impl From<CaptureShareMode> for ShareMode {
    fn from(mode: CaptureShareMode) -> Self {
        match mode {
            CaptureShareMode::Exclusive => Self::Exclusive,
            CaptureShareMode::Shared => Self::Shared,
        }
    }
}

fn effective_capture_share_mode(requested: CaptureShareMode) -> CaptureShareMode {
    if cfg!(target_os = "windows") {
        requested
    } else {
        CaptureShareMode::Shared
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct StopAttemptPayload {
    #[serde(default)]
    pub force: bool,
    #[serde(default = "default_true")]
    pub discard_empty: bool,
    #[serde(default)]
    pub enforce_silence: bool,
}

impl Default for StopAttemptPayload {
    fn default() -> Self {
        Self {
            force: false,
            discard_empty: true,
            enforce_silence: false,
        }
    }
}

fn default_sample_rate() -> u32 {
    48_000
}

fn default_bit_depth() -> u16 {
    24
}

fn default_storage_layout_version() -> u32 {
    STORAGE_LAYOUT_VERSION
}

fn storage_layout_v1_default_segment_frames(sample_rate: u32) -> Result<u64> {
    if sample_rate == 0 {
        bail!("录制任务的采样率无效");
    }
    u64::from(sample_rate)
        .checked_mul(STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS)
        .context("计算五分钟分段帧数溢出")
}

fn storage_layout_segment_frames(snapshot: &SessionSnapshot) -> Result<u64> {
    if snapshot.storage_layout_version != STORAGE_LAYOUT_VERSION {
        bail!(
            "录制任务使用了不支持的存储布局版本 {}",
            snapshot.storage_layout_version
        );
    }
    let sample_rate = u64::from(snapshot.audio_format.sample_rate);
    let compatibility_default =
        storage_layout_v1_default_segment_frames(snapshot.audio_format.sample_rate)?;
    let frames = snapshot.segment_frames.unwrap_or(compatibility_default);
    let minimum = sample_rate
        .checked_mul(STORAGE_LAYOUT_MIN_SEGMENT_SECONDS)
        .context("计算分段帧数下限溢出")?;
    let maximum = sample_rate
        .checked_mul(STORAGE_LAYOUT_MAX_SEGMENT_SECONDS)
        .context("计算分段帧数上限溢出")?;
    if frames == 0 || !(minimum..=maximum).contains(&frames) {
        bail!(
            "录制任务的 segment_frames 无效：{frames}（当前采样率下必须介于 {minimum} 与 {maximum} 之间）"
        );
    }
    validate_standard_wav_size(frames, 1, snapshot.audio_format.bit_depth)
        .context("录制任务的 segment_frames 不能用标准 WAV 安全存储")?;
    Ok(frames)
}

fn default_audio_encoding() -> String {
    "pcm".to_string()
}

fn default_input_channel() -> u16 {
    1
}

fn default_noise_threshold_dbfs() -> f32 {
    -42.0
}

fn default_silence_duration_ms() -> u32 {
    1_000
}

fn default_silence_detector_legacy() -> SilenceDetector {
    SilenceDetector::Energy
}

fn default_silence_detector_new() -> SilenceDetector {
    SilenceDetector::Vad
}

fn vad_issue_code_name(code: u32) -> &'static str {
    match code {
        VAD_ISSUE_QUEUE_OVERFLOW => "vad_queue_overflow",
        VAD_ISSUE_CLASSIFIER_FAILURE => "vad_classifier_failure",
        VAD_ISSUE_FLUSH_TIMEOUT => "vad_flush_timeout",
        VAD_ISSUE_WORKER_DISCONNECTED => "vad_worker_disconnected",
        _ => "vad_worker_disconnected",
    }
}

fn known_quality_issue_code(code: &str) -> bool {
    matches!(
        code,
        "input_discontinuity"
            | "vad_queue_overflow"
            | "vad_classifier_failure"
            | "vad_flush_timeout"
            | "vad_worker_disconnected"
    )
}

#[cfg(feature = "system-test")]
fn system_test_sample(
    pattern: SystemTestSignalPattern,
    seed: u64,
    index: u64,
    sample_rate: u32,
) -> f32 {
    match pattern {
        SystemTestSignalPattern::Silence => 0.0,
        SystemTestSignalPattern::Speech => {
            // A deterministic voiced signal with a slowly varying pitch and
            // syllabic envelope. White noise is not speech and the production
            // VAD correctly rejects it, which made the old E2E "speech"
            // pattern nondeterministic under worker scheduling. Keep this
            // system-test-only signal rich in harmonics so Earshot reliably
            // classifies it as voice after the normal 16 kHz downsampling path.
            let time = index as f64 / f64::from(sample_rate.max(1));
            let phase = (seed % 65_521) as f64 / 65_521.0;
            let fundamental = 125.0 + 18.0 * (std::f64::consts::TAU * 2.3 * time).sin();
            let envelope = 0.55 + 0.45 * (std::f64::consts::TAU * 3.7 * time).sin().abs();
            let mut sample = 0.0;
            for harmonic in 1..=12 {
                let harmonic = f64::from(harmonic);
                sample += (std::f64::consts::TAU
                    * (fundamental * harmonic * time + phase * harmonic))
                    .sin()
                    / harmonic;
            }
            (sample * envelope * 0.18).clamp(-1.0, 1.0) as f32
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SilenceDetector {
    #[default]
    Energy,
    Vad,
}

impl SilenceDetector {
    fn as_u32(self) -> u32 {
        match self {
            Self::Energy => DETECTOR_ENERGY,
            Self::Vad => DETECTOR_VAD,
        }
    }

    fn from_u32(value: u32) -> Self {
        if value == DETECTOR_VAD {
            Self::Vad
        } else {
            Self::Energy
        }
    }
}

#[derive(Debug, Clone)]
struct ActiveAttempt {
    item_id: String,
    attempt_id: String,
    start_sample: u64,
    recording_started_sample: u64,
    input_discontinuity_count_at_start: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct WaveformPacket {
    bins: Vec<[f32; 2]>,
    end_sample: u64,
}

#[derive(Debug)]
struct WaveformBinner {
    next_sample: u64,
    pending_samples: usize,
    minimum: f32,
    maximum: f32,
}

impl WaveformBinner {
    fn new(start_sample: u64) -> Self {
        Self {
            next_sample: start_sample,
            pending_samples: 0,
            minimum: 0.0,
            maximum: 0.0,
        }
    }

    fn reset(&mut self, start_sample: u64) {
        self.next_sample = start_sample;
        self.pending_samples = 0;
        self.minimum = 0.0;
        self.maximum = 0.0;
    }

    fn push_block(&mut self, block_start: u64, samples: &[f32]) -> Option<WaveformPacket> {
        // The preview is disposable and must never fault capture. If a caller
        // presents a discontinuous accepted range, restart only its visual
        // accumulator and expose the gap through the packet sample endpoint.
        if self.next_sample != block_start {
            self.reset(block_start);
        }
        let mut bins =
            Vec::with_capacity((self.pending_samples + samples.len()) / WAVEFORM_BIN_SAMPLES);
        let mut end_sample = 0;
        for sample in samples {
            let normalized = sample.clamp(-1.0, 1.0);
            self.minimum = self.minimum.min(normalized);
            self.maximum = self.maximum.max(normalized);
            self.pending_samples += 1;
            self.next_sample = self.next_sample.saturating_add(1);
            if self.pending_samples == WAVEFORM_BIN_SAMPLES {
                bins.push([self.minimum, self.maximum]);
                end_sample = self.next_sample;
                self.pending_samples = 0;
                self.minimum = 0.0;
                self.maximum = 0.0;
            }
        }
        (!bins.is_empty()).then_some(WaveformPacket { bins, end_sample })
    }
}

struct CaptureWaveformPreview {
    sender: Sender<WaveformPacket>,
    binner: WaveformBinner,
}

impl CaptureWaveformPreview {
    fn new(sender: Sender<WaveformPacket>, start_sample: u64) -> Self {
        Self {
            sender,
            binner: WaveformBinner::new(start_sample),
        }
    }

    fn prepare(&mut self, block_start: u64, samples: &[f32]) -> Option<WaveformPacket> {
        self.binner.push_block(block_start, samples)
    }

    fn publish(&self, packet: WaveformPacket) {
        // Preview congestion may drop visuals, but can never wait in the audio
        // callback or apply backpressure to the authoritative writer queue.
        let _ = self.sender.try_send(packet);
    }
}

fn append_waveform_packet(
    waveform: &mut Vec<[f32; 2]>,
    waveform_end_sample: &mut u64,
    packet: WaveformPacket,
    maximum_bins: usize,
) {
    let packet_samples = (packet.bins.len() as u64).saturating_mul(WAVEFORM_BIN_SAMPLES as u64);
    let packet_start_sample = packet.end_sample.saturating_sub(packet_samples);
    if *waveform_end_sample != 0 && packet_start_sample != *waveform_end_sample {
        // A full preview channel is allowed to drop packets. Never compress
        // that missing time into a continuous-looking waveform batch.
        waveform.clear();
    }
    waveform.extend(packet.bins);
    *waveform_end_sample = packet.end_sample;
    if waveform.len() > maximum_bins {
        let discard = waveform.len() - maximum_bins;
        waveform.drain(..discard);
    }
}

#[derive(Clone)]
struct SilenceAnalysisPorts {
    detector_kind: Arc<AtomicU32>,
    generation: Arc<AtomicU64>,
    tx: Option<Sender<VadAnalysisBlock>>,
    queue: VadQueueBudget,
    telemetry: VadTelemetry,
}

impl SilenceAnalysisPorts {
    #[cfg_attr(not(test), allow(dead_code))]
    fn energy() -> Self {
        Self {
            detector_kind: Arc::new(AtomicU32::new(DETECTOR_ENERGY)),
            generation: Arc::new(AtomicU64::new(0)),
            tx: None,
            queue: VadQueueBudget::new(default_sample_rate()),
            telemetry: VadTelemetry::default(),
        }
    }

    fn uses_vad(&self) -> bool {
        self.detector_kind.load(Ordering::Acquire) == DETECTOR_VAD && self.tx.is_some()
    }

    fn generation_is_degraded(&self, generation: u64) -> bool {
        self.telemetry.issue_for_generation(generation).is_some()
    }

    fn health_name(&self, sample_rate: u32) -> &'static str {
        match self.telemetry.health.load(Ordering::Acquire) {
            VAD_HEALTH_UNAVAILABLE => "unavailable",
            VAD_HEALTH_DEGRADED => "degraded",
            _ if self.queue.queued_samples()
                >= u64::from(sample_rate).saturating_mul(VAD_QUEUE_LAGGING_MILLIS) / 1_000 =>
            {
                "lagging"
            }
            VAD_HEALTH_HEALTHY => "healthy",
            _ => "healthy",
        }
    }

    fn diagnostics(&self) -> VadDiagnostics {
        VadDiagnostics {
            queue_capacity_samples: self.queue.max_samples(),
            queue_capacity_blocks: self.queue.max_blocks(),
            queue_high_water_samples: self.queue.high_water_samples(),
            overflow_count: self.telemetry.overflow_count.load(Ordering::Acquire),
            dropped_samples: self.telemetry.dropped_samples.load(Ordering::Acquire),
            classifier_failure_count: self
                .telemetry
                .classifier_failure_count
                .load(Ordering::Acquire),
            flush_timeout_count: self.telemetry.flush_timeout_count.load(Ordering::Acquire),
            worker_disconnect_count: self
                .telemetry
                .worker_disconnect_count
                .load(Ordering::Acquire),
        }
    }
}

#[derive(Clone)]
struct SilenceMonitor {
    silence_samples: Arc<AtomicU64>,
    digital_silence_samples: Arc<AtomicU64>,
    last_signal_sample: Arc<AtomicU64>,
    attempt_signal_start_sample: Arc<AtomicU64>,
    analyzed_samples: Arc<AtomicU64>,
    analysis_epoch: Arc<AtomicU64>,
    threshold_bits: Arc<AtomicU32>,
    capture_heartbeat: Arc<AtomicU64>,
    head_silence: HeadSilenceMonitor,
    bandwidth: crate::bandwidth::BandwidthProbe,
    analysis: SilenceAnalysisPorts,
}

#[derive(Clone)]
struct WriterQueueBudget {
    queued_frames: Arc<AtomicU64>,
    enqueue_state: Arc<AtomicU64>,
    max_frames: u64,
}

#[derive(Clone)]
struct CaptureFaultPersistence {
    session_dir: PathBuf,
    recovery: CaptureRecoveryTelemetry,
}

impl CaptureFaultPersistence {
    fn activate_reserved_marker(&self) -> bool {
        activate_audio_fault_reserve(&self.session_dir)
    }
}

struct WriterQueueLease<'a> {
    enqueue_state: &'a AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CaptureAnalysisSnapshot {
    boundary: u64,
    head_silence_phase: u32,
    head_silence_armed_sample: u64,
    head_silence_progress_samples: u64,
    head_silence_passed_sample: u64,
    content_started_sample: u64,
    last_signal_sample: u64,
}

#[derive(Debug)]
struct CaptureHeartbeatWatchdog {
    was_armed: bool,
    last_heartbeat: u64,
    last_progress_at: Instant,
    triggered: bool,
}

impl CaptureHeartbeatWatchdog {
    fn new(now: Instant) -> Self {
        Self {
            was_armed: false,
            last_heartbeat: 0,
            last_progress_at: now,
            triggered: false,
        }
    }

    fn observe(
        &mut self,
        now: Instant,
        armed: bool,
        heartbeat: u64,
        already_faulted: bool,
        timeout: Duration,
    ) -> bool {
        if !armed {
            self.was_armed = false;
            self.last_heartbeat = heartbeat;
            self.last_progress_at = now;
            return false;
        }
        if !self.was_armed {
            self.was_armed = true;
            self.last_heartbeat = heartbeat;
            self.last_progress_at = now;
            return false;
        }
        if heartbeat != self.last_heartbeat {
            self.last_heartbeat = heartbeat;
            self.last_progress_at = now;
            return false;
        }
        if already_faulted || self.triggered || now.duration_since(self.last_progress_at) < timeout
        {
            return false;
        }
        self.triggered = true;
        true
    }
}

fn input_stream_fault_code(error: &cpal::Error) -> u32 {
    match error.kind() {
        cpal::ErrorKind::DeviceNotAvailable => CAPTURE_FAULT_DEVICE_UNAVAILABLE,
        cpal::ErrorKind::Xrun => CAPTURE_FAULT_INPUT_DISCONTINUITY,
        _ => CAPTURE_FAULT_INPUT_STREAM_ERROR,
    }
}

fn recovered_xrun_missing_frames(error: &cpal::Error) -> Option<u64> {
    if error.kind() != cpal::ErrorKind::RecoveredXrun {
        return None;
    }
    error.message()?.split(';').find_map(|field| {
        field
            .trim()
            .strip_prefix("missing_frames=")?
            .parse::<u64>()
            .ok()
    })
}

fn latch_capture_fault_code(capture_fault_code: &AtomicU32, code: u32) {
    if code == CAPTURE_FAULT_NONE {
        return;
    }
    let _ = capture_fault_code.compare_exchange(
        CAPTURE_FAULT_NONE,
        code,
        Ordering::AcqRel,
        Ordering::Acquire,
    );
}

fn capture_fault_telemetry(code: u32) -> (&'static str, &'static str) {
    match code {
        CAPTURE_FAULT_DEVICE_UNAVAILABLE => (
            "device_unavailable",
            "所选音频输入设备已断开或不再可用。录音已停止，已落盘母轨已保留；请检查声卡供电、USB 连接和 Windows 驱动状态。",
        ),
        CAPTURE_FAULT_DEVICE_STALLED => (
            "device_stalled",
            "声卡连续 5 秒未输送音频数据，可能已断开或驱动停滞。录音已停止，已落盘母轨已保留。",
        ),
        CAPTURE_FAULT_INPUT_DISCONTINUITY => (
            "input_discontinuity",
            "驱动报告音频输入数据不连续。录音已停止以避免静默交付损坏音频；请检查声卡、USB 连接和系统负载。",
        ),
        CAPTURE_FAULT_INPUT_STREAM_ERROR => (
            "input_stream_error",
            "音频输入流发生故障。录音已停止，已落盘母轨已保留；请检查声卡、驱动和系统音频设置。",
        ),
        _ => ("", ""),
    }
}

fn trip_stalled_capture(
    session_dir: &Path,
    reason: &str,
    committed: &AtomicU64,
    faulted: &AtomicBool,
    queue: &WriterQueueBudget,
    writer: &Sender<WriterMessage>,
) -> bool {
    faulted.store(true, Ordering::Release);
    // Publish durable evidence before asking the writer to finalize. Even if
    // the process is terminated in the narrow shutdown window, recovery and
    // normal export remain fail-closed.
    if !persist_audio_fault_marker_fail_closed(
        session_dir,
        reason,
        committed.load(Ordering::Acquire),
        faulted,
    ) {
        eprintln!("capture watchdog could not publish durable audio fault evidence");
    }
    // Closing and draining the callback-entry gate before the fault sentinel
    // keeps every buffer that entered before detection ahead of it in FIFO
    // order. The production writer channel is unbounded, so capacity cannot
    // discard this terminal control message.
    queue.close_and_wait();
    writer
        .try_send(WriterMessage::FaultAndStop(reason.to_string()))
        .is_ok()
}

impl Drop for WriterQueueLease<'_> {
    fn drop(&mut self) {
        self.enqueue_state.fetch_sub(1, Ordering::Release);
    }
}

impl WriterQueueBudget {
    fn enter(&self) -> Option<WriterQueueLease<'_>> {
        self.enqueue_state
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |state| {
                if state & WRITER_QUEUE_CLOSED != 0 {
                    None
                } else {
                    state.checked_add(1)
                }
            })
            .ok()
            .map(|_| WriterQueueLease {
                enqueue_state: &self.enqueue_state,
            })
    }

    fn close(&self) {
        self.enqueue_state
            .fetch_or(WRITER_QUEUE_CLOSED, Ordering::AcqRel);
    }

    fn in_flight(&self) -> u64 {
        self.enqueue_state.load(Ordering::Acquire) & WRITER_QUEUE_IN_FLIGHT_MASK
    }

    fn close_and_wait_until(&self, deadline: Instant) -> bool {
        self.close();
        let mut spins = 0u32;
        while self.in_flight() != 0 {
            if Instant::now() >= deadline {
                return false;
            }
            if spins < 100 {
                std::hint::spin_loop();
                spins += 1;
            } else {
                thread::yield_now();
            }
        }
        true
    }

    fn close_and_wait(&self) {
        self.close();
        let mut spins = 0u32;
        while self.in_flight() != 0 {
            if spins < 100 {
                std::hint::spin_loop();
                spins += 1;
            } else {
                thread::yield_now();
            }
        }
    }

    fn reserve(&self, frames: u64) -> bool {
        self.queued_frames
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                queued
                    .checked_add(frames)
                    .filter(|next| *next <= self.max_frames)
            })
            .is_ok()
    }

    fn release(&self, frames: u64) {
        let _ = self
            .queued_frames
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                Some(queued.saturating_sub(frames))
            });
    }
}

fn wait_for_thread_until(handle: &JoinHandle<()>, deadline: Instant) -> bool {
    while !handle.is_finished() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return false;
        }
        thread::sleep(remaining.min(Duration::from_millis(10)));
    }
    true
}

#[derive(Debug, PartialEq, Eq)]
enum DropReaperProgress {
    Joined,
    Pending,
    Failed,
}

/// Owns a pre-created worker that is allowed to block while destroying one
/// potentially hostile backend resource. `retire` never drops the resource on
/// its caller: if the worker channel has failed, the resource is deliberately
/// leaked and the reaper is latched failed so the session remains locked.
struct DropReaper<T: Send + 'static> {
    sender: Option<Sender<T>>,
    join: Option<JoinHandle<()>>,
    failed: bool,
}

impl<T: Send + 'static> DropReaper<T> {
    fn spawn(thread_name: &str) -> std::io::Result<Self> {
        let (sender, receiver) = unbounded::<T>();
        let join = thread::Builder::new()
            .name(thread_name.to_string())
            .spawn(move || {
                for resource in receiver {
                    drop(resource);
                }
            })?;
        Ok(Self {
            sender: Some(sender),
            join: Some(join),
            failed: false,
        })
    }

    /// Transfers the resource to the worker and closes its single-use input.
    /// A disconnected worker returns ownership from `send`; forgetting that
    /// value is intentional because dropping it here would reintroduce the
    /// unbounded backend wait this type exists to contain.
    fn retire(&mut self, resource: T) -> bool {
        let Some(sender) = self.sender.take() else {
            self.failed = true;
            std::mem::forget(resource);
            return false;
        };
        match sender.send(resource) {
            Ok(()) => true,
            Err(error) => {
                self.failed = true;
                std::mem::forget(error.0);
                false
            }
        }
    }

    fn close_input(&mut self) {
        self.sender.take();
    }

    fn finish_until(&mut self, deadline: Instant) -> DropReaperProgress {
        // An activation that failed before constructing a stream still needs
        // to close the pre-created worker and join it within the same deadline.
        self.sender.take();
        let Some(join) = self.join.as_ref() else {
            return if self.failed {
                DropReaperProgress::Failed
            } else {
                DropReaperProgress::Joined
            };
        };
        if !wait_for_thread_until(join, deadline) {
            return DropReaperProgress::Pending;
        }
        let join = self
            .join
            .take()
            .expect("finished drop reaper handle disappeared");
        if join.join().is_err() {
            self.failed = true;
        }
        if self.failed {
            DropReaperProgress::Failed
        } else {
            DropReaperProgress::Joined
        }
    }
}

struct StreamShutdownResource {
    stream: Option<Stream>,
    warning: Sender<String>,
}

impl Drop for StreamShutdownResource {
    fn drop(&mut self) {
        let Some(stream) = self.stream.take() else {
            return;
        };
        if let Err(error) = stream.pause() {
            let _ = self
                .warning
                .send(format!("pause input stream while stopping: {error}"));
        }
        // CPAL may synchronously join a wedged backend worker here. This Drop
        // only ever runs on the pre-created reaper thread.
        drop(stream);
    }
}

struct StreamReaper {
    resources: DropReaper<StreamShutdownResource>,
    warning_tx: Sender<String>,
    warning_rx: Receiver<String>,
}

impl StreamReaper {
    fn spawn(thread_name: &str) -> std::io::Result<Self> {
        let (warning_tx, warning_rx) = unbounded();
        Ok(Self {
            resources: DropReaper::spawn(thread_name)?,
            warning_tx,
            warning_rx,
        })
    }

    fn retire(&mut self, stream: Stream) -> bool {
        self.resources.retire(StreamShutdownResource {
            stream: Some(stream),
            warning: self.warning_tx.clone(),
        })
    }

    fn close_input(&mut self) {
        self.resources.close_input();
    }

    fn finish_until(&mut self, deadline: Instant) -> DropReaperProgress {
        self.resources.finish_until(deadline)
    }

    fn drain_warnings(&self, warnings: &mut Vec<String>) {
        warnings.extend(self.warning_rx.try_iter());
    }
}

#[derive(Debug, PartialEq, Eq)]
struct CaptureBlockError {
    reason: String,
    dropped_frames: u64,
}

fn saturating_atomic_add(counter: &AtomicU64, value: u64) {
    let _ = counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
        Some(current.saturating_add(value))
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DigitalSilenceBlock {
    all_equilibrium: bool,
    trailing_samples: u64,
}

fn analyze_digital_silence_block(samples: &[f32]) -> DigitalSilenceBlock {
    let trailing_samples = samples
        .iter()
        .rev()
        .take_while(|sample| **sample == 0.0)
        .count();
    DigitalSilenceBlock {
        all_equilibrium: trailing_samples == samples.len(),
        trailing_samples: u64::try_from(trailing_samples).unwrap_or(u64::MAX),
    }
}

fn apply_digital_silence_block(previous: u64, block: DigitalSilenceBlock) -> u64 {
    if block.all_equilibrium {
        previous.saturating_add(block.trailing_samples)
    } else {
        // A non-zero sample clears the prior run immediately. If the same
        // callback ends with exact zero, retain only that new trailing run.
        block.trailing_samples
    }
}

fn digital_silence_suspected(samples: u64, sample_rate: u32) -> bool {
    sample_rate != 0
        && samples >= u64::from(sample_rate).saturating_mul(DIGITAL_SILENCE_WARNING_SECONDS)
}

fn reserve_counter_range(counter: &AtomicU64, amount: u64) -> Option<(u64, u64)> {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
            current.checked_add(amount)
        })
        .ok()
        .map(|start| {
            let end = start
                .checked_add(amount)
                .expect("checked atomic counter update returned an overflowing range");
            (start, end)
        })
}

#[derive(Debug)]
struct InterruptedAttemptStart {
    item_id: String,
    attempt_id: String,
    start_sample: u64,
    recording_started_sample: u64,
    head_silence_armed_sample: u64,
    required_head_silence_samples: u64,
    created_at: String,
    event_index: usize,
}

#[derive(Debug)]
struct JournalLog {
    entries: Vec<Value>,
    warnings: Vec<String>,
    truncate_to: Option<u64>,
}

#[derive(Debug, Clone)]
struct SnapshotCandidate {
    snapshot: SessionSnapshot,
    source: String,
    priority: u8,
    ordinal: usize,
}

#[derive(Debug)]
struct JournalAppendFailure {
    operation: String,
    rollback: Option<String>,
}

impl fmt::Display for JournalAppendFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.operation)?;
        if let Some(rollback) = &self.rollback {
            write!(formatter, "; journal rollback also failed: {rollback}")?;
        }
        Ok(())
    }
}

impl StdError for JournalAppendFailure {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)]
enum JournalAppendFault {
    None,
    DuringWrite,
    AfterWrite,
    AfterFlush,
    AfterSync,
    DuringWriteAndRollback,
}

enum WriterMessage {
    Samples(Vec<f32>),
    Checkpoint(Sender<Result<u64, String>>),
    ExportRange {
        destination: PathBuf,
        start_frame: u64,
        end_frame: u64,
        reply: Sender<Result<u64, String>>,
    },
    WaveformRange {
        start_frame: u64,
        end_frame: u64,
        reply: Sender<Result<Vec<[f32; 2]>, String>>,
    },
    FaultAndStop(String),
    Stop(Sender<Result<u64, String>>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MasterStorageKind {
    LegacySingleWav,
    SegmentedWav,
}

#[derive(Debug)]
struct SentenceExportPlan {
    item_index: usize,
    attempt_index: usize,
    file_name: String,
    file_bytes: u64,
}

impl MasterStorageKind {
    fn from_snapshot(snapshot: &SessionSnapshot) -> Result<Self> {
        match snapshot.master_audio.as_str() {
            LEGACY_MASTER_AUDIO => Ok(Self::LegacySingleWav),
            SEGMENTED_MASTER_AUDIO => Ok(Self::SegmentedWav),
            _ => bail!("录制任务引用了无效的母音频路径"),
        }
    }
}

enum AudioWriterBackend {
    Legacy(RecoverableWav),
    Segmented(SegmentedWav),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CaptureActivation {
    Device,
    #[cfg(not(windows))]
    DevWebFeed,
    #[cfg(feature = "system-test")]
    SystemTestSynthetic,
}

#[cfg_attr(windows, allow(dead_code))]
fn wants_dev_web_capture() -> bool {
    cfg!(not(windows))
        && std::env::var_os("DATABAKER_DEV_WEB_CAPTURE").is_some_and(|value| value == "1")
}

fn live_capture_activation() -> CaptureActivation {
    #[cfg(not(windows))]
    if wants_dev_web_capture() {
        return CaptureActivation::DevWebFeed;
    }
    CaptureActivation::Device
}

impl AudioWriterBackend {
    fn frames_written(&self) -> u64 {
        match self {
            Self::Legacy(writer) => writer.frames_written(),
            Self::Segmented(writer) => writer.global_frames(),
        }
    }

    fn write_samples(&mut self, samples: &[f32]) -> Result<()> {
        match self {
            Self::Legacy(writer) => writer.write_samples(samples),
            Self::Segmented(writer) => writer.write_samples(samples),
        }
    }

    fn checkpoint(&mut self) -> Result<u64> {
        match self {
            Self::Legacy(writer) => writer.checkpoint(),
            Self::Segmented(writer) => writer.checkpoint(),
        }
    }

    fn prepare_export_range_after_checkpoint(
        &mut self,
        source_path: &Path,
        destination: &Path,
        sample_rate: u32,
        bit_depth: u16,
        start_frame: u64,
        end_frame: u64,
    ) -> Result<PreparedWavExport> {
        match self {
            Self::Legacy(writer) => {
                if source_path == destination {
                    bail!("cannot export over the active master WAV");
                }
                let bytes = writer.read_encoded_frames(start_frame, end_frame)?;
                if bytes.len() as u64 > LEGACY_PREVIEW_MAX_SNAPSHOT_BYTES {
                    bail!("旧格式母轨试听快照超过 256 MiB，请先安全结束录制后再导出");
                }
                PreparedWavExport::from_encoded_frames(
                    destination,
                    sample_rate,
                    1,
                    bit_depth,
                    end_frame - start_frame,
                    bytes,
                )
            }
            Self::Segmented(writer) => {
                writer.prepare_export_range_after_checkpoint(destination, start_frame, end_frame)
            }
        }
    }

    fn finalize(self) -> Result<u64> {
        match self {
            Self::Legacy(writer) => writer.finalize(),
            Self::Segmented(writer) => writer.finalize(),
        }
    }
}

pub struct RecordingSession {
    _session_lock: Option<SessionLock>,
    session_dir: PathBuf,
    snapshot: SessionSnapshot,
    stream: Option<Stream>,
    stream_reaper: StreamReaper,
    writer_tx: Sender<WriterMessage>,
    writer_queue: WriterQueueBudget,
    writer_join: Option<JoinHandle<()>>,
    telemetry_join: Option<JoinHandle<()>>,
    capture_watchdog_join: Option<JoinHandle<()>>,
    telemetry_stop: Arc<AtomicBool>,
    capture_watchdog_armed: Arc<AtomicBool>,
    capture_heartbeat: Arc<AtomicU64>,
    captured: Arc<AtomicU64>,
    committed: Arc<AtomicU64>,
    overflow: Arc<AtomicU64>,
    capture_recovery: CaptureRecoveryTelemetry,
    faulted: Arc<AtomicBool>,
    peak: Arc<AtomicU32>,
    rms: Arc<AtomicU32>,
    silence_samples: Arc<AtomicU64>,
    digital_silence_samples: Arc<AtomicU64>,
    last_signal_sample: Arc<AtomicU64>,
    attempt_signal_start_sample: Arc<AtomicU64>,
    analyzed_samples: Arc<AtomicU64>,
    analysis_epoch: Arc<AtomicU64>,
    silence_threshold_bits: Arc<AtomicU32>,
    silence_duration_ms: Arc<AtomicU32>,
    head_silence: HeadSilenceMonitor,
    bandwidth: crate::bandwidth::BandwidthProbe,
    silence_analysis: SilenceAnalysisPorts,
    vad_tx: Option<Sender<VadControlMessage>>,
    vad_join: Option<JoinHandle<()>>,
    active_attempt: Option<ActiveAttempt>,
    metadata_fault: Option<String>,
    /// A stop command has already been placed behind every callback that
    /// entered the enqueue gate. Retries wait for the same writer instead of
    /// sending a second Stop message or detaching its JoinHandle.
    stop_requested: bool,
    capture_stopped: bool,
}

/// Performs the non-blocking part of an unexpected live-session teardown.
///
/// The normal stop path owns the bounded waits and durable writer finalization.
/// This helper exists for unwinding or an otherwise unexpected `Engine` drop,
/// where blocking in a hostile backend destructor would be worse than leaking
/// process-scoped resources. Close callback admission before transferring the
/// backend resource, and retain the directory lease before any fallible cleanup
/// so another recorder cannot open the same task while detached workers live.
fn fail_closed_abnormal_capture_drop<T, L>(
    capture_stopped: bool,
    callback_gate: &WriterQueueBudget,
    faulted: &AtomicBool,
    resource: &mut Option<T>,
    retire_resource: impl FnOnce(T) -> bool,
    session_lock: &mut Option<L>,
    retain_lock: impl FnOnce(L),
) -> bool {
    if capture_stopped {
        return false;
    }

    callback_gate.close();
    faulted.store(true, Ordering::Release);
    if let Some(lock) = session_lock.take() {
        retain_lock(lock);
    }

    let Some(resource) = resource.take() else {
        return false;
    };
    let _ = retire_resource(resource);
    true
}

impl Drop for RecordingSession {
    fn drop(&mut self) {
        if self.capture_stopped {
            return;
        }

        // Do not let detached supervisors manufacture a normal-looking status
        // after this owner has disappeared. JoinHandle drops below only detach;
        // neither store can block the caller or protocol thread.
        self.capture_watchdog_armed.store(false, Ordering::Release);
        self.telemetry_stop.store(true, Ordering::Release);
        self.vad_tx.take();
        self.vad_join.take();

        let stream_reaper = &mut self.stream_reaper;
        let retired_stream = fail_closed_abnormal_capture_drop(
            self.capture_stopped,
            &self.writer_queue,
            &self.faulted,
            &mut self.stream,
            |stream| stream_reaper.retire(stream),
            &mut self._session_lock,
            std::mem::forget,
        );
        if !retired_stream {
            // A pre-created reaper with no stream must still be allowed to exit.
            // Dropping its JoinHandle later detaches rather than joins it.
            self.stream_reaper.close_input();
        }
    }
}

#[derive(Debug)]
struct ActivationCleanupReport {
    warnings: Vec<String>,
    capture_resources_joined: bool,
    audio_safe: bool,
    captured_samples: u64,
    committed_samples: u64,
}

pub struct Engine {
    emitter: Emitter,
    pub session: Option<RecordingSession>,
}

impl Engine {
    pub fn new(emitter: Emitter) -> Self {
        Self {
            emitter,
            session: None,
        }
    }

    pub fn list_devices(&self) -> Result<Value> {
        let host = cpal::default_host();
        let default_device = host.default_input_device();
        let default_device_id = default_device
            .as_ref()
            .and_then(|device| device.id().ok())
            .map(|id| id.to_string());
        let mut default_name = None::<String>;
        let mut devices = Vec::new();
        for device in host.input_devices().context("enumerate input devices")? {
            let id = match device.id() {
                Ok(id) => id.to_string(),
                Err(error) => {
                    eprintln!("skip input device without stable id: {error}");
                    continue;
                }
            };
            let name = match input_device_name(&device) {
                Ok(name) => name,
                Err(error) => {
                    eprintln!("skip unavailable input device {id}: {error:#}");
                    continue;
                }
            };
            let exclusive = collect_input_format_catalog(&device, true);
            let shared = collect_input_format_catalog(&device, false);
            if let Some(error) = exclusive.probe_error.as_deref() {
                eprintln!("exclusive format probe failed for {name}: {error}");
            } else if !exclusive.available {
                eprintln!(
                    "exclusive format probe empty for {name}; shared_rates={:?} shared_channels={:?}",
                    shared.sample_rates, shared.input_channels
                );
            }
            if exclusive.configurations.is_empty() && shared.configurations.is_empty() {
                continue;
            }
            let mut rates = exclusive.sample_rates.clone();
            rates.extend(shared.sample_rates.iter().copied());
            rates.sort_unstable();
            rates.dedup();
            let mut input_channels = exclusive.input_channels.clone();
            input_channels.extend(shared.input_channels.iter().copied());
            input_channels.sort_unstable();
            input_channels.dedup();
            let exclusive_formats = catalog_sample_formats(&exclusive);
            let mut configurations = exclusive.configurations;
            configurations.extend(shared.configurations);
            let is_default = default_device_id.as_deref() == Some(id.as_str());
            if is_default {
                // Derive the display name from the same explicitly enumerated
                // endpoint as the ID. Querying the dynamic default handle a
                // second time could pair the old ID with a newly-routed name.
                default_name = Some(name.clone());
            }
            devices.push(json!({
                "id": id,
                "name": name,
                "is_default": is_default,
                "sample_rates": rates,
                "input_channels": input_channels,
                "configurations": configurations,
                "exclusive_available": exclusive.available,
                "exclusive_sample_rates": exclusive.sample_rates,
                "exclusive_input_channels": exclusive.input_channels,
                "exclusive_formats": exclusive_formats,
                "exclusive_probe_error": exclusive.probe_error,
                "shared_sample_rates": shared.sample_rates,
                "shared_input_channels": shared.input_channels,
            }));
        }
        Ok(json!({
            "devices": devices,
            "default_device_id": default_device_id,
            "default_device_name": default_name,
        }))
    }

    pub fn start_session(&mut self, payload: StartSessionPayload) -> Result<Value> {
        require_explicit_input_device_id(payload.device_id.as_deref(), "开始录制")?;
        let (session_dir, snapshot) = self.prepare_new_session(payload, None)?;
        self.activate_session(
            session_dir,
            snapshot,
            false,
            "session_started",
            None,
            None,
            live_capture_activation(),
        )
    }

    pub fn create_session(&self, payload: StartSessionPayload) -> Result<Value> {
        require_explicit_input_device_id(payload.device_id.as_deref(), "创建录制任务")?;
        let (session_dir, mut snapshot) = self.prepare_new_session(payload, None)?;
        snapshot.status = "stopped".to_string();
        atomic_snapshot_json(&session_dir.join("metadata/items.snapshot.json"), &snapshot)?;
        atomic_json(&session_dir.join("script/normalized.json"), &snapshot.items)?;
        atomic_json(
            &session_dir.join("session.json"),
            &session_summary_value(&snapshot),
        )?;
        Ok(json!({
            "snapshot": snapshot,
            "session_dir": session_dir,
            "mode": "inspect",
            "recovery_warnings": [],
            "faulted": false,
        }))
    }

    pub fn reset_session_expected(
        &self,
        session_dir: &Path,
        expected_session_id: &str,
    ) -> Result<Value> {
        if self.session.is_some() {
            bail!("当前已有录制进行中，请先安全暂停后再重置任务");
        }
        let expected_session_id = expected_session_id.trim();
        if expected_session_id.is_empty() {
            bail!("重置任务需要明确的录制任务身份");
        }
        validate_offline_session_tree(session_dir)?;
        let _session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
        let mut journal = read_journal(session_dir)?;
        let existing = load_recovery_snapshot_for_session(
            session_dir,
            &mut journal,
            Some(expected_session_id),
        )?;
        if existing.items.is_empty() {
            bail!("录制任务没有可保留的脚本条目，无法重置");
        }

        let now = Utc::now().to_rfc3339();
        let segment_frames = existing.segment_frames.map(Ok).unwrap_or_else(|| {
            storage_layout_v1_default_segment_frames(existing.audio_format.sample_rate)
        })?;
        let snapshot = SessionSnapshot {
            schema_version: 1,
            journal_seq: 0,
            session_id: existing.session_id,
            script_name: existing.script_name,
            status: "stopped".to_string(),
            device_name: existing.device_name,
            device_id: existing.device_id,
            input_sample_format: existing.input_sample_format,
            capture_share_mode: existing.capture_share_mode,
            capture_provenance: Vec::new(),
            audio_format: existing.audio_format,
            master_audio: SEGMENTED_MASTER_AUDIO.to_string(),
            storage_layout_version: STORAGE_LAYOUT_VERSION,
            segment_frames: Some(segment_frames),
            captured_samples: 0,
            committed_samples: 0,
            overflow_samples: 0,
            input_discontinuity_count: 0,
            input_discontinuity_silence_samples: 0,
            started_at: now.clone(),
            updated_at: now,
            noise_check: None,
            noise_threshold_dbfs: Some(
                existing
                    .noise_threshold_dbfs
                    .unwrap_or(existing.silence_threshold_dbfs),
            ),
            silence_duration_ms: existing.silence_duration_ms,
            silence_threshold_dbfs: existing.silence_threshold_dbfs,
            silence_detector: existing.silence_detector,
            vad_diagnostics: None,
            items: existing
                .items
                .into_iter()
                .map(|item| ItemState {
                    id: item.id,
                    text: item.text,
                    label: item.label,
                    status: "pending".to_string(),
                    attempts: Vec::new(),
                    selected_attempt_id: None,
                })
                .collect(),
        };
        storage_layout_segment_frames(&snapshot)?;

        wipe_recorded_session_data(session_dir)?;
        for name in ["audio", "metadata", "script", "preview", "export"] {
            ensure_real_directory(&session_dir.join(name))?;
        }
        // Drop older snapshot generations before publishing journal_seq=0.
        // Recovery prefers the highest sequence, so a leftover `.prev` would
        // resurrect the recorded task.
        remove_stale_snapshot_generations(session_dir)?;
        // Do not use atomic_snapshot_json here: it would rotate the recorded
        // snapshot to `.prev`, and recovery prefers the highest journal_seq.
        atomic_json(&session_dir.join("metadata/items.snapshot.json"), &snapshot)?;
        atomic_json(&session_dir.join("script/normalized.json"), &snapshot.items)?;
        atomic_json(
            &session_dir.join("session.json"),
            &session_summary_value(&snapshot),
        )?;
        remove_stale_snapshot_generations(session_dir)?;

        Ok(json!({
            "snapshot": snapshot,
            "session_dir": session_dir,
            "mode": "inspect",
            "recovery_warnings": [],
            "faulted": false,
        }))
    }

    #[cfg(feature = "system-test")]
    pub fn start_system_test_session(
        &mut self,
        payload: SystemTestStartSessionPayload,
    ) -> Result<Value> {
        if payload.segment_frames == 0 {
            bail!("system-test segment_frames must be greater than zero");
        }
        if !(8_000..=192_000).contains(&payload.session.sample_rate) {
            bail!("system-test sample_rate must be between 8000 and 192000 Hz");
        }
        if payload.session.input_channel != 1 {
            bail!("system-test synthetic capture exposes exactly one input channel");
        }
        let maximum_segment_frames = u64::from(payload.session.sample_rate)
            .checked_mul(30)
            .context("system-test segment frame limit overflow")?;
        if payload.segment_frames > maximum_segment_frames {
            bail!("system-test segment_frames cannot exceed 30 seconds of audio");
        }
        let (session_dir, snapshot) =
            self.prepare_new_session(payload.session, Some(payload.segment_frames))?;
        self.activate_session(
            session_dir,
            snapshot,
            false,
            "session_started",
            None,
            None,
            CaptureActivation::SystemTestSynthetic,
        )
    }

    fn prepare_new_session(
        &self,
        payload: StartSessionPayload,
        segment_frames_override: Option<u64>,
    ) -> Result<(PathBuf, SessionSnapshot)> {
        if self.session.is_some() {
            bail!("当前已有录制进行中");
        }
        if payload.items.is_empty() {
            bail!("script contains no items");
        }
        let requested_input_sample_format =
            parse_requested_input_sample_format(&payload.input_sample_format)?;
        let bit_depth = requested_input_sample_format
            .map(delivery_bit_depth_for_sample_format)
            .unwrap_or(payload.bit_depth);
        let output_encoding = WavEncoding::for_bit_depth(bit_depth)?;
        let input_sample_format = requested_input_sample_format
            .map(|format| format.to_string())
            .unwrap_or_default();
        let segment_frames = match segment_frames_override {
            Some(frames) => frames,
            None => storage_layout_v1_default_segment_frames(payload.sample_rate)?,
        };
        if payload.input_channel == 0 {
            bail!("input channel uses one-based numbering and must be at least 1");
        }
        if !(200..=5_000).contains(&payload.silence_duration_ms) {
            bail!("silence duration must be between 200 and 5000 ms");
        }
        if !payload.silence_threshold_dbfs.is_finite()
            || !(-96.0..=-6.0).contains(&payload.silence_threshold_dbfs)
        {
            bail!("silence threshold must be between -96 and -6 dBFS");
        }
        if let Some(threshold) = payload.noise_threshold_dbfs
            && (!threshold.is_finite() || !(-96.0..=-6.0).contains(&threshold))
        {
            bail!("noise threshold must be between -96 and -6 dBFS");
        }
        let session_dir = PathBuf::from(&payload.session_dir);
        if let Some(parent) = session_dir.parent()
            && !parent.as_os_str().is_empty()
        {
            durable_create_directory_all(parent)?;
        }
        durable_create_directory(&session_dir).with_context(|| {
            format!(
                "durably create a new recording directory {}; the path must not already exist",
                session_dir.display()
            )
        })?;
        for name in ["audio", "metadata", "script", "preview", "export"] {
            durable_create_directory(&session_dir.join(name))?;
        }

        let now = Utc::now().to_rfc3339();
        let snapshot = SessionSnapshot {
            schema_version: 1,
            journal_seq: 0,
            session_id: payload.session_id,
            script_name: payload.script_name,
            status: "recording".to_string(),
            device_name: payload.device_name.unwrap_or_default(),
            device_id: payload.device_id.unwrap_or_default(),
            input_sample_format,
            capture_share_mode: effective_capture_share_mode(payload.capture_share_mode),
            capture_provenance: Vec::new(),
            audio_format: AudioFormat {
                sample_rate: payload.sample_rate,
                bit_depth,
                encoding: output_encoding.name().to_string(),
                channels: 1,
                input_channels: 1,
                input_channel: payload.input_channel,
            },
            master_audio: SEGMENTED_MASTER_AUDIO.to_string(),
            storage_layout_version: STORAGE_LAYOUT_VERSION,
            segment_frames: Some(segment_frames),
            captured_samples: 0,
            committed_samples: 0,
            overflow_samples: 0,
            input_discontinuity_count: 0,
            input_discontinuity_silence_samples: 0,
            started_at: now.clone(),
            updated_at: now,
            noise_check: None,
            noise_threshold_dbfs: Some(
                payload
                    .noise_threshold_dbfs
                    .unwrap_or(payload.silence_threshold_dbfs),
            ),
            silence_duration_ms: payload.silence_duration_ms,
            silence_threshold_dbfs: payload.silence_threshold_dbfs,
            silence_detector: payload.silence_detector,
            vad_diagnostics: None,
            items: payload
                .items
                .into_iter()
                .map(|item| ItemState {
                    id: item.id,
                    text: item.text,
                    label: item.label,
                    status: "pending".to_string(),
                    attempts: Vec::new(),
                    selected_attempt_id: None,
                })
                .collect(),
        };
        storage_layout_segment_frames(&snapshot)?;
        Ok((session_dir, snapshot))
    }

    pub fn resume_session(&mut self, payload: ResumeSessionPayload) -> Result<Value> {
        self.resume_session_with_activation(payload, live_capture_activation())
    }

    #[cfg(feature = "system-test")]
    pub fn test_activate_session(&mut self, payload: ResumeSessionPayload) -> Result<Value> {
        self.resume_session_with_activation(payload, CaptureActivation::SystemTestSynthetic)
    }

    fn resume_session_with_activation(
        &mut self,
        payload: ResumeSessionPayload,
        capture_activation: CaptureActivation,
    ) -> Result<Value> {
        if self.session.is_some() {
            bail!("当前已有录制进行中");
        }
        let session_dir = PathBuf::from(payload.session_dir);
        let session_metadata = std::fs::symlink_metadata(&session_dir)
            .with_context(|| format!("inspect recording directory {}", session_dir.display()))?;
        if session_metadata.file_type().is_symlink() || !session_metadata.is_dir() {
            bail!("录制任务目录必须是普通目录");
        }
        for name in ["audio", "metadata", "script", "preview", "export"] {
            let directory = session_dir.join(name);
            let metadata = std::fs::symlink_metadata(&directory)
                .with_context(|| format!("inspect {}", directory.display()))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                bail!("录制任务包含无效的 {name} 目录");
            }
        }
        // No individual projection is authoritative enough to make the whole
        // recording undiscoverable. A power loss can leave the final snapshot,
        // its atomically-written temporary/previous generation, and the full
        // journal projection at different generations. Acquire the task lease
        // before reading any of them: otherwise a second recorder can read an
        // old projection, wait for the current owner to stop, then acquire the
        // lease and overwrite newer sentence metadata with stale journal
        // sequence numbers. Select the newest valid candidate only while this
        // lease remains held through activation.
        let expected_session_id = payload.expected_session_id.trim();
        if expected_session_id.is_empty() {
            bail!("继续录制需要明确的录制任务身份");
        }
        let (session_lock, journal, mut snapshot) =
            load_locked_recovery_snapshot(&session_dir, "继续录制", Some(expected_session_id))?;
        require_explicit_input_device_id(Some(snapshot.device_id.as_str()), "继续录制")?;
        if snapshot.status == "faulted" || snapshot.overflow_samples > 0 {
            bail!(
                "该任务已记录音频采集故障或写盘溢出，为避免污染时间轴，不允许继续向原母轨追加；请先保全原始分段并进行质量检查。"
            );
        }
        if snapshot.items.is_empty() {
            bail!("录制任务没有可恢复的脚本条目");
        }
        MasterStorageKind::from_snapshot(&snapshot)?;
        if snapshot.audio_format.channels != 1 || snapshot.audio_format.input_channel == 0 {
            bail!("录制任务的音频通道配置无效");
        }
        let output_encoding = WavEncoding::for_bit_depth(snapshot.audio_format.bit_depth)?;
        if snapshot.audio_format.encoding != output_encoding.name() {
            bail!("录制任务的位深与编码不一致");
        }
        if !(200..=5_000).contains(&snapshot.silence_duration_ms)
            || !snapshot.silence_threshold_dbfs.is_finite()
            || !(-96.0..=-6.0).contains(&snapshot.silence_threshold_dbfs)
        {
            bail!("录制任务的静音检测参数无效");
        }
        if snapshot.noise_threshold_dbfs.is_none() {
            snapshot.noise_threshold_dbfs = Some(
                snapshot
                    .noise_check
                    .as_ref()
                    .map(|check| check.threshold_dbfs)
                    .unwrap_or(snapshot.silence_threshold_dbfs),
            );
        }
        let previous_status = snapshot.status.clone();
        snapshot.status = "recording".to_string();
        // Resuming may happen on another day, room, or hardware connection.
        // Require a fresh ambient-noise check before allowing another take.
        snapshot.noise_check = None;
        snapshot.updated_at = Utc::now().to_rfc3339();
        let mut result = self.activate_session(
            session_dir,
            snapshot,
            true,
            "session_resumed",
            Some(session_lock),
            Some(journal),
            capture_activation,
        )?;
        if let Some(object) = result.as_object_mut() {
            object.insert("previous_status".to_string(), json!(previous_status));
        }
        Ok(result)
    }

    pub fn inspect_session_expected(
        &self,
        session_dir: &Path,
        expected_session_id: &str,
    ) -> Result<Value> {
        if self.session.is_some() {
            bail!("当前已有录制进行中，请先安全暂停后再打开其他任务");
        }
        let expected_session_id = expected_session_id.trim();
        if expected_session_id.is_empty() {
            bail!("打开任务需要明确的录制任务身份");
        }
        validate_offline_session_tree(session_dir)?;
        let _session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
        let mut journal = read_journal(session_dir)?;
        let snapshot = load_recovery_snapshot_for_session(
            session_dir,
            &mut journal,
            Some(expected_session_id),
        )?;
        Ok(json!({
            "snapshot": snapshot,
            "session_dir": session_dir,
            "mode": "inspect",
            "recovery_warnings": journal.warnings,
            "faulted": audio_fault_marker_present(session_dir)?,
            "data_health": if audio_fault_marker_present(session_dir)?
                || snapshot.status == "faulted"
                || snapshot.overflow_samples > 0
            {
                "readonly"
            } else if snapshot.status == "recording" || snapshot.status == "stopping" {
                "needs_repair"
            } else {
                "normal"
            },
        }))
    }

    pub fn render_session_attempt_expected(
        &self,
        session_dir: &Path,
        expected_session_id: &str,
        item_id: &str,
        attempt_id: &str,
    ) -> Result<Value> {
        if self.session.is_some() {
            bail!("当前已有录制进行中，请使用实时任务试听");
        }
        validate_offline_session_tree(session_dir)?;
        let _session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
        let mut journal = read_journal(session_dir)?;
        let snapshot = load_recovery_snapshot_for_session(
            session_dir,
            &mut journal,
            Some(expected_session_id.trim()),
        )?;
        let attempt = usable_preview_attempt(&snapshot, item_id, attempt_id)?.clone();
        let preview_dir = session_dir.join("preview");
        match std::fs::symlink_metadata(&preview_dir) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => bail!("录制任务试听目录无效"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                durable_create_directory(&preview_dir)?;
            }
            Err(error) => return Err(error.into()),
        }
        let destination = preview_dir.join(format!("{}.wav", bounded_wav_stem(attempt_id, "")?,));
        render_offline_range(
            session_dir,
            &snapshot,
            &destination,
            attempt.start_sample,
            attempt.end_sample,
        )?;
        Ok(json!({ "file_path": destination }))
    }

    pub fn preview_session_waveform_expected(
        &self,
        session_dir: &Path,
        expected_session_id: &str,
        item_id: &str,
        attempt_id: &str,
    ) -> Result<Value> {
        if self.session.is_some() {
            bail!("当前已有录制进行中，请使用实时任务波形");
        }
        validate_offline_session_tree(session_dir)?;
        let _session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
        let mut journal = read_journal(session_dir)?;
        let snapshot = load_recovery_snapshot_for_session(
            session_dir,
            &mut journal,
            Some(expected_session_id.trim()),
        )?;
        let attempt = usable_preview_attempt(&snapshot, item_id, attempt_id)?;
        let bins = waveform_offline_range(
            session_dir,
            &snapshot,
            attempt.start_sample,
            attempt.end_sample,
        )?;
        Ok(json!({
            "bins": bins,
            "start_sample": attempt.start_sample,
            "end_sample": attempt.end_sample,
            "sample_rate": snapshot.audio_format.sample_rate,
        }))
    }

    pub fn select_session_attempt_expected(
        &self,
        session_dir: &Path,
        expected_session_id: &str,
        item_id: &str,
        attempt_id: &str,
        expected_journal_seq: u64,
    ) -> Result<Value> {
        if self.session.is_some() {
            bail!("当前已有录制进行中，请先安全暂停再切换当前使用录音");
        }
        validate_offline_session_tree(session_dir)?;
        let _session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
        ensure_no_audio_fault_marker(session_dir, "切换当前使用录音")?;
        let mut journal = read_journal(session_dir)?;
        let mut snapshot = load_recovery_snapshot_for_session(
            session_dir,
            &mut journal,
            Some(expected_session_id.trim()),
        )?;
        if snapshot.status != "stopped" {
            bail!("任务尚未安全暂停，不能离线切换当前使用录音");
        }
        if snapshot.overflow_samples > 0 {
            bail!("任务存在音频写盘溢出，不能离线切换当前使用录音");
        }
        if snapshot.journal_seq != expected_journal_seq {
            bail!(
                "任务已在其他窗口变更：期望 journal_seq={expected_journal_seq}，当前={}；请刷新后重试",
                snapshot.journal_seq
            );
        }
        validate_snapshot_identifiers(&snapshot)?;
        validate_attempt_boundaries(&snapshot, snapshot.committed_samples)?;
        validate_capture_provenance(&snapshot, snapshot.committed_samples, true)?;
        let item_index = snapshot
            .items
            .iter()
            .position(|item| item.id == item_id)
            .ok_or_else(|| anyhow!("条目不存在"))?;
        let selected = snapshot.items[item_index]
            .attempts
            .iter()
            .find(|attempt| attempt.attempt_id == attempt_id)
            .ok_or_else(|| anyhow!("指定录音不存在"))?;
        if !attempt_is_delivery_safe(&snapshot, selected)? {
            bail!("异常中断或样本边界越界的录音不能设为当前使用录音");
        }
        waveform_offline_range(
            session_dir,
            &snapshot,
            selected.start_sample,
            selected.end_sample,
        )
        .context("指定录音的物理音频校验失败，不能设为当前使用录音")?;
        let item = &mut snapshot.items[item_index];
        for attempt in &mut item.attempts {
            if attempt.attempt_id == attempt_id {
                attempt.status = "accepted".to_string();
            } else if matches!(attempt.status.as_str(), "recorded" | "accepted") {
                attempt.status = "rejected_by_operator".to_string();
            }
        }
        item.selected_attempt_id = Some(attempt_id.to_string());
        item.status = "accepted".to_string();
        persist_offline_snapshot(
            session_dir,
            &mut snapshot,
            "attempt_selected_offline",
            json!({
                "item_id": item_id,
                "attempt_id": attempt_id,
                "expected_journal_seq": expected_journal_seq,
            }),
        )?;
        Ok(json!({
            "snapshot": snapshot,
            "session_dir": session_dir,
            "item_id": item_id,
            "attempt_id": attempt_id,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    fn activate_session(
        &mut self,
        session_dir: PathBuf,
        mut snapshot: SessionSnapshot,
        append: bool,
        event_name: &str,
        preacquired_session_lock: Option<SessionLock>,
        resume_journal: Option<JournalLog>,
        capture_activation: CaptureActivation,
    ) -> Result<Value> {
        let max_frames_per_segment = storage_layout_segment_frames(&snapshot)?;
        // Persist the resolved compatibility value on the next projection so
        // a pre-layout snapshot is upgraded without changing its boundaries.
        snapshot.segment_frames = Some(max_frames_per_segment);
        let session_lock = match preacquired_session_lock {
            Some(lock) => lock,
            None => SessionLock::acquire(&session_dir, &Utc::now().to_rfc3339())?,
        };
        if append {
            repair_journal_tail(
                &session_dir,
                resume_journal
                    .as_ref()
                    .context("resume journal was not loaded")?,
            )?;
        }
        let output_encoding = WavEncoding::for_bit_depth(snapshot.audio_format.bit_depth)?;
        snapshot.capture_share_mode = effective_capture_share_mode(snapshot.capture_share_mode);
        let previous_capture_source = capture_span_from_snapshot(&snapshot, 0, 0);
        let input_channel_index = usize::from(snapshot.audio_format.input_channel - 1);
        let (device_name, device_id, input_channels, sample_format, stream_setup) =
            match capture_activation {
                CaptureActivation::Device => {
                    let host = cpal::default_host();
                    let requested_device_id = require_explicit_input_device_id(
                        Some(snapshot.device_id.as_str()),
                        "启动采集流",
                    )?;
                    let device = select_device(&host, requested_device_id)?;
                    let device_id = device
                        .id()
                        .context("read stable input device id")?
                        .to_string();
                    let device_name = input_device_name(&device)?;
                    let requested_format =
                        parse_requested_input_sample_format(&snapshot.input_sample_format)?;
                    let candidates = select_config_candidates(
                        &device,
                        snapshot.audio_format.sample_rate,
                        input_channel_index,
                        snapshot.audio_format.bit_depth,
                        snapshot.capture_share_mode,
                        requested_format,
                    )?;
                    let supported = candidates
                        .first()
                        .expect("select_config_candidates returns at least one config");
                    let input_channels = supported.channels();
                    let sample_format = supported.sample_format();
                    (
                        device_name,
                        device_id,
                        input_channels,
                        sample_format,
                        Some((device, candidates)),
                    )
                }
                #[cfg(not(windows))]
                CaptureActivation::DevWebFeed => (
                    if snapshot.device_name.trim().is_empty() {
                        "Mac development web capture".to_string()
                    } else {
                        snapshot.device_name.clone()
                    },
                    snapshot.device_id.clone(),
                    snapshot
                        .audio_format
                        .input_channels
                        .max(snapshot.audio_format.input_channel),
                    SampleFormat::F32,
                    None,
                ),
                #[cfg(feature = "system-test")]
                CaptureActivation::SystemTestSynthetic => (
                    "DataBaker system-test synthetic input".to_string(),
                    "system-test:synthetic".to_string(),
                    1,
                    SampleFormat::F32,
                    None,
                ),
            };
        if usize::from(input_channels) <= input_channel_index {
            bail!(
                "input channel {} exceeds the active device channel count {input_channels}",
                input_channel_index + 1
            );
        };
        snapshot.device_name = device_name.clone();
        snapshot.device_id = device_id.clone();
        snapshot.input_sample_format = sample_format.to_string();
        snapshot.audio_format.encoding = output_encoding.name().to_string();
        snapshot.audio_format.input_channels = input_channels;

        let storage_kind = MasterStorageKind::from_snapshot(&snapshot)?;
        let master_path = session_dir.join(&snapshot.master_audio);
        let storage_report = check_storage(
            &session_dir,
            snapshot.audio_format.sample_rate,
            1,
            snapshot.audio_format.bit_depth,
        )?;
        if !storage_report.can_start {
            bail!(
                "录制磁盘空间不足：当前可用 {:.2} GiB，至少需要 {:.2} GiB 才能安全开始或恢复。",
                storage_report.available_bytes as f64 / 1_073_741_824.0,
                storage_report.startup_required_bytes as f64 / 1_073_741_824.0,
            );
        }
        // A storage failure cannot be expected to allocate its own diagnostic
        // file. Reserve durable fault evidence before the writer or input stream
        // can accept a single frame. Reuse a validated reserve across clean
        // stop/resume cycles; a published final/tmp marker was already rejected
        // by `load_locked_recovery_snapshot` on resume.
        ensure_audio_fault_reserve(&session_dir)?;
        let mut recovery_warnings = resume_journal
            .as_ref()
            .map(|journal| journal.warnings.clone())
            .unwrap_or_default();
        let expected_existing_frames = if append {
            let frames = match storage_kind {
                MasterStorageKind::LegacySingleWav => RecoverableWav::open_append(
                    &master_path,
                    snapshot.audio_format.sample_rate,
                    1,
                    snapshot.audio_format.bit_depth,
                )?
                .frames_written(),
                MasterStorageKind::SegmentedWav => {
                    let writer = if is_pristine_bootstrap(&snapshot) {
                        SegmentedWav::resume_or_create_empty(
                            &master_path,
                            snapshot.audio_format.sample_rate,
                            1,
                            snapshot.audio_format.bit_depth,
                            max_frames_per_segment,
                        )?
                    } else {
                        SegmentedWav::resume(
                            &master_path,
                            snapshot.audio_format.sample_rate,
                            1,
                            snapshot.audio_format.bit_depth,
                            max_frames_per_segment,
                        )?
                    };
                    recovery_warnings.extend(writer.recovery_warnings().iter().cloned());
                    writer.global_frames()
                }
            };
            if snapshot
                .items
                .iter()
                .flat_map(|item| item.attempts.iter())
                .any(|attempt| {
                    attempt.end_sample > frames
                        || (attempt.status == "interrupted"
                            && attempt.end_sample < attempt.start_sample)
                        || (attempt.status != "interrupted"
                            && attempt.end_sample <= attempt.start_sample)
                })
            {
                bail!("录制任务包含超出母音频范围的句子时间戳");
            }
            let journal = resume_journal
                .as_ref()
                .context("resume journal was not loaded")?;
            recovery_warnings.extend(recover_interrupted_attempts(
                journal,
                &mut snapshot,
                frames,
            )?);
            frames
        } else {
            0
        };
        begin_capture_provenance(
            &mut snapshot,
            previous_capture_source,
            expected_existing_frames,
        )?;

        // A recoverable projection must exist before writer/stream resources
        // are assembled. The authoritative activation event is committed
        // before `stream.play`; this sequence-zero bootstrap also keeps a new
        // task discoverable if setup dies before that first journal event.
        if !append {
            atomic_snapshot_json(&session_dir.join("metadata/items.snapshot.json"), &snapshot)?;
            atomic_json(&session_dir.join("script/normalized.json"), &snapshot.items)?;
            atomic_json(
                &session_dir.join("session.json"),
                &json!({
                    "schema_version": snapshot.schema_version,
                    "journal_seq": snapshot.journal_seq,
                    "session_id": snapshot.session_id,
                    "script_name": snapshot.script_name,
                    "status": snapshot.status,
                    "device_name": snapshot.device_name,
                    "device_id": snapshot.device_id,
                    "input_sample_format": snapshot.input_sample_format,
                    "capture_share_mode": snapshot.capture_share_mode,
                    "capture_provenance": snapshot.capture_provenance,
                    "audio_format": snapshot.audio_format,
                    "storage_layout_version": snapshot.storage_layout_version,
                    "segment_frames": snapshot.segment_frames,
                    "input_discontinuity_count": snapshot.input_discontinuity_count,
                    "input_discontinuity_silence_samples": snapshot.input_discontinuity_silence_samples,
                    "noise_threshold_dbfs": snapshot.noise_threshold_dbfs,
                    "silence_duration_ms": snapshot.silence_duration_ms,
                    "silence_threshold_dbfs": snapshot.silence_threshold_dbfs,
                    "silence_detector": snapshot.silence_detector,
                    "started_at": snapshot.started_at,
                    "updated_at": snapshot.updated_at,
                }),
            )?;
        }

        // Audio capacity is measured in frames, not callback messages: CPAL
        // buffer sizes vary substantially between devices and drivers.
        let writer_queue = WriterQueueBudget {
            queued_frames: Arc::new(AtomicU64::new(0)),
            enqueue_state: Arc::new(AtomicU64::new(0)),
            max_frames: u64::from(snapshot.audio_format.sample_rate)
                .checked_mul(WRITER_QUEUE_AUDIO_BUDGET_SECONDS)
                .context("writer queue frame budget overflow")?,
        };
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(expected_existing_frames));
        let committed = Arc::new(AtomicU64::new(expected_existing_frames));
        let overflow = Arc::new(AtomicU64::new(snapshot.overflow_samples));
        let faulted = Arc::new(AtomicBool::new(false));
        let capture_fault_code = Arc::new(AtomicU32::new(CAPTURE_FAULT_NONE));
        let capture_recovery = CaptureRecoveryTelemetry {
            discontinuities: Arc::new(AtomicU64::new(snapshot.input_discontinuity_count)),
            inserted_silence_frames: Arc::new(AtomicU64::new(
                snapshot.input_discontinuity_silence_samples,
            )),
        };
        let storage_status = Arc::new(AtomicU32::new(match storage_report.status {
            StorageStatus::Healthy => 0,
            StorageStatus::Warning => 1,
            StorageStatus::Critical => 2,
        }));
        let storage_safe_remaining_seconds =
            Arc::new(AtomicU64::new(storage_report.safe_recording_seconds));
        let peak_bits = Arc::new(AtomicU32::new(0f32.to_bits()));
        let rms_bits = Arc::new(AtomicU32::new(0f32.to_bits()));
        let silence_samples = Arc::new(AtomicU64::new(0));
        let digital_silence_samples = Arc::new(AtomicU64::new(0));
        let last_signal_sample = Arc::new(AtomicU64::new(0));
        let attempt_signal_start_sample = Arc::new(AtomicU64::new(0));
        // Existing audio was completely classified by its previous capture
        // process. New callbacks advance this watermark only after publishing
        // the signal/silence annotations for their accepted sample range.
        let analyzed_samples = Arc::new(AtomicU64::new(expected_existing_frames));
        let analysis_epoch = Arc::new(AtomicU64::new(0));
        let silence_threshold_bits =
            Arc::new(AtomicU32::new(snapshot.silence_threshold_dbfs.to_bits()));
        let silence_duration_ms = Arc::new(AtomicU32::new(snapshot.silence_duration_ms));
        let required_head_silence_samples = u64::from(snapshot.audio_format.sample_rate)
            .saturating_mul(u64::from(snapshot.silence_duration_ms))
            / 1_000;
        let head_silence = HeadSilenceMonitor::new(required_head_silence_samples);
        // VAD inference is deliberately isolated from the authoritative writer.
        // The callback never blocks: one second of PCM and 1,024 messages are
        // hard limits, while lifecycle controls use a separate priority lane.
        let (vad_data_tx, vad_data_rx) = bounded::<VadAnalysisBlock>(1_024);
        let (vad_tx, vad_control_rx) = bounded::<VadControlMessage>(8);
        let vad_queue = VadQueueBudget::new(snapshot.audio_format.sample_rate);
        let vad_telemetry = VadTelemetry::default();
        if let Some(previous) = snapshot.vad_diagnostics.as_ref() {
            vad_queue.restore_high_water_samples(previous.queue_high_water_samples);
            vad_telemetry
                .overflow_count
                .store(previous.overflow_count, Ordering::Release);
            vad_telemetry
                .dropped_samples
                .store(previous.dropped_samples, Ordering::Release);
            vad_telemetry
                .classifier_failure_count
                .store(previous.classifier_failure_count, Ordering::Release);
            vad_telemetry
                .flush_timeout_count
                .store(previous.flush_timeout_count, Ordering::Release);
            vad_telemetry
                .worker_disconnect_count
                .store(previous.worker_disconnect_count, Ordering::Release);
        }
        let silence_analysis = SilenceAnalysisPorts {
            detector_kind: Arc::new(AtomicU32::new(snapshot.silence_detector.as_u32())),
            generation: Arc::new(AtomicU64::new(1)),
            tx: Some(vad_data_tx),
            queue: vad_queue.clone(),
            telemetry: vad_telemetry.clone(),
        };
        let vad_sink = VadAnnotationSink {
            head_silence: head_silence.clone(),
            silence_samples: Arc::clone(&silence_samples),
            last_signal_sample: Arc::clone(&last_signal_sample),
            attempt_signal_start_sample: Arc::clone(&attempt_signal_start_sample),
            analyzed_samples: Arc::clone(&analyzed_samples),
            analysis_epoch: Arc::clone(&analysis_epoch),
            generation: Arc::clone(&silence_analysis.generation),
            telemetry: vad_telemetry,
        };
        let vad_sample_rate = snapshot.audio_format.sample_rate;
        let vad_join = thread::Builder::new()
            .name("speech-vad".to_string())
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                run_vad_analysis_thread(
                    vad_data_rx,
                    vad_control_rx,
                    vad_sample_rate,
                    vad_sink,
                    vad_queue,
                )
            })
            .context("start speech VAD analysis thread")?;
        let (waveform_tx, waveform_rx) = bounded::<WaveformPacket>(128);
        // Production preview leaves the callback only through this bounded,
        // non-blocking channel. The writer receives no visualization sink, so
        // WAV writes and checkpoints do not spend time recomputing preview bins.
        let telemetry_stop = Arc::new(AtomicBool::new(false));
        let capture_watchdog_armed = Arc::new(AtomicBool::new(false));
        let capture_heartbeat = Arc::new(AtomicU64::new(0));

        // Create the shutdown worker before the CPAL stream exists. A WASAPI
        // driver can wedge while `Stream::drop` joins its worker/COM teardown;
        // safe-stop must always have a pre-existing thread to contain that
        // wait instead of trying to spawn one on the failure path.
        let stream_reaper = StreamReaper::spawn("audio-stream-reaper")
            .context("create audio stream shutdown worker")?;

        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_path = master_path.clone();
        let writer_storage_dir = session_dir.clone();
        let sample_rate = snapshot.audio_format.sample_rate;
        let bit_depth = snapshot.audio_format.bit_depth;
        let (writer_ready_tx, writer_ready_rx) = bounded(1);
        let writer_faulted = Arc::clone(&faulted);
        let writer_storage_status = Arc::clone(&storage_status);
        let writer_storage_remaining = Arc::clone(&storage_safe_remaining_seconds);
        let writer_queue_thread = writer_queue.clone();
        let writer_join = thread::Builder::new()
            .name("audio-writer".to_string())
            .spawn(move || {
                writer_loop(
                    writer_rx,
                    &writer_path,
                    sample_rate,
                    bit_depth,
                    append,
                    storage_kind,
                    max_frames_per_segment,
                    &writer_storage_dir,
                    writer_captured,
                    writer_committed,
                    writer_overflow,
                    writer_faulted,
                    writer_storage_status,
                    writer_storage_remaining,
                    writer_queue_thread,
                    None,
                    writer_ready_tx,
                )
            })?;

        // Own the writer and task lock before waiting for its initialization
        // handshake. A slow or wedged WAV open must never make this command
        // release the lock while an unjoined writer still holds the audio.
        let bandwidth = crate::bandwidth::BandwidthProbe::new(snapshot.audio_format.sample_rate);
        let mut session = RecordingSession {
            _session_lock: Some(session_lock),
            session_dir,
            snapshot,
            stream: None,
            stream_reaper,
            writer_tx,
            writer_queue,
            writer_join: Some(writer_join),
            telemetry_join: None,
            capture_watchdog_join: None,
            telemetry_stop,
            capture_watchdog_armed,
            capture_heartbeat,
            captured,
            committed,
            overflow,
            capture_recovery: capture_recovery.clone(),
            faulted,
            peak: peak_bits,
            rms: rms_bits,
            silence_samples,
            digital_silence_samples,
            last_signal_sample,
            attempt_signal_start_sample,
            analyzed_samples,
            analysis_epoch,
            silence_threshold_bits,
            silence_duration_ms,
            head_silence,
            bandwidth,
            silence_analysis,
            vad_tx: Some(vad_tx),
            vad_join: Some(vad_join),
            active_attempt: None,
            metadata_fault: None,
            stop_requested: false,
            capture_stopped: false,
        };
        match writer_ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(frames)) if frames == expected_existing_frames => {}
            Ok(Ok(frames)) => {
                if !persist_audio_fault_marker_fail_closed(
                    &session.session_dir,
                    "master audio changed during the writer initialization handshake",
                    session.committed.load(Ordering::Acquire),
                    &session.faulted,
                ) {
                    eprintln!("writer initialization mismatch has no durable fault marker");
                }
                return Err(self.finish_activation_failure(
                    session,
                    "initialize_audio_writer",
                    anyhow!(
                        "母音频在恢复录制前发生了变化：期望 {expected_existing_frames} 帧，实际 {frames} 帧"
                    ),
                ));
            }
            Ok(Err(message)) => {
                return Err(self.finish_activation_failure(
                    session,
                    "initialize_audio_writer",
                    anyhow!(message),
                ));
            }
            Err(error) => {
                return Err(self.finish_activation_failure(
                    session,
                    "initialize_audio_writer",
                    anyhow!("audio writer initialization handshake failed: {error}"),
                ));
            }
        }

        if let Some((device, candidates)) = stream_setup {
            let exclusive_open = session.snapshot.capture_share_mode.is_exclusive();
            let share_mode = ShareMode::from(session.snapshot.capture_share_mode);
            let sample_rate = session.snapshot.audio_format.sample_rate;
            let mut last_error: Option<anyhow::Error> = None;
            let mut opened = None;
            for supported in candidates {
                let config = StreamConfig {
                    channels: supported.channels(),
                    sample_rate,
                    buffer_size: cpal::BufferSize::Default,
                    share_mode,
                };
                match build_stream(
                    &device,
                    &config,
                    supported.sample_format(),
                    input_channel_index,
                    session.writer_tx.clone(),
                    Arc::clone(&session.captured),
                    Arc::clone(&session.overflow),
                    Arc::clone(&session.faulted),
                    CaptureFaultPersistence {
                        session_dir: session.session_dir.clone(),
                        recovery: capture_recovery.clone(),
                    },
                    Arc::clone(&capture_fault_code),
                    Arc::clone(&session.peak),
                    Arc::clone(&session.rms),
                    session.writer_queue.clone(),
                    waveform_tx.clone(),
                    SilenceMonitor {
                        silence_samples: Arc::clone(&session.silence_samples),
                        digital_silence_samples: Arc::clone(&session.digital_silence_samples),
                        last_signal_sample: Arc::clone(&session.last_signal_sample),
                        attempt_signal_start_sample: Arc::clone(
                            &session.attempt_signal_start_sample,
                        ),
                        analyzed_samples: Arc::clone(&session.analyzed_samples),
                        analysis_epoch: Arc::clone(&session.analysis_epoch),
                        threshold_bits: Arc::clone(&session.silence_threshold_bits),
                        capture_heartbeat: Arc::clone(&session.capture_heartbeat),
                        head_silence: session.head_silence.clone(),
                        bandwidth: session.bandwidth.clone(),
                        analysis: session.silence_analysis.clone(),
                    },
                ) {
                    Ok(stream) => {
                        opened = Some((stream, supported.channels(), supported.sample_format()));
                        break;
                    }
                    Err(error) => {
                        eprintln!(
                            "input stream candidate failed: {} Hz {}ch {} ({error:#})",
                            sample_rate,
                            supported.channels(),
                            supported.sample_format()
                        );
                        last_error = Some(error);
                    }
                }
            }
            match opened {
                Some((stream, input_channels, sample_format)) => {
                    session.snapshot.audio_format.input_channels = input_channels;
                    session.snapshot.input_sample_format = sample_format.to_string();
                    session.stream = Some(stream);
                }
                None => {
                    return Err(self.finish_activation_failure(
                        session,
                        "build_input_stream",
                        last_error
                            .unwrap_or_else(|| anyhow!("no compatible input stream candidate"))
                            .context(if exclusive_open {
                                "独占开流失败。请确认声卡未被其他程序占用，并检查采样率/位深/通道；可改为「系统混音」，不会自动降级"
                            } else {
                                "build input stream"
                            }),
                    ));
                }
            }
        }

        // Keep the liveness gate independent from protocol telemetry. Stdout
        // can back up if Electron's event loop is temporarily blocked; a
        // production capture watchdog must still trip even when UI events
        // cannot be delivered.
        let watchdog_stop_thread = Arc::clone(&session.telemetry_stop);
        let capture_watchdog_armed_thread = Arc::clone(&session.capture_watchdog_armed);
        let capture_heartbeat_thread = Arc::clone(&session.capture_heartbeat);
        let watchdog_faulted = Arc::clone(&session.faulted);
        let watchdog_capture_fault_code = Arc::clone(&capture_fault_code);
        let watchdog_committed = Arc::clone(&session.committed);
        let watchdog_session_dir = session.session_dir.clone();
        let watchdog_writer = session.writer_tx.clone();
        let watchdog_queue = session.writer_queue.clone();
        let capture_watchdog_join = match thread::Builder::new()
            .name("capture-watchdog".to_string())
            .spawn(move || {
                let mut watchdog = CaptureHeartbeatWatchdog::new(Instant::now());
                while !watchdog_stop_thread.load(Ordering::Acquire) {
                    let already_faulted = watchdog_faulted.load(Ordering::Acquire);
                    let fault_evidence_confirmed = already_faulted
                        && audio_fault_marker_present(&watchdog_session_dir).unwrap_or(false);
                    if watchdog.observe(
                        Instant::now(),
                        capture_watchdog_armed_thread.load(Ordering::Acquire),
                        capture_heartbeat_thread.load(Ordering::Acquire),
                        fault_evidence_confirmed,
                        CAPTURE_CALLBACK_STALL_TIMEOUT,
                    ) {
                        latch_capture_fault_code(
                            &watchdog_capture_fault_code,
                            CAPTURE_FAULT_DEVICE_STALLED,
                        );
                        let reason = format!(
                            "audio input callback produced no non-empty buffers for {} seconds; the driver may have stalled or disconnected without reporting an error",
                            CAPTURE_CALLBACK_STALL_TIMEOUT.as_secs()
                        );
                        eprintln!("{reason}");
                        if !trip_stalled_capture(
                            &watchdog_session_dir,
                            &reason,
                            &watchdog_committed,
                            &watchdog_faulted,
                            &watchdog_queue,
                            &watchdog_writer,
                        ) {
                            eprintln!("audio writer was unavailable after capture watchdog fault");
                        }
                        break;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
            })
        {
            Ok(join) => join,
            Err(error) => {
                return Err(self.finish_activation_failure(
                    session,
                    "start_capture_watchdog",
                    anyhow!(error).context("start capture heartbeat watchdog"),
                ));
            }
        };
        session.capture_watchdog_join = Some(capture_watchdog_join);

        let emitter = self.emitter.clone();
        let telemetry_stop_thread = Arc::clone(&session.telemetry_stop);
        let captured_thread = Arc::clone(&session.captured);
        let committed_thread = Arc::clone(&session.committed);
        let overflow_thread = Arc::clone(&session.overflow);
        let faulted_thread = Arc::clone(&session.faulted);
        let capture_fault_code_thread = Arc::clone(&capture_fault_code);
        let capture_recovery_thread = capture_recovery.clone();
        let storage_status_thread = Arc::clone(&storage_status);
        let storage_remaining_thread = Arc::clone(&storage_safe_remaining_seconds);
        let peak_thread = Arc::clone(&session.peak);
        let rms_thread = Arc::clone(&session.rms);
        let silence_samples_thread = Arc::clone(&session.silence_samples);
        let digital_silence_samples_thread = Arc::clone(&session.digital_silence_samples);
        let last_signal_sample_thread = Arc::clone(&session.last_signal_sample);
        let content_started_sample_thread = Arc::clone(&session.attempt_signal_start_sample);
        let silence_threshold_thread = Arc::clone(&session.silence_threshold_bits);
        let head_silence_thread = session.head_silence.clone();
        let silence_duration_ms_thread = Arc::clone(&session.silence_duration_ms);
        let silence_detector_thread = Arc::clone(&session.silence_analysis.detector_kind);
        let vad_analysis_thread = session.silence_analysis.clone();
        let telemetry_session_dir = session.session_dir.clone();
        let capture_share_mode = session.snapshot.capture_share_mode.as_str();
        let telemetry_join = match thread::Builder::new()
            .name("telemetry".to_string())
            .spawn(move || {
                let mut fault_marker_observed = false;
                let mut last_fault_marker_attempt =
                    Instant::now().checked_sub(Duration::from_secs(1)).unwrap_or_else(Instant::now);
                while !telemetry_stop_thread.load(Ordering::Acquire) {
                    let storage_status = match storage_status_thread.load(Ordering::Acquire) {
                        0 => "healthy",
                        1 => "warning",
                        _ => "critical",
                    };
                    let mut waveform = Vec::<[f32; 2]>::new();
                    let mut waveform_end_sample = 0u64;
                    while let Ok(packet) = waveform_rx.try_recv() {
                        append_waveform_packet(
                            &mut waveform,
                            &mut waveform_end_sample,
                            packet,
                            2_048,
                        );
                    }
                    let capture_faulted = faulted_thread.load(Ordering::Acquire);
                    let capture_fault_code = capture_fault_code_thread.load(Ordering::Acquire);
                    let (fault_kind, fault_reason) =
                        capture_fault_telemetry(capture_fault_code);
                    let overflow_samples = overflow_thread.load(Ordering::Acquire);
                    let digital_silence_samples =
                        digital_silence_samples_thread.load(Ordering::Acquire);
                    if !fault_marker_observed
                        && (capture_faulted || overflow_samples > 0)
                        && last_fault_marker_attempt.elapsed() >= Duration::from_secs(1)
                    {
                        let marker = telemetry_session_dir.join(AUDIO_FAULT_MARKER);
                        let temporary_marker = marker.with_extension("tmp");
                        fault_marker_observed = marker.exists()
                            || temporary_marker.exists()
                            || persist_audio_fault_marker_fail_closed(
                                &telemetry_session_dir,
                                if overflow_samples > 0 {
                                    "capture callback could not enqueue audio into the writer"
                                } else {
                                    "capture fault observed by the telemetry supervisor"
                                },
                                committed_thread.load(Ordering::Acquire),
                                &faulted_thread,
                            );
                        last_fault_marker_attempt = Instant::now();
                    }
                    emitter.event(
                        "meter",
                        json!({
                            "captured_samples": captured_thread.load(Ordering::Acquire),
                            "committed_samples": committed_thread.load(Ordering::Acquire),
                            "overflow_samples": overflow_samples,
                            "faulted": capture_faulted,
                            "fault_kind": fault_kind,
                            "fault_reason": fault_reason,
                            "input_discontinuity_count": capture_recovery_thread.discontinuities.load(Ordering::Acquire),
                            "input_discontinuity_silence_samples": capture_recovery_thread.inserted_silence_frames.load(Ordering::Acquire),
                            "capture_share_mode": capture_share_mode,
                            "storage_status": storage_status,
                            "storage_safe_remaining_seconds": storage_remaining_thread.load(Ordering::Acquire),
                            "peak": f32::from_bits(peak_thread.load(Ordering::Relaxed)),
                            "rms": f32::from_bits(rms_thread.load(Ordering::Relaxed)),
                            "silence_samples": silence_samples_thread.load(Ordering::Acquire),
                            "digital_silence_samples": digital_silence_samples,
                            "digital_silence_suspected": digital_silence_suspected(
                                digital_silence_samples,
                                sample_rate,
                            ),
                            "last_signal_sample": last_signal_sample_thread.load(Ordering::Acquire),
                            "silence_threshold_dbfs": f32::from_bits(silence_threshold_thread.load(Ordering::Relaxed)),
                            "silence_duration_ms": silence_duration_ms_thread.load(Ordering::Acquire),
                            "silence_detector": SilenceDetector::from_u32(
                                silence_detector_thread.load(Ordering::Acquire)
                            ),
                            "vad_health": vad_analysis_thread.health_name(sample_rate),
                            "vad_backlog_samples": vad_analysis_thread.queue.queued_samples(),
                            "vad_backlog_blocks": vad_analysis_thread.queue.queued_blocks(),
                            "vad_capacity_samples": vad_analysis_thread.queue.max_samples(),
                            "vad_capacity_blocks": vad_analysis_thread.queue.max_blocks(),
                            "vad_high_water_samples": vad_analysis_thread.queue.high_water_samples(),
                            "vad_overflow_count": vad_analysis_thread.telemetry.overflow_count.load(Ordering::Acquire),
                            "vad_dropped_samples": vad_analysis_thread.telemetry.dropped_samples.load(Ordering::Acquire),
                            "vad_classifier_failure_count": vad_analysis_thread.telemetry.classifier_failure_count.load(Ordering::Acquire),
                            "vad_flush_timeout_count": vad_analysis_thread.telemetry.flush_timeout_count.load(Ordering::Acquire),
                            "vad_worker_disconnect_count": vad_analysis_thread.telemetry.worker_disconnect_count.load(Ordering::Acquire),
                            "head_silence_phase": head_silence_phase_name(
                                head_silence_thread.phase.load(Ordering::Acquire)
                            ),
                            "head_silence_armed_sample": head_silence_thread
                                .armed_sample.load(Ordering::Acquire),
                            "head_silence_progress_samples": head_silence_thread
                                .progress_samples.load(Ordering::Acquire)
                                .min(head_silence_thread.required_samples()),
                            "required_head_silence_samples": head_silence_thread.required_samples(),
                            "head_silence_passed_sample": head_silence_thread
                                .passed_sample.load(Ordering::Acquire),
                            "content_started_sample": content_started_sample_thread
                                .load(Ordering::Acquire),
                            "waveform": waveform,
                            "waveform_end_sample": waveform_end_sample,
                        }),
                    );
                    thread::sleep(Duration::from_millis(80));
                }
            })
        {
            Ok(join) => join,
            Err(error) => {
                return Err(self.finish_activation_failure(
                    session,
                    "start_telemetry",
                    anyhow!(error).context("start telemetry supervisor"),
                ));
            }
        };
        session.telemetry_join = Some(telemetry_join);
        if let Err(error) = session.persist(
            event_name,
            json!({
                "device_name": device_name,
                "device_id": device_id,
                "input_sample_format": sample_format.to_string(),
                "capture_share_mode": session.snapshot.capture_share_mode,
                "sample_rate": sample_rate,
                "bit_depth": bit_depth,
                "encoding": output_encoding.name(),
                "input_channel": session.snapshot.audio_format.input_channel,
                "storage_layout_version": session.snapshot.storage_layout_version,
                "segment_frames": session.snapshot.segment_frames,
                "silence_duration_ms": session.snapshot.silence_duration_ms,
                "silence_threshold_dbfs": session.snapshot.silence_threshold_dbfs,
                "silence_detector": session.snapshot.silence_detector,
                "existing_samples": expected_existing_frames,
                "capture_source": match capture_activation {
                    CaptureActivation::Device => "device",
                    #[cfg(not(windows))]
                    CaptureActivation::DevWebFeed => "dev_web_feed",
                    #[cfg(feature = "system-test")]
                    CaptureActivation::SystemTestSynthetic => "system_test",
                },
            }),
        ) {
            return Err(self.finish_activation_failure(
                session,
                "persist_activation_metadata",
                error.context("persist initial recording metadata"),
            ));
        }
        // The full-snapshot journal event above is the durable provenance
        // boundary for this activation. Only now may the driver emit samples;
        // otherwise a crash during resume could append new-device audio while
        // the disk still attributes the tail to the previous configuration.
        if let Some(stream) = session.stream.as_ref() {
            if let Err(error) = stream.play().context("start input stream") {
                return Err(self.finish_activation_failure(session, "play_input_stream", error));
            }
            // Arm only after `play` succeeds. Initial metadata fsync happens before
            // this point and may legitimately take longer than the stall timeout on
            // a stressed disk; it must not be confused with a live driver stall.
            session
                .capture_watchdog_armed
                .store(true, Ordering::Release);
        }
        let result = json!({
            "snapshot": session.snapshot,
            "session_dir": session.session_dir,
            "recovery_warnings": recovery_warnings,
            "storage": storage_report,
        });
        self.session = Some(session);
        Ok(result)
    }

    #[cfg(feature = "system-test")]
    fn active_system_test_session_mut(&mut self) -> Result<&mut RecordingSession> {
        let session = self.active_session_mut()?;
        if session.snapshot.device_id != "system-test:synthetic" || session.stream.is_some() {
            bail!("system-test PCM can only be injected into a synthetic test session");
        }
        Ok(session)
    }

    #[cfg(feature = "system-test")]
    pub fn system_test_feed(
        &mut self,
        frames: u64,
        seed: u64,
        block_frames: usize,
        pattern: SystemTestSignalPattern,
    ) -> Result<Value> {
        let session = self.active_system_test_session_mut()?;
        session.ensure_metadata_mutation_allowed()?;
        if frames == 0 {
            bail!("system-test feed frames must be greater than zero");
        }
        let sample_rate = u64::from(session.snapshot.audio_format.sample_rate);
        let maximum_command_frames = sample_rate
            .checked_mul(10)
            .context("system-test per-command frame limit overflow")?;
        let maximum_session_frames = sample_rate
            .checked_mul(30)
            .context("system-test session frame limit overflow")?;
        if frames > maximum_command_frames {
            bail!("system-test feed cannot inject more than 10 seconds per command");
        }
        if block_frames == 0 || block_frames > 8_192 {
            bail!("system-test block_frames must be between 1 and 8192");
        }
        let captured_before = session.captured.load(Ordering::Acquire);
        let captured_after = captured_before
            .checked_add(frames)
            .context("system-test capture timeline overflow")?;
        if captured_after > maximum_session_frames {
            bail!("system-test session cannot exceed 30 seconds of synthetic audio");
        }
        let silence = SilenceMonitor {
            silence_samples: Arc::clone(&session.silence_samples),
            digital_silence_samples: Arc::clone(&session.digital_silence_samples),
            last_signal_sample: Arc::clone(&session.last_signal_sample),
            attempt_signal_start_sample: Arc::clone(&session.attempt_signal_start_sample),
            analyzed_samples: Arc::clone(&session.analyzed_samples),
            analysis_epoch: Arc::clone(&session.analysis_epoch),
            threshold_bits: Arc::clone(&session.silence_threshold_bits),
            capture_heartbeat: Arc::clone(&session.capture_heartbeat),
            head_silence: session.head_silence.clone(),
            bandwidth: session.bandwidth.clone(),
            analysis: session.silence_analysis.clone(),
        };
        let mut emitted = 0u64;
        while emitted < frames {
            let chunk_frames = (frames - emitted).min(block_frames as u64) as usize;
            let global_start = captured_before + emitted;
            let mut samples = Vec::with_capacity(chunk_frames);
            for offset in 0..chunk_frames {
                let index = global_start + offset as u64;
                samples.push(system_test_sample(
                    pattern,
                    seed,
                    index,
                    session.snapshot.audio_format.sample_rate,
                ));
            }
            saturating_atomic_add(&session.capture_heartbeat, 1);
            publish_block(
                samples,
                &session.writer_tx,
                &session.captured,
                &session.overflow,
                &session.faulted,
                &session.peak,
                &session.rms,
                &session.writer_queue,
                &silence,
            );
            emitted += chunk_frames as u64;
            let actual = session.captured.load(Ordering::Acquire);
            let expected = captured_before + emitted;
            if actual != expected || session.faulted.load(Ordering::Acquire) {
                bail!(
                    "system-test synthetic callback was not accepted: expected captured {expected}, actual {actual}"
                );
            }
        }
        Ok(json!({
            "captured_samples": session.captured.load(Ordering::Acquire),
            "committed_samples": session.committed.load(Ordering::Acquire),
            "queued_frames": session.writer_queue.queued_frames.load(Ordering::Acquire),
            "pattern": pattern.as_str(),
            "silence_samples": session.silence_samples.load(Ordering::Acquire),
            "last_signal_sample": session.last_signal_sample.load(Ordering::Acquire),
            "analyzed_samples": session.analyzed_samples.load(Ordering::Acquire),
            "head_silence_phase": head_silence_phase_name(
                session.head_silence.phase.load(Ordering::Acquire)
            ),
        }))
    }

    #[cfg(not(windows))]
    pub fn dev_feed_pcm(&mut self, samples: Vec<f32>) -> Result<Value> {
        let session = self.active_session_mut()?;
        if session.stream.is_some() {
            bail!("dev_feed_pcm cannot inject into a live device capture session");
        }
        session.ensure_metadata_mutation_allowed()?;
        if samples.is_empty() {
            bail!("dev_feed_pcm samples must not be empty");
        }
        if samples.len() > 16_384 {
            bail!("dev_feed_pcm cannot inject more than 16384 samples per command");
        }
        let silence = SilenceMonitor {
            silence_samples: Arc::clone(&session.silence_samples),
            digital_silence_samples: Arc::clone(&session.digital_silence_samples),
            last_signal_sample: Arc::clone(&session.last_signal_sample),
            attempt_signal_start_sample: Arc::clone(&session.attempt_signal_start_sample),
            analyzed_samples: Arc::clone(&session.analyzed_samples),
            analysis_epoch: Arc::clone(&session.analysis_epoch),
            threshold_bits: Arc::clone(&session.silence_threshold_bits),
            capture_heartbeat: Arc::clone(&session.capture_heartbeat),
            head_silence: session.head_silence.clone(),
            bandwidth: session.bandwidth.clone(),
            analysis: session.silence_analysis.clone(),
        };
        saturating_atomic_add(&session.capture_heartbeat, 1);
        // Do not arm the production stall watchdog. Chromium may pause the
        // renderer callback while the operator grants TCC or switches Spaces.
        publish_block(
            samples,
            &session.writer_tx,
            &session.captured,
            &session.overflow,
            &session.faulted,
            &session.peak,
            &session.rms,
            &session.writer_queue,
            &silence,
        );
        if session.faulted.load(Ordering::Acquire) {
            bail!("dev_feed_pcm was not accepted because capture is already faulted");
        }
        Ok(json!({
            "captured_samples": session.captured.load(Ordering::Acquire),
            "queued_frames": session.writer_queue.queued_frames.load(Ordering::Acquire),
        }))
    }

    #[cfg(feature = "system-test")]
    pub fn system_test_checkpoint(&mut self) -> Result<Value> {
        let session = self.active_system_test_session_mut()?;
        session.ensure_metadata_mutation_allowed()?;
        let captured = session.captured.load(Ordering::Acquire);
        let committed = session.checkpoint()?;
        session.persist(
            "system_test_checkpoint",
            json!({
                "captured_samples": captured,
                "committed_samples": committed,
            }),
        )?;
        Ok(json!({
            "captured_samples": captured,
            "committed_samples": committed,
        }))
    }

    pub fn check_noise(&mut self, payload: NoiseCheckPayload) -> Result<Value> {
        const SAMPLE_COUNT: usize = 15;
        const SAMPLE_INTERVAL: Duration = Duration::from_millis(200);
        if !payload.threshold_dbfs.is_finite() || !(-96.0..=-6.0).contains(&payload.threshold_dbfs)
        {
            bail!("noise threshold must be between -96 and -6 dBFS");
        }
        let emitter = self.emitter.clone();
        let session = self.active_session_mut()?;
        session.ensure_metadata_mutation_allowed()?;
        if session.active_attempt.is_some() {
            bail!("cannot check ambient noise while an attempt is recording");
        }
        if session.faulted.load(Ordering::Acquire) {
            bail!("音频写盘异常，请结束并恢复当前录制");
        }
        session.snapshot.noise_threshold_dbfs = Some(payload.threshold_dbfs);
        let rms = Arc::clone(&session.rms);
        let peak = Arc::clone(&session.peak);
        let mut samples = Vec::with_capacity(SAMPLE_COUNT);
        emitter.event(
            "noise_check_started",
            json!({
                "sample_count": SAMPLE_COUNT,
                "sample_interval_ms": SAMPLE_INTERVAL.as_millis(),
                "threshold_dbfs": payload.threshold_dbfs,
            }),
        );
        for index in 0..SAMPLE_COUNT {
            thread::sleep(SAMPLE_INTERVAL);
            let rms_value = f32::from_bits(rms.load(Ordering::Relaxed));
            let peak_value = f32::from_bits(peak.load(Ordering::Relaxed));
            let rms_dbfs = linear_to_dbfs(rms_value);
            samples.push(rms_dbfs);
            emitter.event(
                "noise_check_progress",
                json!({
                    "sample_index": index + 1,
                    "sample_count": SAMPLE_COUNT,
                    "rms_dbfs": rms_dbfs,
                    "peak_dbfs": linear_to_dbfs(peak_value),
                    "threshold_dbfs": payload.threshold_dbfs,
                }),
            );
        }
        let (level_passed, failing_windows) = evaluate_noise(&samples, payload.threshold_dbfs);
        let average_dbfs = samples.iter().sum::<f32>() / samples.len() as f32;
        let maximum_dbfs = samples.iter().copied().fold(-96.0f32, f32::max);
        let bandwidth = session.bandwidth.evaluate();
        let (passed, fail_reason) = if !level_passed {
            (false, None)
        } else if bandwidth.conclusive && !bandwidth.passed {
            (false, Some("bandwidth".to_string()))
        } else {
            (true, None)
        };
        let result = NoiseCheckResult {
            passed,
            threshold_dbfs: payload.threshold_dbfs,
            average_dbfs,
            maximum_dbfs,
            failing_windows,
            samples,
            completed_at: Utc::now().to_rfc3339(),
            fail_reason,
            bandwidth_ratio_db: bandwidth.ratio_db,
        };
        session.snapshot.noise_check = Some(result.clone());
        session.persist("noise_check_completed", json!(&result))?;
        emitter.event("noise_check_completed", json!(&result));
        Ok(json!(result))
    }

    pub fn set_silence_settings(&mut self, payload: SetSilenceSettingsPayload) -> Result<Value> {
        if !payload.threshold_dbfs.is_finite() || !(-96.0..=-6.0).contains(&payload.threshold_dbfs)
        {
            bail!("silence threshold must be between -96 and -6 dBFS");
        }
        if !(200..=5_000).contains(&payload.silence_duration_ms) {
            bail!("silence duration must be between 200 and 5000 ms");
        }
        let session = self.active_session_mut()?;
        session.ensure_metadata_mutation_allowed()?;
        if session.faulted.load(Ordering::Acquire) {
            bail!("音频写盘异常，请结束并恢复当前录制");
        }

        if let Some(enforce_silence) = payload.enforce_silence {
            session.head_silence.set_enforce(enforce_silence);
        }
        if let Some(detector) = payload.silence_detector {
            if detector != session.snapshot.silence_detector {
                // Creating an offline task is the only detector-selection
                // phase. Once capture is activated, callbacks, generations,
                // diagnostics, and every attempt must keep one detector
                // contract for the lifetime of that activation. In
                // particular, a failed VAD worker must never be bypassed by a
                // raw IPC switch to Energy between sentences.
                bail!("录制任务启动后不能切换静音检测器；请安全退出后重新配置任务");
            }
            session.snapshot.silence_detector = detector;
            session
                .silence_analysis
                .detector_kind
                .store(detector.as_u32(), Ordering::Release);
        }
        let (analysis_boundary, reset_kind) =
            session.apply_silence_settings(payload.threshold_dbfs, payload.silence_duration_ms);
        session.snapshot.silence_threshold_dbfs = payload.threshold_dbfs;
        session.snapshot.silence_duration_ms = payload.silence_duration_ms;
        if session.active_attempt.is_none() {
            session.reset_vad_analysis()?;
        }
        session.persist(
            "silence_settings_changed",
            json!({
                "threshold_dbfs": payload.threshold_dbfs,
                "silence_duration_ms": payload.silence_duration_ms,
                "silence_detector": session.snapshot.silence_detector,
                "analysis_boundary": analysis_boundary,
                "active_attempt": session.active_attempt.is_some(),
                "reset_kind": reset_kind,
            }),
        )?;
        Ok(json!({
            "threshold_dbfs": payload.threshold_dbfs,
            "silence_duration_ms": payload.silence_duration_ms,
            "silence_detector": session.snapshot.silence_detector,
            "analysis_boundary": analysis_boundary,
            "active_attempt": session.active_attempt.is_some(),
            "reset_kind": reset_kind,
            "snapshot": session.live_snapshot(),
        }))
    }

    pub fn start_attempt(&mut self, item_id: &str, enforce_silence: bool) -> Result<Value> {
        let session = self.active_session_mut()?;
        session.ensure_metadata_mutation_allowed()?;
        if session.faulted.load(Ordering::Acquire) {
            bail!("音频写盘异常，请结束并恢复当前录制");
        }
        if session.active_attempt.is_some() {
            bail!("an attempt is already recording");
        }
        let item = session
            .snapshot
            .items
            .iter()
            .find(|item| item.id == item_id)
            .ok_or_else(|| anyhow!("unknown item id {item_id}"))?;
        let mut sequence = item.attempts.len() + 1;
        let attempt_id = loop {
            let candidate = bounded_wav_stem(item_id, &format!("-a{sequence}"))?;
            if !item
                .attempts
                .iter()
                .any(|attempt| attempt.attempt_id == candidate)
            {
                break candidate;
            }
            sequence += 1;
        };
        // Clicking start arms a pending window. Room tone from before the
        // click does not count. Non-enforced takes still count elapsed time;
        // enforced takes require consecutive silence after the click.
        session.head_silence.set_enforce(enforce_silence);
        let recording_started_sample = session.arm_attempt_analysis()?;
        let start_sample = recording_started_sample;
        session.active_attempt = Some(ActiveAttempt {
            item_id: item_id.to_string(),
            attempt_id: attempt_id.clone(),
            start_sample,
            recording_started_sample,
            input_discontinuity_count_at_start: session
                .capture_recovery
                .discontinuities
                .load(Ordering::Acquire),
        });
        session.persist(
            "attempt_started",
            json!({
                "item_id": item_id,
                "attempt_id": attempt_id,
                "start_sample": start_sample,
                "recording_started_sample": recording_started_sample,
                "head_silence_armed_sample": recording_started_sample,
                "required_head_silence_samples": session.head_silence.required_samples(),
                // Legacy field retained for journal readers. At arm time no
                // post-click silence has been accepted yet.
                "pre_silence_samples": 0,
            }),
        )?;
        let phase = session.head_silence.phase.load(Ordering::Acquire);
        Ok(json!({
            "attempt_id": attempt_id,
            "start_sample": start_sample,
            "recording_started_sample": recording_started_sample,
            "head_silence_armed_sample": recording_started_sample,
            "head_silence_phase": head_silence_phase_name(phase),
            "head_silence_progress_samples": session.head_silence
                .progress_samples.load(Ordering::Acquire)
                .min(session.head_silence.required_samples()),
            "required_head_silence_samples": session.head_silence.required_samples(),
            "head_silence_passed_sample": session.head_silence
                .passed_sample.load(Ordering::Acquire),
            "content_started_sample": session.attempt_signal_start_sample.load(Ordering::Acquire),
        }))
    }

    pub fn stop_attempt(
        &mut self,
        force: bool,
        discard_empty: bool,
        enforce_silence: bool,
    ) -> Result<Value> {
        let session = self.active_session_mut()?;
        session.ensure_metadata_mutation_allowed()?;
        let active = session
            .active_attempt
            .as_ref()
            .cloned()
            .ok_or_else(|| anyhow!("no attempt is recording"))?;
        if session.faulted.load(Ordering::Acquire) || session.overflow.load(Ordering::Acquire) > 0 {
            let durable_end = session
                .checkpoint()
                .unwrap_or_else(|_| session.committed.load(Ordering::Acquire));
            let attempt = session.interrupt_attempt(
                &active,
                durable_end,
                session.head_silence.passed_sample.load(Ordering::Acquire),
                session.head_silence.required_samples(),
                session.attempt_signal_start_sample.load(Ordering::Acquire),
                "audio_writer_fault",
            )?;
            return Ok(json!({
                "item_id": &active.item_id,
                "attempt": attempt,
                "interrupted": true,
            }));
        }
        // Freeze the operator's requested stop boundary first. A callback
        // reserves its sample range before it publishes signal annotations, so
        // reading the signal atomics immediately could otherwise discard a
        // block that the writer has already accepted. The seqlock snapshot may
        // advance to a callback that was already being analyzed, but its final
        // boundary and signal fields always come from the same even epoch.
        let requested_boundary = session.captured.load(Ordering::Acquire);
        let generation = session.silence_analysis.generation.load(Ordering::Acquire);
        let vad_outcome = session
            .silence_analysis
            .telemetry
            .issue_for_generation(generation)
            .map_or_else(
                || session.flush_vad_analysis(requested_boundary),
                |(code, _, _)| VadFlushOutcome::Degraded(code),
            );
        if vad_outcome != VadFlushOutcome::Complete {
            let issue_code = match vad_outcome {
                VadFlushOutcome::Degraded(code) => code,
                VadFlushOutcome::Timeout => VAD_ISSUE_FLUSH_TIMEOUT,
                VadFlushOutcome::Complete => unreachable!(),
            };
            let attempt = session.finish_vad_degraded_attempt(
                &active,
                requested_boundary,
                generation,
                issue_code,
            )?;
            return Ok(json!({
                "item_id": active.item_id,
                "attempt": attempt,
                "forced": false,
                "auto_selected": false,
                "vad_degraded": true,
            }));
        }
        let analysis = session.wait_for_analysis_snapshot(requested_boundary)?;
        let captured_boundary = analysis.boundary;
        let observed_content_started_sample = analysis.content_started_sample;
        let content_started_sample = if observed_content_started_sample == 0
            || observed_content_started_sample > captured_boundary
        {
            0
        } else {
            observed_content_started_sample
        };
        if content_started_sample == 0 && discard_empty {
            session.persist(
                "attempt_discarded",
                json!({
                    "item_id": &active.item_id,
                    "attempt_id": &active.attempt_id,
                    "reason": if analysis.head_silence_passed_sample == 0 {
                        "manual_stop_before_pending"
                    } else {
                        "manual_stop_without_signal"
                    },
                    "head_silence_armed_sample": analysis.head_silence_armed_sample,
                    "head_silence_passed_sample": analysis.head_silence_passed_sample,
                    "head_silence_progress_samples": analysis.head_silence_progress_samples,
                    "required_head_silence_samples": session.head_silence.required_samples(),
                }),
            )?;
            // Retain the active attempt if the authoritative journal append
            // fails so fault sealing can still preserve its sample range.
            session.active_attempt = None;
            session.disarm_attempt_analysis();
            return Ok(json!({
                "item_id": active.item_id,
                "attempt": null,
                "discarded": true,
                "forced": true,
            }));
        }
        let head_silence_passed_sample = analysis.head_silence_passed_sample;
        let required_silence_samples = session.required_silence_samples();
        let last_signal_sample = analysis.last_signal_sample.max(content_started_sample);
        let tail_silence_samples =
            captured_boundary.saturating_sub(last_signal_sample.min(captured_boundary));
        let forced_without_tail_silence = tail_silence_samples < required_silence_samples;
        if !force && content_started_sample > 0 && forced_without_tail_silence {
            bail!("尾静音未满，不能结束本句");
        }
        let committed_end = match session.wait_until_committed(captured_boundary) {
            Ok(_) => captured_boundary,
            Err(error) if session.faulted.load(Ordering::Acquire) => {
                // The writer can fail after the analysis snapshot but before
                // its final checkpoint. Never turn the durable prefix into a
                // successful take: it may end before the calculated bundle or
                // even before speech. Preserve only an interrupted version at
                // the proven committed boundary.
                let durable_end = session
                    .committed
                    .load(Ordering::Acquire)
                    .min(captured_boundary);
                let attempt = session.interrupt_attempt(
                    &active,
                    durable_end,
                    analysis.head_silence_passed_sample,
                    session.head_silence.required_samples(),
                    analysis.content_started_sample,
                    &format!("audio_writer_fault_while_finishing: {error:#}"),
                )?;
                return Ok(json!({
                    "item_id": &active.item_id,
                    "attempt": attempt,
                    "interrupted": true,
                }));
            }
            Err(error) => return Err(error),
        };
        let use_vad_trim =
            session.snapshot.silence_detector == SilenceDetector::Vad && content_started_sample > 0;
        let (start_sample, end_sample, recorded_tail_silence_samples) = if use_vad_trim {
            let (start, end) = trimmed_speech_bounds(
                active.recording_started_sample,
                committed_end,
                content_started_sample,
                last_signal_sample,
                required_silence_samples,
            );
            let tail = end.saturating_sub(last_signal_sample.min(end));
            (start, end, tail)
        } else {
            let start = if enforce_silence && head_silence_passed_sample > 0 {
                head_silence_passed_sample
            } else {
                active.recording_started_sample
            };
            (start, committed_end, tail_silence_samples)
        };
        if end_sample <= start_sample {
            if session.faulted.load(Ordering::Acquire) {
                session.active_attempt = None;
                session.persist(
                    "attempt_discarded",
                    json!({
                        "item_id": active.item_id,
                        "attempt_id": active.attempt_id,
                        "reason": "no_committed_audio_after_writer_fault"
                    }),
                )?;
                return Ok(json!({
                    "item_id": active.item_id,
                    "attempt": null,
                    "discarded": true,
                }));
            }
            bail!("attempt contains no audio samples");
        }
        let recovered_discontinuity = session
            .capture_recovery
            .discontinuities
            .load(Ordering::Acquire)
            > active.input_discontinuity_count_at_start;
        let quality_issues = if recovered_discontinuity {
            vec![AttemptQualityIssue {
                code: "input_discontinuity".to_string(),
                start_sample: None,
                end_sample: None,
                detector_generation: Some(generation),
            }]
        } else {
            Vec::new()
        };
        let attempt = Attempt {
            attempt_id: active.attempt_id.clone(),
            // Energy gating starts the clip where the required head pad
            // completed. AI VAD trims extra silence so each take keeps about
            // `silence_duration_ms` on both sides of detected speech.
            start_sample,
            recording_started_sample: active.recording_started_sample,
            head_silence_armed_sample: analysis.head_silence_armed_sample,
            head_silence_passed_sample,
            required_head_silence_samples: required_silence_samples,
            content_started_sample,
            end_sample,
            forced_without_tail_silence,
            tail_silence_samples: recorded_tail_silence_samples,
            required_tail_silence_samples: required_silence_samples,
            status: if recovered_discontinuity {
                "needs_rerecord".to_string()
            } else {
                "recorded".to_string()
            },
            created_at: Utc::now().to_rfc3339(),
            quality_issues,
        };
        let item = session
            .snapshot
            .items
            .iter_mut()
            .find(|item| item.id == active.item_id)
            .ok_or_else(|| anyhow!("item disappeared while recording"))?;
        let has_accepted_selection =
            item.selected_attempt_id
                .as_deref()
                .is_some_and(|selected_id| {
                    item.attempts.iter().any(|previous| {
                        previous.attempt_id == selected_id
                            && previous.status == "accepted"
                            && previous.end_sample > previous.start_sample
                    })
                });
        // A clean retake is always an explicit review candidate. Keep the
        // previously accepted version selected until the operator adopts the
        // new candidate or explicitly keeps the old one. A recovered input gap
        // makes this take non-deliverable; when a known-good selection exists,
        // preserve it and keep the item accepted while retaining the bad take
        // as durable warning evidence.
        if recovered_discontinuity && has_accepted_selection {
            item.status = "accepted".to_string();
        } else {
            item.status = "review".to_string();
        }
        if !has_accepted_selection {
            item.selected_attempt_id = None;
        }
        item.attempts.push(attempt.clone());
        session.active_attempt = None;
        session.persist(
            "attempt_stopped",
            json!({
                "item_id": active.item_id,
                "attempt": attempt,
                "forced": forced_without_tail_silence,
                "auto_selected": false,
                "tail_silence_samples": tail_silence_samples,
                "required_tail_silence_samples": required_silence_samples,
            }),
        )?;
        session.disarm_attempt_analysis();
        Ok(json!({
            "item_id": active.item_id,
            "attempt": attempt,
            "forced": forced_without_tail_silence,
            "auto_selected": false,
            "recovered_discontinuity": recovered_discontinuity,
        }))
    }

    pub fn accept_attempt(&mut self, item_id: &str, attempt_id: &str) -> Result<Value> {
        let session = self.active_session_mut()?;
        session.ensure_delivery_mutation_allowed()?;
        if session.active_attempt.is_some() {
            bail!("cannot accept an attempt while another attempt is recording");
        }
        validate_snapshot_identifiers(&session.snapshot)?;
        let item_index = session
            .snapshot
            .items
            .iter()
            .position(|item| item.id == item_id)
            .ok_or_else(|| anyhow!("unknown item id {item_id}"))?;
        let selected = session.snapshot.items[item_index]
            .attempts
            .iter()
            .find(|attempt| attempt.attempt_id == attempt_id)
            .cloned()
            .ok_or_else(|| anyhow!("unknown attempt id {attempt_id}"))?;
        let live_snapshot = session.live_snapshot();
        if !attempt_is_delivery_safe(&live_snapshot, &selected)? {
            bail!("异常中断的录音不能被确认或交付");
        }
        let is_current_accepted = selected.status == "accepted"
            && session.snapshot.items[item_index]
                .selected_attempt_id
                .as_deref()
                == Some(attempt_id);
        if selected.status != "recorded" && !is_current_accepted {
            bail!("只能使用待确认录音或保留当前使用录音");
        }
        let item = &mut session.snapshot.items[item_index];
        for attempt in &mut item.attempts {
            if attempt.attempt_id == attempt_id {
                attempt.status = "accepted".to_string();
            } else if matches!(attempt.status.as_str(), "recorded" | "accepted") {
                attempt.status = "rejected_by_operator".to_string();
            }
        }
        item.selected_attempt_id = Some(attempt_id.to_string());
        item.status = "accepted".to_string();
        session.persist(
            "attempt_accepted",
            json!({ "item_id": item_id, "attempt_id": attempt_id }),
        )?;
        Ok(json!({ "item_id": item_id, "attempt_id": attempt_id }))
    }

    pub fn skip_item(&mut self, item_id: &str) -> Result<Value> {
        let session = self.active_session_mut()?;
        session.ensure_delivery_mutation_allowed()?;
        if session.active_attempt.is_some() {
            bail!("cannot skip while an attempt is recording");
        }
        let item = session
            .snapshot
            .items
            .iter_mut()
            .find(|item| item.id == item_id)
            .ok_or_else(|| anyhow!("unknown item id {item_id}"))?;
        item.status = "skipped".to_string();
        item.selected_attempt_id = None;
        session.persist("item_skipped", json!({ "item_id": item_id }))?;
        Ok(json!({ "item_id": item_id }))
    }

    pub fn render_attempt(&mut self, item_id: &str, attempt_id: &str) -> Result<Value> {
        let session = self.active_session_mut()?;
        validate_snapshot_identifiers(&session.snapshot)?;
        let attempt = session
            .snapshot
            .items
            .iter()
            .find(|item| item.id == item_id)
            .and_then(|item| item.attempts.iter().find(|a| a.attempt_id == attempt_id))
            .cloned()
            .ok_or_else(|| anyhow!("attempt not found"))?;
        if !attempt_is_delivery_safe(&session.live_snapshot(), &attempt)? {
            bail!("异常中断的录音不能试听或交付");
        }
        let destination = session
            .session_dir
            .join("preview")
            .join(format!("{}.wav", bounded_wav_stem(attempt_id, "")?));
        session.render_range(&destination, attempt.start_sample, attempt.end_sample)?;
        Ok(json!({ "file_path": destination }))
    }

    pub fn preview_attempt_waveform(&mut self, item_id: &str, attempt_id: &str) -> Result<Value> {
        let session = self.active_session_mut()?;
        validate_snapshot_identifiers(&session.snapshot)?;
        let attempt = session
            .snapshot
            .items
            .iter()
            .find(|item| item.id == item_id)
            .and_then(|item| item.attempts.iter().find(|a| a.attempt_id == attempt_id))
            .cloned()
            .ok_or_else(|| anyhow!("attempt not found"))?;
        if !attempt_is_delivery_safe(&session.live_snapshot(), &attempt)? {
            bail!("异常中断的录音不能试听或交付");
        }
        session.wait_until_committed(attempt.end_sample)?;
        let bins = session.waveform_range(attempt.start_sample, attempt.end_sample)?;
        Ok(json!({
            "bins": bins,
            "start_sample": attempt.start_sample,
            "end_sample": attempt.end_sample,
            "sample_rate": session.snapshot.audio_format.sample_rate,
        }))
    }

    pub fn get_state(&self) -> Result<Value> {
        let session = self.session.as_ref().ok_or_else(no_active_session_error)?;
        Ok(json!({
            "snapshot": session.live_snapshot(),
            "session_dir": session.session_dir,
            "attempt_analysis": session.active_attempt.as_ref()
                .map(|_| session.active_attempt_analysis_value()),
            "active_attempt": session.active_attempt.as_ref().map(|attempt| json!({
                "item_id": attempt.item_id,
                "attempt_id": attempt.attempt_id,
                "start_sample": attempt.start_sample,
                "recording_started_sample": attempt.recording_started_sample,
                "head_silence_armed_sample": session.head_silence.armed_sample.load(Ordering::Acquire),
                "head_silence_passed_sample": session.head_silence.passed_sample.load(Ordering::Acquire),
                "head_silence_progress_samples": session.head_silence.progress_samples
                    .load(Ordering::Acquire).min(session.head_silence.required_samples()),
                "required_head_silence_samples": session.head_silence.required_samples(),
                "head_silence_phase": head_silence_phase_name(
                    session.head_silence.phase.load(Ordering::Acquire)
                ),
                "content_started_sample": session.attempt_signal_start_sample.load(Ordering::Acquire),
            })),
        }))
    }

    pub fn get_state_optional(&self) -> Value {
        let Some(session) = self.session.as_ref() else {
            return json!({ "active": false });
        };
        json!({
            "active": true,
            "snapshot": session.live_snapshot(),
            "session_dir": session.session_dir,
            "attempt_analysis": session.active_attempt.as_ref()
                .map(|_| session.active_attempt_analysis_value()),
            "active_attempt": session.active_attempt.as_ref().map(|attempt| json!({
                "item_id": attempt.item_id,
                "attempt_id": attempt.attempt_id,
                "start_sample": attempt.start_sample,
                "recording_started_sample": attempt.recording_started_sample,
                "head_silence_armed_sample": session.head_silence.armed_sample.load(Ordering::Acquire),
                "head_silence_passed_sample": session.head_silence.passed_sample.load(Ordering::Acquire),
                "head_silence_progress_samples": session.head_silence.progress_samples
                    .load(Ordering::Acquire).min(session.head_silence.required_samples()),
                "required_head_silence_samples": session.head_silence.required_samples(),
                "head_silence_phase": head_silence_phase_name(
                    session.head_silence.phase.load(Ordering::Acquire)
                ),
                "content_started_sample": session.attempt_signal_start_sample.load(Ordering::Acquire),
            })),
        })
    }

    pub fn stop_session(&mut self) -> Result<Value> {
        let result = {
            let session = self.session.as_mut().ok_or_else(no_active_session_error)?;
            let recording_fault = session.faulted.load(Ordering::Acquire)
                || session.overflow.load(Ordering::Acquire) > 0;
            if session.active_attempt.is_some() && !recording_fault {
                bail!("请先结束当前句，再结束整次录制");
            }
            session.stop()
        };
        if self
            .session
            .as_ref()
            .is_some_and(|session| session.capture_stopped)
        {
            self.session.take();
        }
        result
    }

    /// Finalize a recording left active by a process or machine crash without
    /// opening an input device. The physical WAV EOF is authoritative: repair
    /// and durably checkpoint it before committing the recovered metadata.
    #[cfg(test)]
    fn seal_interrupted_session(&self, session_dir: &Path) -> Result<Value> {
        self.seal_interrupted_session_inner(session_dir, JournalAppendFault::None)
    }

    pub fn seal_interrupted_session_expected(
        &self,
        session_dir: &Path,
        expected_session_id: &str,
    ) -> Result<Value> {
        let expected_session_id = expected_session_id.trim();
        if expected_session_id.is_empty() {
            bail!("离线封存需要明确的录制任务身份");
        }
        self.seal_interrupted_session_inner_expected(
            session_dir,
            Some(expected_session_id),
            JournalAppendFault::None,
        )
    }

    #[cfg(test)]
    fn seal_interrupted_session_inner(
        &self,
        session_dir: &Path,
        journal_fault: JournalAppendFault,
    ) -> Result<Value> {
        self.seal_interrupted_session_inner_expected(session_dir, None, journal_fault)
    }

    fn seal_interrupted_session_inner_expected(
        &self,
        session_dir: &Path,
        expected_session_id: Option<&str>,
        journal_fault: JournalAppendFault,
    ) -> Result<Value> {
        if self.session.is_some() {
            bail!("当前引擎仍有录制进行中，请先安全结束后再离线封存");
        }
        validate_offline_session_tree(session_dir)?;
        let _session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
        let mut journal = read_journal(session_dir)?;
        let journal_requires_rewrite =
            journal.truncate_to.is_some() || !journal.warnings.is_empty();
        let mut snapshot =
            load_recovery_snapshot_for_session(session_dir, &mut journal, expected_session_id)?;
        validate_offline_seal_snapshot(&snapshot)?;
        let storage_kind = MasterStorageKind::from_snapshot(&snapshot)?;
        let master_relative = Path::new(&snapshot.master_audio);
        if master_relative.is_absolute()
            || master_relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            bail!("snapshot master_audio must be a safe relative path");
        }
        let master_path = session_dir.join(master_relative);
        let source_metadata = std::fs::symlink_metadata(&master_path)
            .with_context(|| format!("inspect source audio {}", master_path.display()))?;
        let valid_source = match storage_kind {
            MasterStorageKind::LegacySingleWav => source_metadata.is_file(),
            MasterStorageKind::SegmentedWav => source_metadata.is_dir(),
        };
        if !valid_source || source_metadata.file_type().is_symlink() {
            bail!("recording source audio has an invalid type");
        }

        let has_authoritative_seal = journal.entries.iter().rev().any(|entry| {
            entry.get("event").and_then(Value::as_str) == Some("session_interrupted_sealed")
                && entry.get("journal_seq").and_then(Value::as_u64) == Some(snapshot.journal_seq)
                && entry
                    .get("snapshot")
                    .and_then(|value| value.get("session_id"))
                    .and_then(Value::as_str)
                    == Some(snapshot.session_id.as_str())
        });

        // This is the only step allowed to mutate audio. `open_append` repairs
        // an incomplete final frame and stale RIFF counters; `finalize` makes
        // that physical recovery durable. Neither path writes PCM samples.
        let max_frames_per_segment = storage_layout_segment_frames(&snapshot)?;
        let mut audio_recovery_warnings = Vec::<String>::new();
        let durable_frames = match storage_kind {
            MasterStorageKind::LegacySingleWav => RecoverableWav::open_append(
                &master_path,
                snapshot.audio_format.sample_rate,
                1,
                snapshot.audio_format.bit_depth,
            )?
            .finalize()?,
            MasterStorageKind::SegmentedWav => {
                let writer = SegmentedWav::resume(
                    &master_path,
                    snapshot.audio_format.sample_rate,
                    1,
                    snapshot.audio_format.bit_depth,
                    max_frames_per_segment,
                )?;
                audio_recovery_warnings.extend(writer.recovery_warnings().iter().cloned());
                writer.finalize()?
            }
        };
        let provenance_recovered =
            reconcile_capture_provenance_after_recovery(&mut snapshot, durable_frames)?;
        if let Err(error) = validate_attempt_boundaries(&snapshot, durable_frames) {
            let final_marker_exists =
                std::fs::symlink_metadata(session_dir.join(AUDIO_FAULT_MARKER)).is_ok();
            let marker_persisted = final_marker_exists
                || persist_audio_fault_marker(
                    session_dir,
                    &format!("offline seal found invalid attempt boundaries: {error:#}"),
                    durable_frames,
                );
            if marker_persisted {
                return Err(
                    error.context("母轨已物理修复，但句子时间戳与持久音频不一致，已写入故障标记")
                );
            }
            return Err(error.context("母轨已物理修复，但句子时间戳无效且故障标记未能持久化"));
        }

        let original_captured_samples = snapshot.captured_samples;
        let original_committed_samples = snapshot.committed_samples;
        let interrupted_before = snapshot
            .items
            .iter()
            .flat_map(|item| item.attempts.iter())
            .filter(|attempt| attempt.status == "interrupted")
            .count();
        let mut warnings = journal.warnings.clone();
        warnings.extend(audio_recovery_warnings);
        if provenance_recovered {
            warnings.push("已根据物理母轨长度补全异常中断前的最后一段采集来源区间。".to_string());
        }
        let interrupted_warnings =
            recover_interrupted_attempts(&journal, &mut snapshot, durable_frames)?;
        let has_interrupted_recovery = !interrupted_warnings.is_empty();
        warnings.extend(interrupted_warnings);
        let interrupted_after = snapshot
            .items
            .iter()
            .flat_map(|item| item.attempts.iter())
            .filter(|attempt| attempt.status == "interrupted")
            .count();
        let recovered_attempts = interrupted_after.saturating_sub(interrupted_before);
        let mut marker_present = audio_fault_marker_present(session_dir)?;
        let recorded_fault =
            marker_present || snapshot.status == "faulted" || snapshot.overflow_samples > 0;
        let claimed_final = snapshot.status == "stopped" || has_authoritative_seal;
        let final_audio_mismatch = claimed_final
            && (original_captured_samples != durable_frames
                || original_committed_samples != durable_frames);
        let final_status_consistent = if recorded_fault {
            snapshot.status == "faulted" && has_authoritative_seal
        } else {
            snapshot.status == "stopped"
        };
        if claimed_final
            && !final_audio_mismatch
            && !has_interrupted_recovery
            && recovered_attempts == 0
            && final_status_consistent
            && !journal_requires_rewrite
            && !provenance_recovered
        {
            return Ok(json!({
                "session_dir": session_dir,
                "snapshot": snapshot,
                "durable_frames": durable_frames,
                "recovered_attempts": 0,
                "fault_preserved": recorded_fault,
                "data_health": if recorded_fault { "readonly" } else { "normal" },
                "no_op": true,
                "warnings": warnings,
            }));
        }

        if final_audio_mismatch && !marker_present {
            marker_present = persist_audio_fault_marker(
                session_dir,
                "offline seal found a finalized snapshot whose sample watermarks did not match the physical WAV",
                durable_frames,
            );
            if !marker_present {
                bail!("母轨物理长度与已封存快照不一致，且故障标记未能持久化");
            }
            warnings.push(
                "已封存快照的样本水位与物理 WAV 不一致，已保留物理母轨并标记故障。".to_string(),
            );
        }
        let fault_preserved =
            marker_present || snapshot.status == "faulted" || snapshot.overflow_samples > 0;
        let previous_status = snapshot.status.clone();
        snapshot.status = if fault_preserved {
            "faulted".to_string()
        } else {
            "stopped".to_string()
        };
        snapshot.captured_samples = durable_frames;
        snapshot.committed_samples = durable_frames;
        snapshot.updated_at = Utc::now().to_rfc3339();
        snapshot.journal_seq = snapshot
            .journal_seq
            .checked_add(1)
            .context("journal sequence overflow")?;
        let event_value = json!({
            "journal_seq": snapshot.journal_seq,
            "event": "session_interrupted_sealed",
            "at": snapshot.updated_at,
            "payload": {
                "previous_status": previous_status,
                "durable_frames": durable_frames,
                "recovered_attempts": recovered_attempts,
                "fault_preserved": fault_preserved,
            },
            "captured_samples": snapshot.captured_samples,
            "committed_samples": snapshot.committed_samples,
            "snapshot": &snapshot,
        });
        let event_path = session_dir.join("metadata/events.jsonl");
        if let Err(failure) = append_journal_event(&event_path, &event_value, journal_fault) {
            let final_marker_exists =
                std::fs::symlink_metadata(session_dir.join(AUDIO_FAULT_MARKER)).is_ok();
            let marker_persisted = final_marker_exists
                || persist_audio_fault_marker(
                    session_dir,
                    &format!("offline seal journal durability failure: {failure}"),
                    durable_frames,
                );
            if marker_persisted {
                return Err(anyhow!(failure)
                    .context("母轨已物理封存，但恢复元数据未能写入权威事件日志，已写入故障标记"));
            }
            return Err(
                anyhow!(failure).context("母轨已物理封存，但恢复元数据日志与故障标记均未能持久化")
            );
        }

        // The durable full-snapshot journal event above is authoritative.
        // These files are replaceable projections; failures remain visible as
        // warnings but must not turn a committed recovery into a false error.
        let mut projection_failures = Vec::<String>::new();
        if let Err(error) =
            atomic_snapshot_json(&session_dir.join("metadata/items.snapshot.json"), &snapshot)
        {
            projection_failures.push(format!("update items snapshot: {error:#}"));
        }
        if let Err(error) =
            atomic_json(&session_dir.join("script/normalized.json"), &snapshot.items)
        {
            projection_failures.push(format!("update normalized script: {error:#}"));
        }
        if let Err(error) = atomic_json(
            &session_dir.join("session.json"),
            &session_summary_value(&snapshot),
        ) {
            projection_failures.push(format!("update session summary: {error:#}"));
        }
        if projection_failures.is_empty()
            && let Err(error) = atomic_json_line(&event_path, &event_value)
        {
            projection_failures.push(format!("compact journal: {error:#}"));
        }
        warnings.extend(projection_failures);
        for warning in warnings.iter().skip(journal.warnings.len()) {
            eprintln!(
                "offline seal projection/recovery warning for {} seq {}: {warning}",
                snapshot.session_id, snapshot.journal_seq
            );
        }
        Ok(json!({
            "session_dir": session_dir,
            "snapshot": snapshot,
            "durable_frames": durable_frames,
            "recovered_attempts": recovered_attempts,
            "fault_preserved": fault_preserved,
            "data_health": if fault_preserved { "readonly" } else { "normal" },
            "no_op": false,
            "warnings": warnings,
        }))
    }

    #[cfg(test)]
    fn export_session(&self, session_dir: &Path) -> Result<Value> {
        self.export_session_inner_expected(
            session_dir,
            ExportSessionOptions {
                expected_session_id: None,
                available_bytes_override: None,
                requested_artifact: None,
                export_scope: ExportScope::ConfirmedOnly,
                expected_journal_seq: None,
                acknowledged_warning_codes: &[
                    "retained_previous".to_string(),
                    "head_silence_short".to_string(),
                    "tail_silence_short".to_string(),
                ],
            },
        )
    }

    pub fn export_session_expected(
        &self,
        session_dir: &Path,
        expected_session_id: &str,
    ) -> Result<Value> {
        let expected_session_id = expected_session_id.trim();
        if expected_session_id.is_empty() {
            bail!("导出需要明确的录制任务身份");
        }
        self.export_session_inner_expected(
            session_dir,
            ExportSessionOptions {
                expected_session_id: Some(expected_session_id),
                available_bytes_override: None,
                requested_artifact: None,
                export_scope: ExportScope::ConfirmedOnly,
                expected_journal_seq: None,
                acknowledged_warning_codes: &[
                    "retained_previous".to_string(),
                    "head_silence_short".to_string(),
                    "tail_silence_short".to_string(),
                ],
            },
        )
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn export_session_artifact_expected(
        &self,
        session_dir: &Path,
        expected_session_id: &str,
        artifact: ExportArtifact,
    ) -> Result<Value> {
        let expected_session_id = expected_session_id.trim();
        if expected_session_id.is_empty() {
            bail!("导出需要明确的录制任务身份");
        }
        self.export_session_inner_expected(
            session_dir,
            ExportSessionOptions {
                expected_session_id: Some(expected_session_id),
                available_bytes_override: None,
                requested_artifact: Some(artifact),
                export_scope: ExportScope::ConfirmedOnly,
                expected_journal_seq: None,
                acknowledged_warning_codes: &[
                    "retained_previous".to_string(),
                    "head_silence_short".to_string(),
                    "tail_silence_short".to_string(),
                ],
            },
        )
    }

    pub fn export_session_artifact_with_options_expected(
        &self,
        session_dir: &Path,
        expected_session_id: &str,
        artifact: ExportArtifact,
        scope: ExportScope,
        expected_journal_seq: Option<u64>,
        acknowledged_warning_codes: &[String],
    ) -> Result<Value> {
        let expected_session_id = expected_session_id.trim();
        if expected_session_id.is_empty() {
            bail!("导出需要明确的录制任务身份");
        }
        if artifact == ExportArtifact::CutsZip && expected_journal_seq.is_none() {
            bail!("导出切片需要 expected_journal_seq，以防止误交付过期状态下选择的录音");
        }
        self.export_session_inner_expected(
            session_dir,
            ExportSessionOptions {
                expected_session_id: Some(expected_session_id),
                available_bytes_override: None,
                requested_artifact: Some(artifact),
                export_scope: scope,
                expected_journal_seq,
                acknowledged_warning_codes,
            },
        )
    }

    #[cfg(test)]
    fn export_session_inner(
        &self,
        session_dir: &Path,
        available_bytes_override: Option<u64>,
    ) -> Result<Value> {
        self.export_session_inner_expected(
            session_dir,
            ExportSessionOptions {
                expected_session_id: None,
                available_bytes_override,
                requested_artifact: None,
                export_scope: ExportScope::ConfirmedOnly,
                expected_journal_seq: None,
                acknowledged_warning_codes: &[
                    "retained_previous".to_string(),
                    "head_silence_short".to_string(),
                    "tail_silence_short".to_string(),
                ],
            },
        )
    }

    fn export_session_inner_expected(
        &self,
        session_dir: &Path,
        options: ExportSessionOptions<'_>,
    ) -> Result<Value> {
        let ExportSessionOptions {
            expected_session_id,
            available_bytes_override,
            requested_artifact,
            export_scope,
            expected_journal_seq,
            acknowledged_warning_codes,
        } = options;
        let session_metadata = std::fs::symlink_metadata(session_dir)
            .with_context(|| format!("inspect recording directory {}", session_dir.display()))?;
        if !session_metadata.is_dir() || session_metadata.file_type().is_symlink() {
            bail!("recording path must be a real directory, not a symbolic link");
        }
        let metadata_dir = session_dir.join("metadata");
        let metadata_dir_metadata = std::fs::symlink_metadata(&metadata_dir)
            .with_context(|| format!("inspect {}", metadata_dir.display()))?;
        if !metadata_dir_metadata.is_dir() || metadata_dir_metadata.file_type().is_symlink() {
            bail!("recording metadata path must be a real directory");
        }
        let _session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
        // Fault evidence and every mutable recovery projection must be read
        // under the same task lease. Checking the marker first leaves a race
        // where another process can fault/seal the session before this export
        // acquires the lock and then incorrectly publish a normal delivery.
        let export_full_track =
            requested_artifact.is_none_or(|artifact| artifact == ExportArtifact::FullTrack);
        let export_cuts =
            requested_artifact.is_none_or(|artifact| artifact == ExportArtifact::CutsZip);
        let export_timestamps =
            requested_artifact.is_none_or(|artifact| artifact == ExportArtifact::TimestampsJson);
        let mut effective_acknowledged_warning_codes = Vec::<String>::new();
        if export_cuts {
            ensure_no_audio_fault_marker(
                session_dir,
                if requested_artifact.is_none() {
                    "导出任务"
                } else {
                    "导出分段 ZIP"
                },
            )?;
        }
        let mut journal = read_journal(session_dir)?;
        let snapshot =
            load_recovery_snapshot_for_session(session_dir, &mut journal, expected_session_id)?;
        let recovery_warnings = journal.warnings;
        if export_cuts {
            if let Some(expected) = expected_journal_seq
                && expected != snapshot.journal_seq
            {
                bail!(
                    "任务已在导出前变更：期望 journal_seq={expected}，当前={}；请重新检查并确认告警",
                    snapshot.journal_seq
                );
            }
            validate_snapshot_for_cut_scope(&snapshot, export_scope)?;
        } else {
            validate_snapshot_for_artifact(&snapshot, requested_artifact)?;
        }
        let storage_kind = MasterStorageKind::from_snapshot(&snapshot)?;
        let master_relative = Path::new(&snapshot.master_audio);
        if master_relative.is_absolute()
            || master_relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            bail!("snapshot master_audio must be a safe relative path");
        }
        let audio_dir = session_dir.join("audio");
        let audio_dir_metadata = std::fs::symlink_metadata(&audio_dir)
            .with_context(|| format!("inspect {}", audio_dir.display()))?;
        if !audio_dir_metadata.is_dir() || audio_dir_metadata.file_type().is_symlink() {
            bail!("recording audio path must be a real directory");
        }
        let source = session_dir.join(master_relative);
        let export_dir = session_dir.join("export");
        match std::fs::symlink_metadata(&export_dir) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => bail!("recording export path must be a real directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&export_dir)?;
            }
            Err(error) => return Err(error.into()),
        }
        let pristine_empty = is_pristine_bootstrap(&snapshot) && snapshot.status == "stopped";
        let source_metadata = match std::fs::symlink_metadata(&source) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && pristine_empty => None,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("inspect source audio {}", source.display()));
            }
        };
        if let Some(source_metadata) = source_metadata.as_ref() {
            let valid_source = match storage_kind {
                MasterStorageKind::LegacySingleWav => source_metadata.is_file(),
                MasterStorageKind::SegmentedWav => source_metadata.is_dir(),
            };
            if !valid_source || source_metadata.file_type().is_symlink() {
                bail!("recording source audio has an invalid type");
            }
        }
        let max_frames_per_segment = storage_layout_segment_frames(&snapshot)?;
        let mut segmented_source = match (storage_kind, source_metadata.is_some()) {
            (_, false) => None,
            (MasterStorageKind::LegacySingleWav, true) => None,
            (MasterStorageKind::SegmentedWav, true) => Some(SegmentedWav::resume(
                &source,
                snapshot.audio_format.sample_rate,
                1,
                snapshot.audio_format.bit_depth,
                max_frames_per_segment,
            )?),
        };
        let physical_frames = match (segmented_source.as_ref(), source_metadata.is_some()) {
            (Some(source), true) => source.global_frames(),
            (Some(_), false) => unreachable!("segmented source requires source metadata"),
            (None, false) => 0,
            (None, true) => RecoverableWav::open_append(
                &source,
                snapshot.audio_format.sample_rate,
                1,
                snapshot.audio_format.bit_depth,
            )?
            .frames_written(),
        };
        if physical_frames != snapshot.committed_samples {
            bail!("母轨物理帧数与已提交水位不一致，必须先恢复并安全结束录制后再导出。");
        }
        let full_track_container = match storage_kind {
            MasterStorageKind::LegacySingleWav => "riff",
            MasterStorageKind::SegmentedWav => {
                automatic_wav_container_name(physical_frames, 1, snapshot.audio_format.bit_depth)?
            }
        };
        let sentences_dir = export_dir.join("sentences");
        match std::fs::symlink_metadata(&sentences_dir) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => bail!("recording sentence export path must be a real directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&sentences_dir)?;
            }
            Err(error) => return Err(error.into()),
        }

        let export_id = format!("{}-{}", std::process::id(), Utc::now().timestamp_micros());
        let export_started_at = Utc::now().to_rfc3339();
        let export_source = match requested_artifact {
            Some(ExportArtifact::FullTrack) => json!({
                "committed_samples": snapshot.committed_samples,
                "capture_provenance": snapshot.capture_provenance,
            }),
            _ => json!({
                "journal_seq": snapshot.journal_seq,
                "committed_samples": snapshot.committed_samples,
                "selected_attempts": snapshot.items.iter().map(|item| json!({
                    "id": item.id,
                    "attempt_id": item.selected_attempt_id,
                })).collect::<Vec<_>>(),
            }),
        };
        let in_progress_status = json!({
            "schema_version": 2,
            "status": "in_progress",
            "export_id": export_id,
            "session_id": snapshot.session_id,
            "scope": export_cuts.then_some(export_scope),
            "source": export_source,
            "started_at": export_started_at,
        });
        let mut sentence_plans = Vec::<SentenceExportPlan>::new();
        let mut skipped = Vec::<Value>::new();
        let mut export_warnings = Vec::<Value>::new();
        let mut used_file_names = std::collections::HashSet::<String>::new();
        for (item_index, item) in snapshot.items.iter().enumerate() {
            if export_cuts && item.status != "accepted" {
                skipped.push(json!({
                    "id": item.id,
                    "reason": cut_exclusion_reason(item),
                }));
                continue;
            }
            let Some(selected) = item.selected_attempt_id.as_deref() else {
                skipped.push(json!({ "id": item.id, "reason": item.status }));
                continue;
            };
            let Some(attempt_index) = item
                .attempts
                .iter()
                .position(|attempt| attempt.attempt_id == selected)
            else {
                if export_cuts {
                    bail!("条目 {} 的当前使用录音不存在", item.id);
                }
                skipped.push(json!({ "id": item.id, "reason": "selected_attempt_missing" }));
                continue;
            };
            let attempt = &item.attempts[attempt_index];
            if (export_cuts && attempt.status != "accepted")
                || matches!(attempt.status.as_str(), "interrupted" | "needs_rerecord")
                || attempt.end_sample <= attempt.start_sample
                || attempt.end_sample > snapshot.committed_samples
                || !attempt_range_has_provenance(&snapshot, attempt)
                || !attempt.quality_issues.is_empty()
            {
                if export_cuts {
                    bail!("条目 {} 的当前使用录音不可安全导出", item.id);
                }
                skipped.push(json!({ "id": item.id, "reason": "selected_attempt_unsafe" }));
                continue;
            }
            if export_cuts {
                export_warnings.extend(cut_export_warning_codes(item, attempt).into_iter().map(
                    |code| {
                        json!({
                            "code": code,
                            "item_id": item.id,
                        })
                    },
                ));
            }
            let file_name =
                allocate_sentence_file_name(&item.id, item_index, &mut used_file_names)?;
            let file_bytes = standard_wav_file_size(
                attempt.end_sample - attempt.start_sample,
                1,
                snapshot.audio_format.bit_depth,
            )?;
            sentence_plans.push(SentenceExportPlan {
                item_index,
                attempt_index,
                file_name,
                file_bytes,
            });
        }
        if export_cuts {
            let known_warning_codes = [
                "retained_previous",
                "head_silence_short",
                "tail_silence_short",
            ];
            let present_warning_codes = export_warnings
                .iter()
                .filter_map(|warning| warning["code"].as_str())
                .collect::<std::collections::BTreeSet<_>>();
            for acknowledged in acknowledged_warning_codes {
                if !known_warning_codes.contains(&acknowledged.as_str()) {
                    bail!("导出请求包含未知告警确认码 {acknowledged}");
                }
                if present_warning_codes.contains(acknowledged.as_str()) {
                    effective_acknowledged_warning_codes.push(acknowledged.clone());
                } else if expected_journal_seq.is_some() {
                    bail!("导出请求确认了当前快照中不存在的告警 {acknowledged}");
                }
            }
            let missing = present_warning_codes
                .iter()
                .copied()
                .filter(|code| {
                    !effective_acknowledged_warning_codes
                        .iter()
                        .any(|acknowledged| acknowledged == code)
                })
                .collect::<std::collections::BTreeSet<_>>();
            if !missing.is_empty() {
                bail!(
                    "导出前必须确认当前任务快照中的告警：{}",
                    missing.into_iter().collect::<Vec<_>>().join(", ")
                );
            }
        }

        let master_output = export_dir.join("full-track.wav");
        let export_status_path = export_dir.join(match requested_artifact {
            Some(ExportArtifact::FullTrack) => "status-full-track.json",
            Some(ExportArtifact::CutsZip) => "status-cuts-zip.json",
            Some(ExportArtifact::TimestampsJson) => "status-timestamps-json.json",
            None => "status.json",
        });
        let export_metadata_path = export_dir.join("timestamps.json");
        let export_csv_path = export_dir.join("timestamps.csv");
        let legacy_export_metadata_path = export_dir.join("metadata.json");
        let legacy_export_csv_path = export_dir.join("metadata.csv");
        let cuts_archive_path = export_dir.join("cuts.zip");
        let cuts_manifest_path = export_dir.join("cuts-manifest.json");
        let planned_master_bytes =
            automatic_wav_file_size(physical_frames, 1, snapshot.audio_format.bit_depth)?
                .max(source_metadata.as_ref().map_or(0, std::fs::Metadata::len));
        let mut storage_steps = Vec::<AtomicExportStep>::new();
        storage_steps.push(AtomicExportStep {
            new_bytes: planned_export_allocation(serialized_json_file_size(&in_progress_status)?)?,
            replaced_bytes: existing_export_allocation(existing_export_file_size(
                &export_status_path,
                "已有导出状态",
            )?),
        });
        // Once the cuts status is in_progress, remove every old sentence WAV as a
        // separate generation before writing any new sentence. This avoids
        // both Unicode filesystem aliases and double-crediting an old file as
        // the replacement target for more than one planned name.
        if export_cuts {
            let existing_sentence_sizes = existing_sentence_wav_sizes(&sentences_dir)?;
            for old_bytes in existing_sentence_sizes {
                storage_steps.push(AtomicExportStep {
                    new_bytes: 0,
                    replaced_bytes: old_bytes,
                });
            }
        }
        if export_full_track {
            storage_steps.push(AtomicExportStep {
                new_bytes: planned_export_allocation(planned_master_bytes)?,
                replaced_bytes: existing_export_allocation(existing_export_file_size(
                    &master_output,
                    "已有整轨导出",
                )?),
            });
        }
        if export_cuts {
            for plan in &sentence_plans {
                storage_steps.push(AtomicExportStep {
                    new_bytes: planned_export_allocation(plan.file_bytes)?,
                    replaced_bytes: 0,
                });
            }
            let planned_archive_bytes = stored_zip_size(
                &sentence_plans,
                Some(("manifest.json", EXPORT_METADATA_BASE_HEADROOM_BYTES)),
            )?;
            storage_steps.push(AtomicExportStep {
                new_bytes: planned_export_allocation(planned_archive_bytes)?,
                replaced_bytes: existing_export_allocation(existing_export_file_size(
                    &cuts_archive_path,
                    "已有切片压缩包",
                )?),
            });
            storage_steps.push(AtomicExportStep {
                new_bytes: export_metadata_headroom(&snapshot)?,
                replaced_bytes: existing_export_allocation(existing_export_file_size(
                    &cuts_manifest_path,
                    "已有切片清单",
                )?),
            });
        }
        if export_timestamps {
            existing_export_file_size(&export_metadata_path, "已有导出元数据")?;
            storage_steps.push(AtomicExportStep {
                new_bytes: export_metadata_headroom(&snapshot)?,
                replaced_bytes: 0,
            });
        }
        if requested_artifact.is_none() {
            existing_export_file_size(&export_csv_path, "已有 CSV 元数据")?;
            existing_export_file_size(&legacy_export_metadata_path, "已有兼容导出元数据")?;
            existing_export_file_size(&legacy_export_csv_path, "已有兼容 CSV 元数据")?;
            storage_steps.push(AtomicExportStep {
                new_bytes: export_metadata_headroom(&snapshot)?,
                replaced_bytes: 0,
            });
        }
        let storage = check_storage(
            &export_dir,
            snapshot.audio_format.sample_rate,
            1,
            snapshot.audio_format.bit_depth,
        )?;
        let available_bytes = available_bytes_override.unwrap_or(storage.available_bytes);
        let export_space = evaluate_atomic_export_space(
            available_bytes,
            storage.critical_threshold_bytes,
            &storage_steps,
        )?;
        if !export_space.can_export {
            bail!(
                "导出磁盘空间不足：required={} 字节，available={} 字节，reserve={} 字节（导出峰值新增 {} 字节）。未写入导出文件，原始母轨保持不变。",
                export_space.required_available_bytes,
                export_space.available_bytes,
                export_space.critical_reserve_bytes,
                export_space.peak_additional_bytes,
            );
        }
        atomic_json(&export_status_path, &in_progress_status)?;
        if export_cuts {
            remove_all_sentence_wavs(&sentences_dir)?;
        }
        if export_full_track {
            match (segmented_source.as_mut(), source_metadata.is_some()) {
                (Some(source), true) => {
                    source.export_whole(&master_output)?;
                }
                (Some(_), false) => unreachable!("segmented source requires source metadata"),
                (None, true) => {
                    durable_copy_file(&source, &master_output)?;
                }
                (None, false) => write_empty_wav_export(
                    &master_output,
                    snapshot.audio_format.sample_rate,
                    snapshot.audio_format.bit_depth,
                )?,
            }
        }
        let mut exported = Vec::new();
        for plan in &sentence_plans {
            let item = &snapshot.items[plan.item_index];
            let attempt = &item.attempts[plan.attempt_index];
            if export_cuts {
                let output = sentences_dir.join(&plan.file_name);
                match segmented_source.as_mut() {
                    Some(source) => {
                        source.export_range(&output, attempt.start_sample, attempt.end_sample)?;
                    }
                    None => {
                        slice_wav_mono(
                            &source,
                            &output,
                            snapshot.audio_format.sample_rate,
                            snapshot.audio_format.bit_depth,
                            attempt.start_sample,
                            attempt.end_sample,
                        )?;
                    }
                }
            }
            let slice_sha256 = export_cuts
                .then(|| sha256_file(&sentences_dir.join(&plan.file_name)))
                .transpose()?;
            exported.push(json!({
                "id": item.id,
                "text": item.text,
                "label": item.label,
                "attempt_id": attempt.attempt_id,
                "start_sample": attempt.start_sample,
                "recording_started_sample": attempt.recording_started_sample,
                "head_silence_armed_sample": attempt.head_silence_armed_sample,
                "head_silence_passed_sample": attempt.head_silence_passed_sample,
                "required_head_silence_samples": attempt.required_head_silence_samples,
                "content_started_sample": attempt.content_started_sample,
                "content_started_seconds": attempt.content_started_sample as f64
                    / f64::from(snapshot.audio_format.sample_rate),
                "end_sample": attempt.end_sample,
                "duration_samples": attempt.end_sample - attempt.start_sample,
                "file": format!("sentences/{}", plan.file_name),
                "forced_without_tail_silence": attempt.forced_without_tail_silence,
                "tail_silence_samples": attempt.tail_silence_samples,
                "required_tail_silence_samples": attempt.required_tail_silence_samples,
                "sha256": slice_sha256,
            }));
        }
        let mut risk_warnings = Vec::<String>::new();
        if snapshot.status == "faulted" || snapshot.overflow_samples > 0 {
            risk_warnings.push(
                "任务包含采集故障或写盘溢出；请将整轨和时间戳作为恢复材料人工检查。".to_string(),
            );
        }
        if snapshot.input_discontinuity_count > 0 {
            risk_warnings.push(format!(
                "声卡链路发生 {} 次可恢复短暂抖动，已插入 {} 帧静音保持时间轴；请人工复核受影响句子。",
                snapshot.input_discontinuity_count,
                snapshot.input_discontinuity_silence_samples,
            ));
        }
        let metadata = json!({
            "schema_version": 1,
            "session_id": snapshot.session_id,
            "script_name": snapshot.script_name,
            "device_name": snapshot.device_name,
            "device_id": snapshot.device_id,
            "input_sample_format": snapshot.input_sample_format,
            "capture_share_mode": snapshot.capture_share_mode,
            "capture_provenance": snapshot.capture_provenance,
            "audio_format": snapshot.audio_format,
            "storage_layout_version": snapshot.storage_layout_version,
            "segment_frames": snapshot.segment_frames,
            "input_discontinuity_count": snapshot.input_discontinuity_count,
            "input_discontinuity_silence_samples": snapshot.input_discontinuity_silence_samples,
            "noise_check": snapshot.noise_check,
            "silence_policy": {
                "duration_ms": snapshot.silence_duration_ms,
                "threshold_dbfs": snapshot.silence_threshold_dbfs,
            },
            "source": export_source,
            "data_health": if snapshot.status == "faulted" || snapshot.overflow_samples > 0 {
                "faulted"
            } else {
                "normal"
            },
            "risk_warnings": risk_warnings,
            "items": &snapshot.items,
            "full_track": "full-track.wav",
            "full_track_container": full_track_container,
            "exported": exported,
            "skipped": skipped,
        });
        if export_timestamps {
            atomic_json(&export_metadata_path, &metadata)?;
        }
        if requested_artifact.is_none() {
            write_csv(&export_csv_path, &metadata["exported"])?;
            atomic_json(&legacy_export_metadata_path, &metadata)?;
            write_csv(&legacy_export_csv_path, &metadata["exported"])?;
        }
        let mut cuts_sha256 = None::<String>;
        if export_cuts {
            let manifest_included = metadata["exported"]
                .as_array()
                .context("cuts manifest included rows must be an array")?
                .iter()
                .cloned()
                .map(|mut row| -> Result<Value> {
                    let object = row
                        .as_object_mut()
                        .context("cuts manifest included row must be an object")?;
                    let sentence_file = object
                        .get("file")
                        .and_then(Value::as_str)
                        .and_then(|file| file.strip_prefix("sentences/"))
                        .context("cuts manifest row has an invalid sentence path")?;
                    object.insert("file".to_string(), json!(format!("cuts/{sentence_file}")));
                    Ok(row)
                })
                .collect::<Result<Vec<_>>>()?;
            let manifest = json!({
                "schema_version": 1,
                "engine_version": env!("CARGO_PKG_VERSION"),
                "app_version": option_env!("DATABAKER_APP_VERSION").unwrap_or("unknown"),
                "session_id": snapshot.session_id,
                "export_id": export_id,
                "scope": export_scope,
                "journal_seq": snapshot.journal_seq,
                "committed_samples": snapshot.committed_samples,
                "generated_at": Utc::now().to_rfc3339(),
                "included": manifest_included,
                "excluded": metadata["skipped"],
                "warnings": export_warnings,
                "acknowledged_warning_codes": effective_acknowledged_warning_codes,
            });
            atomic_json(&cuts_manifest_path, &manifest)?;
            let manifest_bytes =
                std::fs::read(&cuts_manifest_path).context("read the committed cuts manifest")?;
            write_stored_zip(
                &cuts_archive_path,
                &sentences_dir,
                &sentence_plans,
                Some(("manifest.json", manifest_bytes.as_slice())),
            )?;
            cuts_sha256 = Some(sha256_file(&cuts_archive_path)?);
            if requested_artifact.is_some() {
                remove_all_sentence_wavs(&sentences_dir)?;
            }
        }
        let artifact_sha256 = match requested_artifact {
            Some(ExportArtifact::FullTrack) => Some(sha256_file(&master_output)?),
            Some(ExportArtifact::CutsZip) => cuts_sha256.clone(),
            Some(ExportArtifact::TimestampsJson) => Some(sha256_file(&export_metadata_path)?),
            None => None,
        };
        let exported_count = metadata["exported"].as_array().map_or(0, Vec::len);
        let skipped_count = metadata["skipped"].as_array().map_or(0, Vec::len);
        // This small commit marker is always the last published file. Readers
        // must ignore the bundle while it says `in_progress`, so a crash or a
        // failed re-export cannot be mistaken for a coherent delivery.
        atomic_json(
            &export_status_path,
            &json!({
                "schema_version": 2,
                "status": "complete",
                "export_id": export_id,
                "session_id": snapshot.session_id,
                "artifact": requested_artifact.map(|artifact| match artifact {
                    ExportArtifact::FullTrack => "full_track",
                    ExportArtifact::CutsZip => "cuts_zip",
                    ExportArtifact::TimestampsJson => "timestamps_json",
                }),
                "scope": export_cuts.then_some(export_scope),
                "source": export_source,
                "manifest_file": export_cuts.then_some("cuts-manifest.json"),
                "sha256": artifact_sha256,
                "started_at": export_started_at,
                "completed_at": Utc::now().to_rfc3339(),
                "exported_count": exported_count,
                "skipped_count": skipped_count,
            }),
        )?;
        Ok(json!({
            "artifact": requested_artifact.map(|artifact| match artifact {
                ExportArtifact::FullTrack => "full_track",
                ExportArtifact::CutsZip => "cuts_zip",
                ExportArtifact::TimestampsJson => "timestamps_json",
            }),
            "export_id": export_id,
            "scope": export_cuts.then_some(export_scope),
            "source": export_source,
            "manifest_file": export_cuts.then_some(cuts_manifest_path),
            "sha256": artifact_sha256,
            "export_dir": export_dir,
            "master_file": export_full_track.then_some(master_output),
            "master_container": full_track_container,
            "timestamps_json": export_timestamps.then_some(export_metadata_path),
            "timestamps_csv": requested_artifact.is_none().then_some(export_csv_path),
            "sentences_dir": requested_artifact.is_none().then_some(sentences_dir),
            "cuts_archive": export_cuts.then_some(cuts_archive_path),
            "exported_count": exported_count,
            "skipped_count": skipped_count,
            "recovery_warnings": recovery_warnings,
            "storage_preflight": {
                "available_bytes": export_space.available_bytes,
                "required_available_bytes": export_space.required_available_bytes,
                "critical_reserve_bytes": export_space.critical_reserve_bytes,
                "peak_additional_bytes": export_space.peak_additional_bytes,
            },
        }))
    }

    pub fn shutdown(&mut self) -> Result<()> {
        let Some(_) = self.session.as_mut() else {
            return Ok(());
        };
        let result = self.session.as_mut().unwrap().stop();
        if self
            .session
            .as_ref()
            .is_some_and(|session| session.capture_stopped)
        {
            self.session.take();
        }
        result.map(|_| ())
    }

    fn finish_activation_failure(
        &mut self,
        session: RecordingSession,
        stage: &str,
        error: anyhow::Error,
    ) -> anyhow::Error {
        self.finish_activation_failure_with_timeout(session, stage, error, CAPTURE_SHUTDOWN_TIMEOUT)
    }

    fn finish_activation_failure_with_timeout(
        &mut self,
        mut session: RecordingSession,
        stage: &str,
        error: anyhow::Error,
        timeout: Duration,
    ) -> anyhow::Error {
        let reason = format!("{error:#}");
        let cleanup = session.cleanup_after_activation_failure_with_timeout(timeout);
        let persisted = session.persist_activation_failure(stage, &reason, &cleanup);
        let cleanup_context = if cleanup.capture_resources_joined {
            if cleanup.warnings.is_empty() {
                "capture resources were stopped and joined within the safety deadline".to_string()
            } else {
                format!(
                    "capture resources were stopped and joined with warnings: {}",
                    cleanup.warnings.join("; ")
                )
            }
        } else {
            format!(
                "capture cleanup reached its deadline; the live session, task lock, and unfinished handles were retained{}",
                if cleanup.warnings.is_empty() {
                    String::new()
                } else {
                    format!(": {}", cleanup.warnings.join("; "))
                }
            )
        };
        let persistence_context = match persisted {
            Ok(()) if !cleanup.capture_resources_joined => {
                "session_activation_failed was durably committed as stopping; call stop_session again to finish cleanup"
                    .to_string()
            }
            Ok(()) if cleanup.audio_safe => {
                "session_activation_failed was durably committed as stopped and may be resumed"
                    .to_string()
            }
            Ok(()) => {
                "session_activation_failed was durably committed as faulted for manual recovery"
                    .to_string()
            }
            Err(persist_error) => {
                format!("could not durably commit session_activation_failed: {persist_error:#}")
            }
        };
        if !cleanup.capture_resources_joined {
            debug_assert!(self.session.is_none());
            self.session = Some(session);
        }
        error.context(format!(
            "activation stage {stage} failed; {cleanup_context}; {persistence_context}"
        ))
    }

    fn active_session_mut(&mut self) -> Result<&mut RecordingSession> {
        self.session.as_mut().ok_or_else(no_active_session_error)
    }
}

fn ensure_real_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => bail!("{} must be a real directory", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            durable_create_directory(path)
        }
        Err(error) => Err(error).with_context(|| format!("inspect directory {}", path.display())),
    }
}

fn remove_existing_leaf(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
        Ok(metadata) if metadata.file_type().is_symlink() || metadata.is_file() => {
            std::fs::remove_file(path).with_context(|| format!("remove {}", path.display()))
        }
        Ok(metadata) if metadata.is_dir() => {
            empty_real_directory(path)?;
            std::fs::remove_dir(path).with_context(|| format!("remove {}", path.display()))
        }
        Ok(_) => bail!("cannot remove unexpected file type {}", path.display()),
    }
}

fn empty_real_directory(path: &Path) -> Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("inspect {}", path.display()));
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("{} must be a real directory", path.display());
    }
    for entry in std::fs::read_dir(path).with_context(|| format!("list {}", path.display()))? {
        remove_existing_leaf(&entry?.path())?;
    }
    Ok(())
}

fn wipe_recorded_session_data(session_dir: &Path) -> Result<()> {
    for name in ["audio", "export", "preview"] {
        empty_real_directory(&session_dir.join(name))?;
    }
    remove_existing_leaf(&session_dir.join("metadata/events.jsonl"))?;
    remove_existing_leaf(&session_dir.join(AUDIO_FAULT_MARKER))?;
    remove_existing_leaf(&session_dir.join(AUDIO_FAULT_RESERVE))?;
    remove_existing_leaf(&session_dir.join("metadata/audio-fault.tmp"))?;
    Ok(())
}

fn remove_stale_snapshot_generations(session_dir: &Path) -> Result<()> {
    let final_path = session_dir.join("metadata/items.snapshot.json");
    for (path, _, _) in snapshot_candidate_paths(session_dir) {
        if path == final_path {
            continue;
        }
        remove_existing_leaf(&path)?;
    }
    Ok(())
}

fn validate_offline_session_tree(session_dir: &Path) -> Result<()> {
    let session_metadata = std::fs::symlink_metadata(session_dir)
        .with_context(|| format!("inspect recording directory {}", session_dir.display()))?;
    if session_metadata.file_type().is_symlink() || !session_metadata.is_dir() {
        bail!("recording path must be a real directory, not a symbolic link");
    }
    for name in ["audio", "metadata", "script"] {
        let directory = session_dir.join(name);
        let metadata = std::fs::symlink_metadata(&directory)
            .with_context(|| format!("inspect {}", directory.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            bail!("recording {name} path must be a real directory");
        }
    }
    for name in ["preview", "export"] {
        let directory = session_dir.join(name);
        match std::fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => bail!("recording {name} path must be a real directory when present"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("inspect {}", directory.display()));
            }
        }
    }
    Ok(())
}

fn persist_offline_snapshot(
    session_dir: &Path,
    snapshot: &mut SessionSnapshot,
    event: &str,
    payload: Value,
) -> Result<()> {
    snapshot.journal_seq = snapshot
        .journal_seq
        .checked_add(1)
        .context("journal sequence overflow")?;
    snapshot.updated_at = Utc::now().to_rfc3339();
    let event_value = json!({
        "journal_seq": snapshot.journal_seq,
        "event": event,
        "at": snapshot.updated_at,
        "payload": payload,
        "captured_samples": snapshot.captured_samples,
        "committed_samples": snapshot.committed_samples,
        "snapshot": &snapshot,
    });
    let event_path = session_dir.join("metadata/events.jsonl");
    append_journal_event(&event_path, &event_value, JournalAppendFault::None)
        .map_err(|error| anyhow!(error))?;
    let mut projection_failures = Vec::<String>::new();
    if let Err(error) =
        atomic_snapshot_json(&session_dir.join("metadata/items.snapshot.json"), snapshot)
    {
        projection_failures.push(format!("update items snapshot: {error:#}"));
    }
    if let Err(error) = atomic_json(&session_dir.join("script/normalized.json"), &snapshot.items) {
        projection_failures.push(format!("update normalized script: {error:#}"));
    }
    if let Err(error) = atomic_json(
        &session_dir.join("session.json"),
        &session_summary_value(snapshot),
    ) {
        projection_failures.push(format!("update session summary: {error:#}"));
    }
    if projection_failures.is_empty()
        && let Err(error) = atomic_json_line(&event_path, &event_value)
    {
        projection_failures.push(format!("compact journal: {error:#}"));
    }
    for failure in projection_failures {
        eprintln!(
            "offline metadata projection warning after committed event {} seq {}: {failure}",
            event, snapshot.journal_seq,
        );
    }
    Ok(())
}

fn render_offline_range(
    session_dir: &Path,
    snapshot: &SessionSnapshot,
    destination: &Path,
    start_sample: u64,
    end_sample: u64,
) -> Result<u64> {
    let (source, storage_kind) = validated_offline_master_source(session_dir, snapshot)?;
    match storage_kind {
        MasterStorageKind::LegacySingleWav => {
            slice_wav_mono(
                &source,
                destination,
                snapshot.audio_format.sample_rate,
                snapshot.audio_format.bit_depth,
                start_sample,
                end_sample,
            )?;
        }
        MasterStorageKind::SegmentedWav => {
            let mut segmented = SegmentedWav::resume(
                &source,
                snapshot.audio_format.sample_rate,
                1,
                snapshot.audio_format.bit_depth,
                storage_layout_segment_frames(snapshot)?,
            )?;
            segmented.export_range(destination, start_sample, end_sample)?;
        }
    }
    Ok(end_sample - start_sample)
}

fn waveform_offline_range(
    session_dir: &Path,
    snapshot: &SessionSnapshot,
    start_sample: u64,
    end_sample: u64,
) -> Result<Vec<[f32; 2]>> {
    let (source, storage_kind) = validated_offline_master_source(session_dir, snapshot)?;
    match storage_kind {
        MasterStorageKind::LegacySingleWav => waveform_wav_mono(
            &source,
            snapshot.audio_format.sample_rate,
            snapshot.audio_format.bit_depth,
            start_sample,
            end_sample,
        ),
        MasterStorageKind::SegmentedWav => {
            let mut segmented = SegmentedWav::resume(
                &source,
                snapshot.audio_format.sample_rate,
                1,
                snapshot.audio_format.bit_depth,
                storage_layout_segment_frames(snapshot)?,
            )?;
            let dummy = source.join(".waveform-preview");
            segmented
                .prepare_export_range(&dummy, start_sample, end_sample)?
                .waveform_bins()
        }
    }
}

fn validated_offline_master_source(
    session_dir: &Path,
    snapshot: &SessionSnapshot,
) -> Result<(PathBuf, MasterStorageKind)> {
    let master_relative = Path::new(&snapshot.master_audio);
    if master_relative.is_absolute()
        || master_relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        bail!("snapshot master_audio must be a safe relative path");
    }
    let source = session_dir.join(master_relative);
    let storage_kind = MasterStorageKind::from_snapshot(snapshot)?;
    let metadata = std::fs::symlink_metadata(&source)
        .with_context(|| format!("inspect source audio {}", source.display()))?;
    let expected_type = match storage_kind {
        MasterStorageKind::LegacySingleWav => metadata.is_file(),
        MasterStorageKind::SegmentedWav => metadata.is_dir(),
    };
    if metadata.file_type().is_symlink() || !expected_type {
        bail!("recording source audio has an invalid type");
    }
    Ok((source, storage_kind))
}

fn usable_preview_attempt<'a>(
    snapshot: &'a SessionSnapshot,
    item_id: &str,
    attempt_id: &str,
) -> Result<&'a Attempt> {
    validate_snapshot_identifiers(snapshot)?;
    validate_capture_provenance(snapshot, snapshot.committed_samples, true)?;
    let attempt = snapshot
        .items
        .iter()
        .find(|item| item.id == item_id)
        .and_then(|item| {
            item.attempts
                .iter()
                .find(|attempt| attempt.attempt_id == attempt_id)
        })
        .ok_or_else(|| anyhow!("指定录音不存在"))?;
    if !attempt_boundaries_are_valid(snapshot, attempt, snapshot.committed_samples)
        || !attempt_is_delivery_safe(snapshot, attempt)?
    {
        bail!("异常中断或样本边界越界的录音不能试听");
    }
    Ok(attempt)
}

/// Loads every mutable recovery projection while holding the same exclusive
/// lease that will be transferred into the live recording session.
///
/// Acquiring the lease after reading the journal is unsafe even when the audio
/// writer later verifies physical EOF: another recorder can commit newer item
/// decisions, release its lease, and leave this process holding a stale but
/// otherwise valid full snapshot. Persisting that stale projection twice would
/// rotate away the newer `.prev` generation and permanently regress sentence
/// timestamps while the master audio itself continues to grow.
fn load_locked_recovery_snapshot(
    session_dir: &Path,
    operation: &str,
    expected_session_id: Option<&str>,
) -> Result<(SessionLock, JournalLog, SessionSnapshot)> {
    let session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
    ensure_no_audio_fault_marker(session_dir, operation)?;
    let mut journal = read_journal(session_dir)?;
    let snapshot =
        load_recovery_snapshot_for_session(session_dir, &mut journal, expected_session_id)?;
    Ok((session_lock, journal, snapshot))
}

fn validate_offline_seal_snapshot(snapshot: &SessionSnapshot) -> Result<()> {
    if snapshot.schema_version != 1 || snapshot.session_id.trim().is_empty() {
        bail!("录制任务快照版本或录制 ID 无效");
    }
    if !matches!(
        snapshot.status.as_str(),
        "recording" | "stopping" | "stopped" | "faulted"
    ) {
        bail!("录制任务状态无效，不能离线封存");
    }
    if snapshot.items.is_empty() {
        bail!("录制任务没有可恢复的脚本条目");
    }
    if snapshot.audio_format.sample_rate == 0
        || snapshot.audio_format.channels != 1
        || snapshot.audio_format.input_channels == 0
        || snapshot.audio_format.input_channel == 0
        || snapshot.audio_format.input_channel > snapshot.audio_format.input_channels
    {
        bail!("录制任务的音频通道配置无效");
    }
    let output_encoding = WavEncoding::for_bit_depth(snapshot.audio_format.bit_depth)?;
    if snapshot.audio_format.encoding != output_encoding.name() {
        bail!("录制任务的位深与编码不一致");
    }
    if !(200..=5_000).contains(&snapshot.silence_duration_ms)
        || !snapshot.silence_threshold_dbfs.is_finite()
        || !(-96.0..=-6.0).contains(&snapshot.silence_threshold_dbfs)
    {
        bail!("录制任务的静音检测参数无效");
    }
    storage_layout_segment_frames(snapshot)?;
    Ok(())
}

fn attempt_boundaries_are_valid(
    snapshot: &SessionSnapshot,
    attempt: &Attempt,
    durable_frames: u64,
) -> bool {
    let abnormal = matches!(attempt.status.as_str(), "interrupted" | "needs_rerecord");
    let head_silence_invalid = if attempt.head_silence_passed_sample == 0 {
        !abnormal
            && (attempt.head_silence_armed_sample != 0
                || attempt.required_head_silence_samples != 0)
    } else {
        !abnormal
            && (attempt.head_silence_armed_sample > attempt.head_silence_passed_sample
                || attempt.required_head_silence_samples == 0
                || attempt
                    .head_silence_passed_sample
                    .saturating_sub(attempt.head_silence_armed_sample)
                    < attempt.required_head_silence_samples
                || attempt.recording_started_sample != attempt.head_silence_armed_sample
                || !valid_completed_attempt_start(attempt, snapshot.silence_detector))
    };
    attempt.start_sample <= durable_frames
        && attempt.recording_started_sample <= durable_frames
        && attempt.head_silence_armed_sample <= durable_frames
        && attempt.head_silence_passed_sample <= durable_frames
        && attempt.content_started_sample <= durable_frames
        && attempt.end_sample <= durable_frames
        && attempt_sample_order_is_valid(attempt)
        && !head_silence_invalid
        && (!abnormal || attempt.end_sample >= attempt.start_sample)
        && (abnormal || attempt.end_sample > attempt.start_sample)
}

fn validate_attempt_boundaries(snapshot: &SessionSnapshot, durable_frames: u64) -> Result<()> {
    let invalid = snapshot
        .items
        .iter()
        .flat_map(|item| item.attempts.iter())
        .any(|attempt| !attempt_boundaries_are_valid(snapshot, attempt, durable_frames));
    if invalid {
        bail!("录制任务包含超出母音频范围或长度无效的句子时间戳");
    }
    Ok(())
}

fn validate_attempt_quality_issues(attempt: &Attempt) -> Result<()> {
    for issue in &attempt.quality_issues {
        if !known_quality_issue_code(issue.code.as_str()) {
            bail!(
                "录音 {} 包含未知质量问题码 {}，已按不可交付处理",
                attempt.attempt_id,
                issue.code
            );
        }
        match (issue.start_sample, issue.end_sample) {
            (Some(start), Some(end))
                if start <= end
                    && start >= attempt.recording_started_sample
                    && end <= attempt.end_sample => {}
            (None, None) => {}
            _ => bail!("录音 {} 的质量问题区间无效", attempt.attempt_id),
        }
    }
    Ok(())
}

fn attempt_range_has_provenance(snapshot: &SessionSnapshot, attempt: &Attempt) -> bool {
    if snapshot.capture_provenance.is_empty() {
        // Missing evidence is not evidence of coverage. Older tasks remain
        // readable and their full track/diagnostics stay exportable, but
        // sentence delivery is fail-closed until provenance is repaired.
        return false;
    }
    let mut cursor = attempt.start_sample;
    for span in &snapshot.capture_provenance {
        if span.end_sample <= cursor || span.start_sample >= attempt.end_sample {
            continue;
        }
        if span.start_sample > cursor {
            return false;
        }
        cursor = cursor.max(span.end_sample.min(attempt.end_sample));
        if cursor >= attempt.end_sample {
            return true;
        }
    }
    false
}

fn attempt_is_delivery_safe(snapshot: &SessionSnapshot, attempt: &Attempt) -> Result<bool> {
    validate_attempt_quality_issues(attempt)?;
    Ok(matches!(
        attempt.status.as_str(),
        "recorded" | "accepted" | "rejected_by_operator"
    ) && attempt.quality_issues.is_empty()
        && attempt_sample_order_is_valid(attempt)
        && attempt.end_sample > attempt.start_sample
        && attempt.end_sample <= snapshot.committed_samples
        && attempt_range_has_provenance(snapshot, attempt))
}

fn attempt_sample_order_is_valid(attempt: &Attempt) -> bool {
    attempt.recording_started_sample <= attempt.start_sample
        && attempt.recording_started_sample <= attempt.end_sample
        && (attempt.head_silence_armed_sample == 0
            || (attempt.recording_started_sample <= attempt.head_silence_armed_sample
                && attempt.head_silence_armed_sample <= attempt.end_sample))
        && (attempt.head_silence_passed_sample == 0
            || (attempt.head_silence_armed_sample <= attempt.head_silence_passed_sample
                && attempt.head_silence_passed_sample <= attempt.end_sample))
        && (attempt.content_started_sample == 0
            || (attempt.start_sample <= attempt.content_started_sample
                && attempt.recording_started_sample <= attempt.content_started_sample
                && attempt.content_started_sample <= attempt.end_sample))
}

fn valid_completed_attempt_start(attempt: &Attempt, detector: SilenceDetector) -> bool {
    attempt.start_sample == attempt.recording_started_sample
        || attempt.start_sample == attempt.head_silence_passed_sample
        || (detector == SilenceDetector::Vad && valid_vad_trimmed_clip_start(attempt))
}

/// VAD stop-trim keeps about `required_head_silence_samples` before first speech,
/// clamped to the operator click. That start is neither the click nor the
/// elapsed pending-timer mark, so export must accept it as a third legal origin.
fn valid_vad_trimmed_clip_start(attempt: &Attempt) -> bool {
    if attempt.content_started_sample == 0 {
        return false;
    }
    let expected = attempt
        .content_started_sample
        .saturating_sub(attempt.required_head_silence_samples)
        .max(attempt.recording_started_sample);
    attempt.start_sample == expected
        && attempt.start_sample <= attempt.content_started_sample
        && attempt.content_started_sample <= attempt.end_sample
}

fn capture_span_from_snapshot(
    snapshot: &SessionSnapshot,
    start_sample: u64,
    end_sample: u64,
) -> CaptureProvenanceSpan {
    CaptureProvenanceSpan {
        start_sample,
        end_sample,
        device_name: snapshot.device_name.clone(),
        device_id: snapshot.device_id.clone(),
        input_sample_format: if snapshot.input_sample_format.trim().is_empty() {
            "unknown".to_string()
        } else {
            snapshot.input_sample_format.clone()
        },
        input_channels: snapshot.audio_format.input_channels,
        input_channel: snapshot.audio_format.input_channel,
        sample_rate: snapshot.audio_format.sample_rate,
    }
}

fn same_capture_source(left: &CaptureProvenanceSpan, right: &CaptureProvenanceSpan) -> bool {
    left.device_id == right.device_id
        && left.device_name == right.device_name
        && left.input_sample_format == right.input_sample_format
        && left.input_channels == right.input_channels
        && left.input_channel == right.input_channel
        && left.sample_rate == right.sample_rate
}

fn validate_capture_provenance(
    snapshot: &SessionSnapshot,
    durable_frames: u64,
    require_complete: bool,
) -> Result<()> {
    let mut cursor = 0u64;
    for (index, span) in snapshot.capture_provenance.iter().enumerate() {
        if span.start_sample != cursor
            || span.end_sample < span.start_sample
            || span.end_sample > durable_frames
        {
            bail!("采集来源的第 {} 个样本区间不连续或越界", index + 1);
        }
        if span.sample_rate != snapshot.audio_format.sample_rate
            || span.input_channels == 0
            || span.input_channel == 0
            || span.input_channel > span.input_channels
            || span.input_sample_format.trim().is_empty()
        {
            bail!("采集来源的第 {} 个驱动配置无效", index + 1);
        }
        cursor = span.end_sample;
    }
    if require_complete && durable_frames > 0 && snapshot.capture_provenance.is_empty() {
        bail!("采集来源缺失，无法证明持久母轨的样本覆盖关系");
    }
    if require_complete && cursor != durable_frames {
        bail!("采集来源区间未完整覆盖持久母轨");
    }
    Ok(())
}

fn begin_capture_provenance(
    snapshot: &mut SessionSnapshot,
    mut previous_source: CaptureProvenanceSpan,
    existing_frames: u64,
) -> Result<()> {
    // Activations that produced no durable audio do not need an empty delivery
    // span; their journal events still remain available for diagnostics.
    while snapshot
        .capture_provenance
        .last()
        .is_some_and(|span| span.start_sample == span.end_sample)
    {
        snapshot.capture_provenance.pop();
    }
    validate_capture_provenance(snapshot, existing_frames, false)?;

    if snapshot.capture_provenance.is_empty() && existing_frames > 0 {
        previous_source.start_sample = 0;
        previous_source.end_sample = existing_frames;
        snapshot.capture_provenance.push(previous_source);
    } else if let Some(last) = snapshot.capture_provenance.last_mut()
        && last.end_sample < existing_frames
    {
        if !same_capture_source(last, &previous_source) {
            bail!("快照中未归属的母轨尾部无法安全匹配到上一次采集配置");
        }
        last.end_sample = existing_frames;
    }

    let current_source = capture_span_from_snapshot(snapshot, existing_frames, existing_frames);
    snapshot.capture_provenance.push(current_source);
    validate_capture_provenance(snapshot, existing_frames, true)
}

fn reconcile_capture_provenance_after_recovery(
    snapshot: &mut SessionSnapshot,
    durable_frames: u64,
) -> Result<bool> {
    if snapshot.capture_provenance.is_empty() {
        // Backward-compatible legacy task: preserve its existing top-level
        // source declaration rather than inventing activation boundaries.
        return Ok(false);
    }
    validate_capture_provenance(snapshot, durable_frames, false)?;
    let last_end = snapshot
        .capture_provenance
        .last()
        .map_or(0, |span| span.end_sample);
    if last_end == durable_frames {
        validate_capture_provenance(snapshot, durable_frames, true)?;
        return Ok(false);
    }
    let current_source = capture_span_from_snapshot(snapshot, 0, 0);
    let last = snapshot
        .capture_provenance
        .last_mut()
        .context("采集来源区间缺失")?;
    if !same_capture_source(last, &current_source) {
        bail!("物理母轨尾部超出已记录区间，且无法安全匹配到最后一次采集配置");
    }
    last.end_sample = durable_frames;
    validate_capture_provenance(snapshot, durable_frames, true)?;
    Ok(true)
}

fn session_summary_value(snapshot: &SessionSnapshot) -> Value {
    json!({
        "schema_version": snapshot.schema_version,
        "journal_seq": snapshot.journal_seq,
        "session_id": snapshot.session_id,
        "script_name": snapshot.script_name,
        "status": snapshot.status,
        "device_name": snapshot.device_name,
        "device_id": snapshot.device_id,
        "input_sample_format": snapshot.input_sample_format,
        "capture_share_mode": snapshot.capture_share_mode,
        "capture_provenance": snapshot.capture_provenance,
        "audio_format": snapshot.audio_format,
        "storage_layout_version": snapshot.storage_layout_version,
        "segment_frames": snapshot.segment_frames,
        "input_discontinuity_count": snapshot.input_discontinuity_count,
        "input_discontinuity_silence_samples": snapshot.input_discontinuity_silence_samples,
        "silence_duration_ms": snapshot.silence_duration_ms,
        "silence_threshold_dbfs": snapshot.silence_threshold_dbfs,
        "silence_detector": snapshot.silence_detector,
        "vad_diagnostics": snapshot.vad_diagnostics,
        "started_at": snapshot.started_at,
        "updated_at": snapshot.updated_at,
    })
}

fn validate_snapshot_for_export(snapshot: &SessionSnapshot) -> Result<()> {
    if snapshot.status == "faulted" || snapshot.overflow_samples > 0 {
        bail!("录制存在写盘故障或音频队列溢出，请先检查原始母轨并修复中断任务。");
    }
    if snapshot.status != "stopped" {
        bail!("录制尚未安全结束，请先暂停或修复中断任务后再导出。")
    }
    validate_attempt_boundaries(snapshot, snapshot.committed_samples)?;
    validate_capture_provenance(snapshot, snapshot.committed_samples, true)?;
    for item in &snapshot.items {
        if item.status == "review" {
            bail!("条目 {} 存在待确认录音或需要重录，无法导出切片。", item.id);
        }
        if item.status == "accepted" && item.selected_attempt_id.is_none() {
            bail!(
                "条目 {} 已标记为确认，但没有当前使用录音，无法导出切片。",
                item.id
            );
        }
        if item.status == "skipped" && item.selected_attempt_id.is_some() {
            bail!(
                "条目 {} 已标记为跳过，但仍保留当前使用录音，无法导出切片。",
                item.id
            );
        }
        let Some(selected_id) = item.selected_attempt_id.as_deref() else {
            continue;
        };
        let attempt = item
            .attempts
            .iter()
            .find(|attempt| attempt.attempt_id == selected_id)
            .with_context(|| format!("条目 {} 的当前使用录音不存在，无法导出切片。", item.id))?;
        let outside_durable_audio = attempt.end_sample <= attempt.start_sample
            || attempt.start_sample > snapshot.committed_samples
            || attempt.recording_started_sample > snapshot.committed_samples
            || attempt.head_silence_armed_sample > snapshot.committed_samples
            || attempt.head_silence_passed_sample > snapshot.committed_samples
            || attempt.content_started_sample > snapshot.committed_samples
            || attempt.end_sample > snapshot.committed_samples;
        if matches!(attempt.status.as_str(), "interrupted" | "needs_rerecord")
            || outside_durable_audio
        {
            bail!(
                "条目 {} 的当前使用录音异常中断或样本边界越界，无法导出切片。",
                item.id
            );
        }
    }
    Ok(())
}

fn validate_snapshot_for_artifact(
    snapshot: &SessionSnapshot,
    artifact: Option<ExportArtifact>,
) -> Result<()> {
    if artifact.is_none() {
        return validate_snapshot_for_export(snapshot);
    }
    if snapshot.status != "stopped" && snapshot.status != "faulted" {
        bail!("录制尚未安全结束，请先暂停或修复中断任务后再导出。");
    }
    if artifact != Some(ExportArtifact::CutsZip) {
        // Raw full-track and diagnostic JSON exports remain available for a
        // faulted task. They preserve suspect metadata instead of pretending
        // it is safe enough to cut into sentence files.
        return Ok(());
    }
    validate_attempt_boundaries(snapshot, snapshot.committed_samples)?;
    validate_capture_provenance(snapshot, snapshot.committed_samples, true)?;
    if snapshot.status == "faulted" || snapshot.overflow_samples > 0 {
        bail!("异常任务修复并检查前不能导出分段 ZIP；可先导出原始整轨或时间戳 JSON。");
    }
    for item in &snapshot.items {
        if item.status == "review" {
            bail!("条目 {} 存在待确认录音或需要重录，无法导出切片。", item.id);
        }
        let Some(selected_id) = item.selected_attempt_id.as_deref() else {
            continue;
        };
        let attempt = item
            .attempts
            .iter()
            .find(|attempt| attempt.attempt_id == selected_id)
            .with_context(|| format!("条目 {} 的当前使用录音不存在，无法导出切片。", item.id))?;
        if matches!(attempt.status.as_str(), "interrupted" | "needs_rerecord")
            || attempt.end_sample <= attempt.start_sample
            || attempt.end_sample > snapshot.committed_samples
        {
            bail!("条目 {} 的当前使用录音不可用，无法导出切片。", item.id);
        }
    }
    Ok(())
}

fn validate_snapshot_for_cut_scope(snapshot: &SessionSnapshot, scope: ExportScope) -> Result<()> {
    if snapshot.status != "stopped" {
        bail!("录制尚未安全结束，请先暂停或修复中断任务后再导出。");
    }
    if snapshot.overflow_samples > 0 {
        bail!("异常任务修复并检查前不能导出分段 ZIP；可先导出原始整轨或时间戳 JSON。");
    }
    validate_snapshot_identifiers(snapshot)?;
    validate_attempt_boundaries(snapshot, snapshot.committed_samples)?;
    validate_capture_provenance(snapshot, snapshot.committed_samples, true)?;
    let mut safe_selected_count = 0usize;
    for item in &snapshot.items {
        if !matches!(
            item.status.as_str(),
            "pending" | "review" | "accepted" | "skipped"
        ) {
            bail!(
                "条目 {} 包含未知状态 {}，已按不可交付处理",
                item.id,
                item.status
            );
        }
        for attempt in &item.attempts {
            if !matches!(
                attempt.status.as_str(),
                "recorded" | "accepted" | "rejected_by_operator" | "interrupted" | "needs_rerecord"
            ) {
                bail!(
                    "条目 {} 的录音 {} 包含未知状态 {}",
                    item.id,
                    attempt.attempt_id,
                    attempt.status
                );
            }
            validate_attempt_quality_issues(attempt)?;
        }
        let selected = match item.selected_attempt_id.as_deref() {
            Some(id) => Some(
                item.attempts
                    .iter()
                    .find(|attempt| attempt.attempt_id == id)
                    .with_context(|| format!("条目 {} 的当前使用录音不存在", item.id))?,
            ),
            None => None,
        };
        if matches!(item.status.as_str(), "pending" | "skipped") && selected.is_some() {
            bail!("条目 {} 的状态与当前使用录音矛盾", item.id);
        }
        if item.status == "accepted" && selected.is_none() {
            bail!("条目 {} 已确认但没有当前使用录音", item.id);
        }
        if let Some(selected) = selected {
            if selected.status != "accepted" || !attempt_is_delivery_safe(snapshot, selected)? {
                bail!("条目 {} 的当前使用录音不可安全交付", item.id);
            }
            if item
                .attempts
                .iter()
                .filter(|attempt| attempt.status == "accepted")
                .count()
                != 1
            {
                bail!("条目 {} 同时存在多条已确认录音", item.id);
            }
            if item.status == "accepted" {
                safe_selected_count += 1;
            }
        }
        if item.status != "accepted"
            && selected.is_some_and(|attempt| attempt.status == "accepted")
            && item
                .attempts
                .last()
                .is_some_and(|attempt| attempt.status == "needs_rerecord")
        {
            bail!("条目 {} 保留原录音但条目状态不是 accepted", item.id);
        }
        if item.status == "review" {
            let has_recorded_candidate = item
                .attempts
                .iter()
                .any(|attempt| attempt.status == "recorded");
            let latest_needs_rerecord = item
                .attempts
                .last()
                .is_some_and(|attempt| attempt.status == "needs_rerecord");
            let valid_review_state = match selected {
                Some(_) => has_recorded_candidate && !latest_needs_rerecord,
                None => has_recorded_candidate || latest_needs_rerecord,
            };
            if !valid_review_state {
                bail!("条目 {} 的 review 状态缺少待确认录音或需重录记录", item.id);
            }
        }
        if scope == ExportScope::CompleteTask && item.status != "accepted" {
            bail!(
                "complete_task 要求每句都有已确认录音；条目 {} 当前为 {}",
                item.id,
                item.status
            );
        }
        if item.status == "accepted"
            && item
                .attempts
                .iter()
                .any(|attempt| attempt.status == "recorded")
        {
            bail!("条目 {} 已确认但仍有待决策录音", item.id);
        }
    }
    if safe_selected_count == 0 {
        bail!("当前任务没有可安全导出的已确认录音");
    }
    Ok(())
}

fn validate_snapshot_identifiers(snapshot: &SessionSnapshot) -> Result<()> {
    let mut item_ids = std::collections::HashSet::<&str>::new();
    for item in &snapshot.items {
        if item.id.trim().is_empty() || !item_ids.insert(item.id.as_str()) {
            bail!("录制任务包含空或重复的条目 ID，已按不可交付处理");
        }
        let mut attempt_ids = std::collections::HashSet::<&str>::new();
        for attempt in &item.attempts {
            if attempt.attempt_id.trim().is_empty()
                || !attempt_ids.insert(attempt.attempt_id.as_str())
            {
                bail!("条目 {} 包含空或重复的录音 ID", item.id);
            }
        }
    }
    Ok(())
}

fn cut_export_warning_codes(item: &ItemState, selected: &Attempt) -> Vec<&'static str> {
    let mut warnings = Vec::new();
    if selected.status == "accepted"
        && item.attempts.last().is_some_and(|candidate| {
            candidate.status == "needs_rerecord"
                && Some(candidate.attempt_id.as_str()) != item.selected_attempt_id.as_deref()
        })
    {
        warnings.push("retained_previous");
    }
    if selected.required_head_silence_samples > 0
        && selected.content_started_sample > 0
        && selected
            .content_started_sample
            .saturating_sub(selected.recording_started_sample)
            < selected.required_head_silence_samples
    {
        warnings.push("head_silence_short");
    }
    if selected.required_tail_silence_samples > 0
        && selected.tail_silence_samples < selected.required_tail_silence_samples
    {
        warnings.push("tail_silence_short");
    }
    warnings
}

fn cut_exclusion_reason(item: &ItemState) -> &'static str {
    match item.status.as_str() {
        "pending" => "unrecorded",
        "skipped" => "skipped",
        "review"
            if item
                .attempts
                .last()
                .is_some_and(|attempt| attempt.status == "needs_rerecord") =>
        {
            "rerecord_required"
        }
        "review" if item.selected_attempt_id.is_some() => "retake_review",
        "review" => "first_take_review",
        _ => "inconsistent",
    }
}

fn is_pristine_bootstrap(snapshot: &SessionSnapshot) -> bool {
    snapshot.journal_seq == 0
        && snapshot.captured_samples == 0
        && snapshot.committed_samples == 0
        && snapshot.overflow_samples == 0
        && snapshot
            .items
            .iter()
            .all(|item| item.attempts.is_empty() && item.selected_attempt_id.is_none())
}

fn read_journal(session_dir: &Path) -> Result<JournalLog> {
    let events_path = session_dir.join("metadata/events.jsonl");
    let metadata = match std::fs::symlink_metadata(&events_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(JournalLog {
                entries: Vec::new(),
                warnings: Vec::new(),
                truncate_to: None,
            });
        }
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > JOURNAL_MAX_BYTES
    {
        bail!("录制任务事件日志无效");
    }
    let source =
        std::fs::read(&events_path).with_context(|| format!("read {}", events_path.display()))?;
    let mut lines = Vec::<(usize, usize, &[u8])>::new();
    let mut offset = 0usize;
    for (line_index, line) in source.split(|byte| *byte == b'\n').enumerate() {
        let line_start = offset;
        offset = offset.saturating_add(line.len());
        if offset < source.len() && source[offset] == b'\n' {
            offset += 1;
        }
        if !line.iter().all(u8::is_ascii_whitespace) {
            lines.push((line_index, line_start, line));
        }
    }
    let mut entries = Vec::<Value>::with_capacity(lines.len());
    let mut warnings = Vec::<String>::new();
    let mut truncate_to = None::<u64>;
    for (position, (line_index, line_start, line)) in lines.iter().enumerate() {
        match parse_journal_entry(line) {
            Ok(value) => entries.push(value),
            Err(_) if position + 1 == lines.len() => {
                warnings.push("事件日志最后一行不完整，已忽略该尾行。".to_string());
                truncate_to = Some(u64::try_from(*line_start)?);
                continue;
            }
            Err(error) => {
                // Every sequenced event carries a full snapshot projection, so
                // a damaged older line must not hide a later recoverable one.
                // Keep the damage visible as a warning and let the next
                // successful persistence compact the journal back to one line.
                warnings.push(format!(
                    "事件日志第 {} 行损坏，已跳过：{error:#}",
                    line_index + 1
                ));
            }
        }
    }
    Ok(JournalLog {
        entries,
        warnings,
        truncate_to,
    })
}

fn repair_journal_tail(session_dir: &Path, journal: &JournalLog) -> Result<()> {
    let Some(valid_bytes) = journal.truncate_to else {
        return Ok(());
    };
    let events_path = session_dir.join("metadata/events.jsonl");
    let events = OpenOptions::new()
        .write(true)
        .open(&events_path)
        .with_context(|| format!("open {} for tail repair", events_path.display()))?;
    events
        .set_len(valid_bytes)
        .with_context(|| format!("truncate invalid tail in {}", events_path.display()))?;
    events
        .sync_all()
        .with_context(|| format!("sync repaired journal {}", events_path.display()))
}

fn parse_journal_entry(line: &[u8]) -> Result<Value> {
    let event: Value = serde_json::from_slice(line).context("invalid JSON")?;
    let object = event
        .as_object()
        .context("journal entry must be a JSON object")?;
    object
        .get("event")
        .and_then(Value::as_str)
        .filter(|kind| !kind.is_empty())
        .context("journal entry is missing its event name")?;
    if let Some(sequence) = object.get("journal_seq") {
        let sequence = sequence
            .as_u64()
            .filter(|sequence| *sequence > 0)
            .context("journal_seq must be a positive integer")?;
        let projection: SessionSnapshot = serde_json::from_value(
            object
                .get("snapshot")
                .cloned()
                .context("sequenced journal entry is missing its snapshot projection")?,
        )
        .context("invalid journal snapshot projection")?;
        if projection.journal_seq != sequence {
            bail!("journal entry sequence does not match its snapshot projection");
        }
    }
    Ok(event)
}

fn snapshot_candidate_paths(session_dir: &Path) -> Vec<(PathBuf, &'static str, u8)> {
    let final_path = session_dir.join("metadata/items.snapshot.json");
    let candidates = [
        (final_path.clone(), "final snapshot", 30),
        (final_path.with_extension("tmp"), "temporary snapshot", 20),
        (final_path.with_extension("prev"), "previous snapshot", 10),
        (final_path.with_extension("backup"), "backup snapshot", 9),
        (
            PathBuf::from(format!("{}.prev", final_path.display())),
            "previous snapshot",
            10,
        ),
        (
            PathBuf::from(format!("{}.backup", final_path.display())),
            "backup snapshot",
            9,
        ),
        (
            PathBuf::from(format!("{}.bak", final_path.display())),
            "backup snapshot",
            8,
        ),
    ];
    let mut unique = std::collections::HashSet::<PathBuf>::new();
    candidates
        .into_iter()
        .filter(|(path, _, _)| unique.insert(path.clone()))
        .collect()
}

fn read_snapshot_candidate(
    path: &Path,
    source: &str,
    priority: u8,
    ordinal: usize,
    warnings: &mut Vec<String>,
) -> Option<SnapshotCandidate> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            warnings.push(format!("无法检查 {source} {}: {error}", path.display()));
            return None;
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        warnings.push(format!(
            "{source} {} 不是普通文件，已忽略。",
            path.display()
        ));
        return None;
    }
    if metadata.len() > SNAPSHOT_MAX_BYTES {
        warnings.push(format!(
            "{source} {} 超过 {} MiB 安全上限，已忽略。",
            path.display(),
            SNAPSHOT_MAX_BYTES / 1024 / 1024
        ));
        return None;
    }
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            warnings.push(format!("无法读取 {source} {}: {error}", path.display()));
            return None;
        }
    };
    let snapshot: SessionSnapshot = match serde_json::from_slice(&bytes) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            warnings.push(format!("{source} {} 损坏，已忽略：{error}", path.display()));
            return None;
        }
    };
    if snapshot.schema_version != 1 || snapshot.session_id.trim().is_empty() {
        warnings.push(format!(
            "{source} {} 版本或录制 ID 无效，已忽略。",
            path.display()
        ));
        return None;
    }
    Some(SnapshotCandidate {
        snapshot,
        source: format!("{source} {}", path.display()),
        priority,
        ordinal,
    })
}

fn read_session_identity(session_dir: &Path, warnings: &mut Vec<String>) -> Option<String> {
    let path = session_dir.join("session.json");
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            warnings.push(format!("无法检查录制身份文件 {}: {error}", path.display()));
            return None;
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        warnings.push(format!(
            "录制身份文件 {} 不是普通文件，已忽略。",
            path.display()
        ));
        return None;
    }
    if metadata.len() > SESSION_IDENTITY_MAX_BYTES {
        warnings.push(format!(
            "录制身份文件 {} 超过安全上限，已忽略。",
            path.display()
        ));
        return None;
    }
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            warnings.push(format!("无法读取录制身份文件 {}: {error}", path.display()));
            return None;
        }
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            warnings.push(format!(
                "录制身份文件 {} 损坏，已忽略：{error}",
                path.display()
            ));
            return None;
        }
    };
    if value.get("schema_version").and_then(Value::as_u64) != Some(1) {
        warnings.push(format!(
            "录制身份文件 {} 版本无效，已忽略。",
            path.display()
        ));
        return None;
    }
    value
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|session_id| !session_id.trim().is_empty())
        .map(str::to_string)
}

#[cfg(test)]
fn load_recovery_snapshot(session_dir: &Path, journal: &mut JournalLog) -> Result<SessionSnapshot> {
    load_recovery_snapshot_for_session(session_dir, journal, None)
}

fn load_recovery_snapshot_for_session(
    session_dir: &Path,
    journal: &mut JournalLog,
    externally_expected_session_id: Option<&str>,
) -> Result<SessionSnapshot> {
    let mut candidates = Vec::<SnapshotCandidate>::new();
    for (ordinal, (path, source, priority)) in snapshot_candidate_paths(session_dir)
        .into_iter()
        .enumerate()
    {
        if let Some(candidate) =
            read_snapshot_candidate(&path, source, priority, ordinal, &mut journal.warnings)
        {
            candidates.push(candidate);
        }
    }

    let file_candidate_count = candidates.len();
    for (index, entry) in journal.entries.iter().enumerate() {
        let Some(sequence) = entry.get("journal_seq").and_then(Value::as_u64) else {
            continue;
        };
        let Some(projection) = entry.get("snapshot").cloned() else {
            continue;
        };
        let snapshot: SessionSnapshot = match serde_json::from_value(projection) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                journal.warnings.push(format!(
                    "事件日志第 {} 行快照无法解析，已忽略：{error}",
                    index + 1
                ));
                continue;
            }
        };
        if snapshot.schema_version != 1
            || snapshot.journal_seq != sequence
            || snapshot.session_id.trim().is_empty()
        {
            journal
                .warnings
                .push(format!("事件日志第 {} 行快照无效，已忽略。", index + 1));
            continue;
        }
        candidates.push(SnapshotCandidate {
            snapshot,
            source: format!("journal line {}", index + 1),
            priority: 40,
            ordinal: file_candidate_count + index,
        });
    }
    if candidates.is_empty() {
        bail!("录制任务没有可恢复的快照或事件投影");
    }

    let journal_identity = candidates
        .iter()
        .filter(|candidate| candidate.priority == 40)
        .max_by_key(|candidate| (candidate.snapshot.journal_seq, candidate.ordinal))
        .map(|candidate| candidate.snapshot.session_id.clone());
    let fallback_identity = candidates
        .iter()
        .max_by_key(|candidate| {
            (
                candidate.snapshot.journal_seq,
                candidate.priority,
                candidate.ordinal,
            )
        })
        .map(|candidate| candidate.snapshot.session_id.clone());
    let identity_file_session_id = read_session_identity(session_dir, &mut journal.warnings);
    let expected_session_id = if let Some(expected) = externally_expected_session_id {
        let expected = expected.trim();
        if expected.is_empty() {
            bail!("录制任务的预期身份为空");
        }
        if identity_file_session_id
            .as_deref()
            .is_some_and(|identity| identity != expected)
        {
            bail!("录制任务身份文件与预期任务不一致");
        }
        if let Some(conflict) = candidates
            .iter()
            .find(|candidate| candidate.snapshot.session_id != expected)
        {
            bail!(
                "{} 属于其他录制 {} ，已阻止继续写入。",
                conflict.source,
                conflict.snapshot.session_id
            );
        }
        if !candidates
            .iter()
            .any(|candidate| candidate.snapshot.session_id == expected)
        {
            bail!("录制任务没有与预期身份匹配的可恢复投影");
        }
        expected.to_string()
    } else {
        identity_file_session_id
            .or(journal_identity)
            .or(fallback_identity)
            .context("无法确定录制任务身份")?
    };

    let mut matching = Vec::<SnapshotCandidate>::new();
    for candidate in candidates {
        if candidate.snapshot.session_id == expected_session_id {
            matching.push(candidate);
        } else {
            journal.warnings.push(format!(
                "{} 属于其他录制 {} ，已忽略。",
                candidate.source, candidate.snapshot.session_id
            ));
        }
    }
    let selected = matching
        .iter()
        .max_by_key(|candidate| {
            (
                candidate.snapshot.journal_seq,
                candidate.priority,
                candidate.ordinal,
            )
        })
        .cloned()
        .context("录制任务没有匹配身份的可恢复快照")?;

    let mut seen_sequences = std::collections::HashSet::<u64>::new();
    let mut previous_sequence = None::<u64>;
    for entry in &journal.entries {
        let Some(sequence) = entry.get("journal_seq").and_then(Value::as_u64) else {
            continue;
        };
        let same_session = entry
            .get("snapshot")
            .and_then(|snapshot| snapshot.get("session_id"))
            .and_then(Value::as_str)
            == Some(expected_session_id.as_str());
        if !same_session {
            continue;
        }
        if !seen_sequences.insert(sequence) {
            journal.warnings.push(format!(
                "事件日志包含重复序号 {sequence}，已使用最后一个完整投影。"
            ));
        }
        if let Some(previous) = previous_sequence
            && sequence != previous.saturating_add(1)
        {
            journal.warnings.push(format!(
                "事件日志序号从 {previous} 跳到 {sequence}，已按最新完整投影恢复。"
            ));
        }
        previous_sequence = Some(sequence);
    }
    // Journal projections outrank the replaceable final snapshot at the same
    // sequence. That is the normal post-compaction path: do not treat it as
    // recovery. Warn only when the final file is missing, unreadable, or older.
    let latest_final_snapshot_seq = matching
        .iter()
        .filter(|candidate| candidate.source.starts_with("final snapshot"))
        .map(|candidate| candidate.snapshot.journal_seq)
        .max();
    if latest_final_snapshot_seq.is_none_or(|seq| seq < selected.snapshot.journal_seq) {
        journal.warnings.push(format!(
            "最终快照不可用或不是最新，已从 {} 恢复 journal_seq {}。",
            selected.source, selected.snapshot.journal_seq
        ));
    }
    Ok(selected.snapshot)
}

#[cfg(test)]
fn replay_snapshot_from_journal(
    snapshot: &mut SessionSnapshot,
    journal: &JournalLog,
) -> Result<()> {
    let original_session_id = snapshot.session_id.clone();
    let mut latest_projection = snapshot.clone();
    let mut latest_ordinal = 0usize;
    for (index, entry) in journal.entries.iter().enumerate() {
        let Some(sequence) = entry.get("journal_seq").and_then(Value::as_u64) else {
            continue;
        };
        let Some(value) = entry.get("snapshot").cloned() else {
            continue;
        };
        let projection: SessionSnapshot = match serde_json::from_value(value) {
            Ok(projection) => projection,
            Err(_) => continue,
        };
        if projection.schema_version != 1
            || projection.session_id != original_session_id
            || projection.journal_seq != sequence
        {
            continue;
        }
        if sequence > latest_projection.journal_seq
            || (sequence == latest_projection.journal_seq && index >= latest_ordinal)
        {
            latest_projection = projection;
            latest_ordinal = index;
        }
    }
    *snapshot = latest_projection;
    Ok(())
}

fn recover_interrupted_attempts(
    journal: &JournalLog,
    snapshot: &mut SessionSnapshot,
    durable_frames: u64,
) -> Result<Vec<String>> {
    let mut open_attempts = HashMap::<String, InterruptedAttemptStart>::new();
    let mut warnings = Vec::<String>::new();
    for (index, event) in journal.entries.iter().enumerate() {
        let kind = event
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = event.get("payload").unwrap_or(&Value::Null);
        match kind {
            "attempt_started" => {
                let Some(attempt_id) = payload.get("attempt_id").and_then(Value::as_str) else {
                    continue;
                };
                let Some(item_id) = payload.get("item_id").and_then(Value::as_str) else {
                    continue;
                };
                open_attempts.insert(
                    attempt_id.to_string(),
                    InterruptedAttemptStart {
                        item_id: item_id.to_string(),
                        attempt_id: attempt_id.to_string(),
                        start_sample: payload
                            .get("start_sample")
                            .and_then(Value::as_u64)
                            .unwrap_or(durable_frames),
                        recording_started_sample: payload
                            .get("recording_started_sample")
                            .and_then(Value::as_u64)
                            .unwrap_or(durable_frames),
                        head_silence_armed_sample: payload
                            .get("head_silence_armed_sample")
                            .and_then(Value::as_u64)
                            .or_else(|| {
                                payload
                                    .get("recording_started_sample")
                                    .and_then(Value::as_u64)
                            })
                            .unwrap_or(durable_frames),
                        required_head_silence_samples: payload
                            .get("required_head_silence_samples")
                            .or_else(|| payload.get("head_silence_required_samples"))
                            .and_then(Value::as_u64)
                            .unwrap_or_default(),
                        created_at: event
                            .get("at")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        event_index: index,
                    },
                );
            }
            "attempt_stopped" => {
                if let Some(attempt_id) = payload
                    .get("attempt")
                    .and_then(|attempt| attempt.get("attempt_id"))
                    .and_then(Value::as_str)
                {
                    open_attempts.remove(attempt_id);
                }
            }
            "attempt_discarded" => {
                if let Some(attempt_id) = payload.get("attempt_id").and_then(Value::as_str) {
                    open_attempts.remove(attempt_id);
                }
            }
            _ => {}
        }
    }
    let existing_attempt_ids = snapshot
        .items
        .iter()
        .flat_map(|item| {
            item.attempts
                .iter()
                .map(|attempt| attempt.attempt_id.clone())
        })
        .collect::<std::collections::HashSet<_>>();
    let mut interrupted = open_attempts
        .into_values()
        .filter(|attempt| !existing_attempt_ids.contains(&attempt.attempt_id))
        .collect::<Vec<_>>();
    interrupted.sort_by_key(|attempt| attempt.event_index);
    for active in interrupted {
        let Some(item) = snapshot
            .items
            .iter_mut()
            .find(|item| item.id == active.item_id)
        else {
            warnings.push(format!(
                "忽略了未知条目 {} 的未结束录音 {}。",
                active.item_id, active.attempt_id
            ));
            continue;
        };
        // Interrupted/diagnostic takes preserve the raw operator recording
        // range. Older journals could carry a pre-arm `start_sample`; never
        // publish a recovered attempt whose clip starts before the recording
        // actually began.
        let recording_started_sample = active.recording_started_sample.min(durable_frames);
        let start_sample = active
            .start_sample
            .max(recording_started_sample)
            .min(durable_frames);
        item.attempts.push(Attempt {
            attempt_id: active.attempt_id.clone(),
            start_sample,
            recording_started_sample,
            head_silence_armed_sample: active.head_silence_armed_sample.min(durable_frames),
            head_silence_passed_sample: 0,
            required_head_silence_samples: active.required_head_silence_samples,
            content_started_sample: 0,
            end_sample: durable_frames,
            forced_without_tail_silence: false,
            tail_silence_samples: 0,
            required_tail_silence_samples: 0,
            status: "interrupted".to_string(),
            created_at: active.created_at,
            quality_issues: Vec::new(),
        });
        warnings.push(format!(
            "{} 的录音 {} 在上次退出时未完成，已保留母轨并标记为不可交付。",
            active.item_id, active.attempt_id
        ));
    }
    Ok(warnings)
}

fn mark_active_attempt_interrupted(
    snapshot: &mut SessionSnapshot,
    active: &ActiveAttempt,
    durable_end: u64,
    head_silence_passed_sample: u64,
    required_head_silence_samples: u64,
    content_started_sample: u64,
) -> Result<Attempt> {
    let item = snapshot
        .items
        .iter_mut()
        .find(|item| item.id == active.item_id)
        .ok_or_else(|| anyhow!("item disappeared while interrupting recording"))?;
    if let Some(existing) = item
        .attempts
        .iter()
        .find(|attempt| attempt.attempt_id == active.attempt_id)
    {
        return Ok(existing.clone());
    }
    let head_silence_passed_sample =
        if head_silence_passed_sample > 0 && head_silence_passed_sample <= durable_end {
            head_silence_passed_sample
        } else {
            0
        };
    let content_started_sample = if content_started_sample > 0
        && content_started_sample <= durable_end
        && (head_silence_passed_sample == 0 || content_started_sample >= head_silence_passed_sample)
    {
        content_started_sample
    } else {
        0
    };
    let attempt = Attempt {
        attempt_id: active.attempt_id.clone(),
        start_sample: active.start_sample.min(durable_end),
        recording_started_sample: active.recording_started_sample.min(durable_end),
        head_silence_armed_sample: active.recording_started_sample.min(durable_end),
        head_silence_passed_sample,
        required_head_silence_samples,
        content_started_sample,
        end_sample: durable_end,
        forced_without_tail_silence: false,
        tail_silence_samples: 0,
        required_tail_silence_samples: 0,
        status: "interrupted".to_string(),
        created_at: Utc::now().to_rfc3339(),
        quality_issues: Vec::new(),
    };
    item.attempts.push(attempt.clone());
    Ok(attempt)
}

impl RecordingSession {
    fn required_silence_samples(&self) -> u64 {
        u64::from(self.snapshot.audio_format.sample_rate)
            .saturating_mul(u64::from(self.snapshot.silence_duration_ms))
            / 1_000
    }

    fn arm_attempt_analysis(&self) -> Result<u64> {
        // Establish a clean worker generation before the click boundary. Any
        // audio processed while the worker resets belongs to idle room tone,
        // not to the take that is about to be armed.
        self.reset_vad_analysis()?;
        // Serialize the click boundary with callback analysis. A callback may
        // already have reserved and queued a block; loading `captured` while
        // holding this guard puts that complete block before the click, so its
        // silence can never satisfy the newly armed take.
        let analysis_write = begin_analysis_write(&self.analysis_epoch);
        let armed_sample = self.captured.load(Ordering::Acquire);
        self.head_silence
            .required_samples
            .store(self.required_silence_samples(), Ordering::Release);
        self.attempt_signal_start_sample.store(0, Ordering::Release);
        self.last_signal_sample.store(0, Ordering::Release);
        self.head_silence.arm(armed_sample);
        drop(analysis_write);
        Ok(armed_sample)
    }

    fn apply_silence_settings(
        &self,
        threshold_dbfs: f32,
        silence_duration_ms: u32,
    ) -> (u64, &'static str) {
        // Serialize the new threshold and the affected silence accumulators
        // with callback analysis. This makes the operator-visible application
        // boundary deterministic without touching any audio already written.
        let analysis_write = begin_analysis_write(&self.analysis_epoch);
        let boundary = self.analyzed_samples.load(Ordering::Acquire);
        self.silence_threshold_bits
            .store(threshold_dbfs.to_bits(), Ordering::Release);
        self.silence_duration_ms
            .store(silence_duration_ms, Ordering::Release);
        let required_samples = u64::from(self.snapshot.audio_format.sample_rate)
            .saturating_mul(u64::from(silence_duration_ms))
            / 1_000;
        self.silence_samples.store(0, Ordering::Release);
        let phase = self.head_silence.phase.load(Ordering::Acquire);
        let reset_kind = match phase {
            HEAD_SILENCE_WAITING | HEAD_SILENCE_PASSED => {
                self.head_silence
                    .required_samples
                    .store(required_samples, Ordering::Release);
                self.attempt_signal_start_sample.store(0, Ordering::Release);
                self.last_signal_sample.store(0, Ordering::Release);
                self.head_silence.arm(boundary);
                "head_silence"
            }
            HEAD_SILENCE_SPEECH_STARTED => {
                // Preserve the established speech boundary, but require a full
                // new tail-silence interval under the adjusted settings. Keep
                // the already-proven head-silence requirement as history.
                self.last_signal_sample.store(boundary, Ordering::Release);
                "tail_silence"
            }
            _ => {
                self.head_silence
                    .required_samples
                    .store(required_samples, Ordering::Release);
                "idle"
            }
        };
        drop(analysis_write);
        (boundary, reset_kind)
    }

    fn disarm_attempt_analysis(&self) {
        let analysis_write = begin_analysis_write(&self.analysis_epoch);
        self.head_silence.disarm();
        self.attempt_signal_start_sample.store(0, Ordering::Release);
        self.last_signal_sample.store(0, Ordering::Release);
        drop(analysis_write);
    }

    fn reset_vad_analysis(&self) -> Result<()> {
        let Some(tx) = self.vad_tx.as_ref() else {
            return Ok(());
        };
        if self.silence_analysis.detector_kind.load(Ordering::Acquire) != DETECTOR_VAD {
            return Ok(());
        }
        let generation = self
            .silence_analysis
            .generation
            .fetch_add(1, Ordering::AcqRel)
            + 1;
        let boundary = self.captured.load(Ordering::Acquire);
        let (done_tx, done_rx) = bounded(1);
        if tx
            .send_timeout(
                VadControlMessage::Reset {
                    generation,
                    boundary,
                    done: done_tx,
                },
                CAPTURE_ANALYSIS_TIMEOUT,
            )
            .is_err()
        {
            self.silence_analysis.telemetry.latch_issue(
                generation,
                VAD_ISSUE_WORKER_DISCONNECTED,
                boundary,
                boundary,
            );
            bail!("speech VAD reset control queue is unavailable");
        }
        match done_rx.recv_timeout(CAPTURE_ANALYSIS_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(message)) => {
                self.silence_analysis.telemetry.latch_issue(
                    generation,
                    VAD_ISSUE_WORKER_DISCONNECTED,
                    boundary,
                    boundary,
                );
                Err(anyhow!(message).context("speech VAD reset was rejected"))
            }
            Err(error) => {
                self.silence_analysis.telemetry.latch_issue(
                    generation,
                    VAD_ISSUE_WORKER_DISCONNECTED,
                    boundary,
                    boundary,
                );
                Err(anyhow!(error).context("speech VAD reset did not acknowledge before recording"))
            }
        }
    }

    fn flush_vad_analysis(&self, target_sample: u64) -> VadFlushOutcome {
        let Some(tx) = self.vad_tx.as_ref() else {
            return VadFlushOutcome::Complete;
        };
        if self.silence_analysis.detector_kind.load(Ordering::Acquire) != DETECTOR_VAD {
            return VadFlushOutcome::Complete;
        }
        let (done_tx, done_rx) = bounded(1);
        let generation = self.silence_analysis.generation.load(Ordering::Acquire);
        let deadline = Instant::now() + CAPTURE_ANALYSIS_TIMEOUT;
        if tx
            .send_timeout(
                VadControlMessage::Flush {
                    generation,
                    target_sample,
                    deadline,
                    done: done_tx,
                },
                CAPTURE_ANALYSIS_TIMEOUT,
            )
            .is_err()
        {
            self.silence_analysis.telemetry.latch_issue(
                generation,
                VAD_ISSUE_WORKER_DISCONNECTED,
                self.analyzed_samples.load(Ordering::Acquire),
                target_sample,
            );
            return VadFlushOutcome::Degraded(VAD_ISSUE_WORKER_DISCONNECTED);
        }
        match done_rx.recv_timeout(CAPTURE_ANALYSIS_TIMEOUT) {
            Ok(VadFlushOutcome::Timeout) | Err(_) => {
                self.silence_analysis.telemetry.latch_issue(
                    generation,
                    VAD_ISSUE_FLUSH_TIMEOUT,
                    self.analyzed_samples.load(Ordering::Acquire),
                    target_sample,
                );
                VadFlushOutcome::Degraded(VAD_ISSUE_FLUSH_TIMEOUT)
            }
            Ok(outcome) => outcome,
        }
    }

    fn shutdown_vad_analysis_until(&mut self, deadline: Instant) -> bool {
        if self.vad_join.as_ref().is_some_and(JoinHandle::is_finished) {
            let join = self
                .vad_join
                .take()
                .expect("finished VAD worker disappeared");
            self.vad_tx.take();
            return join.join().is_ok();
        }
        let Some(tx) = self.vad_tx.as_ref() else {
            return self.vad_join.is_none();
        };
        let (done_tx, done_rx) = bounded(1);
        let remaining = deadline.saturating_duration_since(Instant::now());
        if tx
            .send_timeout(VadControlMessage::Shutdown { done: done_tx }, remaining)
            .is_err()
        {
            return false;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if done_rx.recv_timeout(remaining).is_err() {
            return false;
        }
        while self
            .vad_join
            .as_ref()
            .is_some_and(|join| !join.is_finished())
        {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(1));
        }
        let joined = self.vad_join.take().is_none_or(|join| join.join().is_ok());
        self.vad_tx.take();
        joined
    }

    fn finish_vad_degraded_attempt(
        &mut self,
        active: &ActiveAttempt,
        requested_boundary: u64,
        detector_generation: u64,
        issue_code: u32,
    ) -> Result<Attempt> {
        self.wait_until_committed(requested_boundary)?;
        let (_, gap_start, gap_end) = self
            .silence_analysis
            .telemetry
            .issue_for_generation(detector_generation)
            .unwrap_or((issue_code, requested_boundary, requested_boundary));
        let end_sample = requested_boundary.max(active.recording_started_sample);
        let issue_start = gap_start.clamp(active.recording_started_sample, end_sample);
        let issue_end = gap_end.max(gap_start).clamp(issue_start, end_sample);
        let issue = AttemptQualityIssue {
            code: vad_issue_code_name(issue_code).to_string(),
            start_sample: Some(issue_start),
            end_sample: Some(issue_end),
            detector_generation: Some(detector_generation),
        };
        let attempt = Attempt {
            attempt_id: active.attempt_id.clone(),
            start_sample: active.recording_started_sample.min(end_sample),
            recording_started_sample: active.recording_started_sample.min(end_sample),
            head_silence_armed_sample: self
                .head_silence
                .armed_sample
                .load(Ordering::Acquire)
                .min(end_sample),
            head_silence_passed_sample: self
                .head_silence
                .passed_sample
                .load(Ordering::Acquire)
                .min(end_sample),
            required_head_silence_samples: self.head_silence.required_samples(),
            content_started_sample: self
                .attempt_signal_start_sample
                .load(Ordering::Acquire)
                .min(end_sample),
            end_sample,
            forced_without_tail_silence: false,
            tail_silence_samples: 0,
            required_tail_silence_samples: self.required_silence_samples(),
            status: "needs_rerecord".to_string(),
            created_at: Utc::now().to_rfc3339(),
            quality_issues: vec![issue],
        };
        let item = self
            .snapshot
            .items
            .iter_mut()
            .find(|item| item.id == active.item_id)
            .ok_or_else(|| anyhow!("item disappeared while recording"))?;
        let has_accepted_selection =
            item.selected_attempt_id
                .as_deref()
                .is_some_and(|selected_id| {
                    item.attempts.iter().any(|previous| {
                        previous.attempt_id == selected_id
                            && previous.status == "accepted"
                            && previous.end_sample > previous.start_sample
                            && previous.quality_issues.is_empty()
                    })
                });
        item.status = if has_accepted_selection {
            "accepted".to_string()
        } else {
            "review".to_string()
        };
        if !has_accepted_selection {
            item.selected_attempt_id = None;
        }
        item.attempts.push(attempt.clone());
        self.active_attempt = None;
        self.persist(
            "attempt_stopped",
            json!({
                "item_id": active.item_id,
                "attempt": &attempt,
                "forced": false,
                "auto_selected": false,
                "vad_degraded": true,
                "quality_issue": vad_issue_code_name(issue_code),
            }),
        )?;
        self.disarm_attempt_analysis();
        Ok(attempt)
    }

    fn interrupt_attempt(
        &mut self,
        active: &ActiveAttempt,
        durable_end: u64,
        head_silence_passed_sample: u64,
        required_head_silence_samples: u64,
        content_started_sample: u64,
        reason: &str,
    ) -> Result<Attempt> {
        let attempt = mark_active_attempt_interrupted(
            &mut self.snapshot,
            active,
            durable_end,
            head_silence_passed_sample,
            required_head_silence_samples,
            content_started_sample,
        )?;
        self.persist(
            "attempt_interrupted",
            json!({
                "item_id": &active.item_id,
                "attempt": &attempt,
                "reason": reason,
            }),
        )?;
        // Clear the in-memory mutation only after the journal projection is
        // durable. If metadata persistence fails, fault sealing can retry the
        // same active range without losing its identity.
        self.active_attempt = None;
        self.disarm_attempt_analysis();
        Ok(attempt)
    }

    fn active_attempt_analysis_value(&self) -> Value {
        let phase = self.head_silence.phase.load(Ordering::Acquire);
        json!({
            "head_silence_phase": head_silence_phase_name(phase),
            "head_silence_armed_sample": self.head_silence.armed_sample.load(Ordering::Acquire),
            "head_silence_progress_samples": self.head_silence
                .progress_samples.load(Ordering::Acquire)
                .min(self.head_silence.required_samples()),
            "required_head_silence_samples": self.head_silence.required_samples(),
            "head_silence_passed_sample": self.head_silence.passed_sample.load(Ordering::Acquire),
            "content_started_sample": self.attempt_signal_start_sample.load(Ordering::Acquire),
        })
    }

    fn wait_for_analysis_snapshot(&self, requested: u64) -> Result<CaptureAnalysisSnapshot> {
        let deadline = Instant::now() + CAPTURE_ANALYSIS_TIMEOUT;
        loop {
            let first_epoch = self.analysis_epoch.load(Ordering::Acquire);
            if first_epoch & 1 != 0 {
                if Instant::now() >= deadline {
                    bail!("音频信号分析未及时完成停止边界快照；当前句仍保持录制状态，请稍后重试");
                }
                thread::sleep(Duration::from_millis(1));
                continue;
            }
            let analyzed = self.analyzed_samples.load(Ordering::Acquire);
            let head_silence_phase = self.head_silence.phase.load(Ordering::Acquire);
            let head_silence_armed_sample = self.head_silence.armed_sample.load(Ordering::Acquire);
            let head_silence_progress_samples =
                self.head_silence.progress_samples.load(Ordering::Acquire);
            let head_silence_passed_sample =
                self.head_silence.passed_sample.load(Ordering::Acquire);
            let content_started_sample = self.attempt_signal_start_sample.load(Ordering::Acquire);
            let last_signal_sample = self.last_signal_sample.load(Ordering::Acquire);
            let second_epoch = self.analysis_epoch.load(Ordering::Acquire);
            if first_epoch == second_epoch && second_epoch & 1 == 0 && analyzed >= requested {
                return Ok(CaptureAnalysisSnapshot {
                    boundary: analyzed,
                    head_silence_phase,
                    head_silence_armed_sample,
                    head_silence_progress_samples,
                    head_silence_passed_sample,
                    content_started_sample,
                    last_signal_sample,
                });
            }
            if self.faulted.load(Ordering::Acquire) {
                bail!(
                    "音频采集在信号分析到达停止边界前发生故障：目标 {requested}，已分析 {analyzed}"
                );
            }
            if Instant::now() >= deadline {
                bail!(
                    "音频信号分析未及时到达停止边界：目标 {requested}，已分析 {analyzed}；当前句仍保持录制状态，请稍后重试"
                );
            }
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn checkpoint(&mut self) -> Result<u64> {
        let (reply_tx, reply_rx) = bounded(1);
        self.writer_tx
            .send(WriterMessage::Checkpoint(reply_tx))
            .context("audio writer is unavailable")?;
        let committed = reply_rx
            .recv_timeout(WRITER_CHECKPOINT_TIMEOUT)
            .context("audio writer checkpoint timed out")?
            .map_err(|message| anyhow!(message))?;
        self.committed.store(committed, Ordering::Release);
        Ok(committed)
    }

    fn render_range(
        &mut self,
        destination: &Path,
        start_frame: u64,
        end_frame: u64,
    ) -> Result<u64> {
        let (reply_tx, reply_rx) = bounded(1);
        self.writer_tx
            .send(WriterMessage::ExportRange {
                destination: destination.to_path_buf(),
                start_frame,
                end_frame,
                reply: reply_tx,
            })
            .context("audio writer is unavailable")?;
        let frames = reply_rx
            .recv_timeout(PREVIEW_RENDER_TIMEOUT)
            .context("audio preview render timed out")?
            .map_err(|message| anyhow!(message))?;
        Ok(frames)
    }

    fn waveform_range(&mut self, start_frame: u64, end_frame: u64) -> Result<Vec<[f32; 2]>> {
        let (reply_tx, reply_rx) = bounded(1);
        self.writer_tx
            .send(WriterMessage::WaveformRange {
                start_frame,
                end_frame,
                reply: reply_tx,
            })
            .context("audio writer is unavailable")?;
        reply_rx
            .recv_timeout(WAVEFORM_RENDER_TIMEOUT)
            .context("audio waveform render timed out")?
            .map_err(|message| anyhow!(message))
    }

    fn wait_until_committed(&mut self, target: u64) -> Result<()> {
        let deadline = Instant::now() + WRITER_COMMIT_DEADLINE;
        loop {
            let committed = self.checkpoint()?;
            if committed >= target {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!(
                    "audio writer did not commit samples through {target}; committed {committed}"
                );
            }
            thread::sleep(Duration::from_millis(15));
        }
    }

    fn live_snapshot(&self) -> SessionSnapshot {
        let mut snapshot = self.snapshot.clone();
        snapshot.captured_samples = self.captured.load(Ordering::Acquire);
        let committed_samples = self.committed.load(Ordering::Acquire);
        snapshot.committed_samples = committed_samples;
        if let Some(active_span) = snapshot.capture_provenance.last_mut()
            && committed_samples >= active_span.start_sample
        {
            active_span.end_sample = committed_samples;
        }
        snapshot.overflow_samples = self.overflow.load(Ordering::Acquire);
        snapshot.input_discontinuity_count = self
            .capture_recovery
            .discontinuities
            .load(Ordering::Acquire);
        snapshot.input_discontinuity_silence_samples = self
            .capture_recovery
            .inserted_silence_frames
            .load(Ordering::Acquire);
        if snapshot.silence_detector == SilenceDetector::Vad || snapshot.vad_diagnostics.is_some() {
            snapshot.vad_diagnostics = Some(self.silence_analysis.diagnostics());
        }
        snapshot.updated_at = Utc::now().to_rfc3339();
        snapshot
    }

    fn ensure_metadata_mutation_allowed(&self) -> Result<()> {
        if let Some(fault) = &self.metadata_fault {
            bail!("录制元数据已进入保护状态，禁止继续修改：{fault}。请结束录制并保留原始母轨。");
        }
        Ok(())
    }

    fn ensure_delivery_mutation_allowed(&self) -> Result<()> {
        self.ensure_metadata_mutation_allowed()?;
        if self.faulted.load(Ordering::Acquire) || self.overflow.load(Ordering::Acquire) > 0 {
            bail!(
                "音频采集已发生故障或数据溢出，禁止确认或跳过录音条目；请安全结束并保留原始母轨。"
            );
        }
        Ok(())
    }

    /// Makes bounded progress toward stopping every capture resource. Handles
    /// are taken only after their threads report completion; a timeout leaves
    /// the handle and task lock in this session so a later stop can retry.
    fn progress_capture_shutdown_with_timeout(
        &mut self,
        timeout: Duration,
    ) -> ActivationCleanupReport {
        let deadline = Instant::now() + timeout;
        let mut warnings = Vec::<String>::new();
        // A deliberate pause/drop is not a capture stall. Disarm before asking
        // the backend to stop so the telemetry supervisor cannot race a normal
        // safe-stop at the watchdog boundary.
        self.capture_watchdog_armed.store(false, Ordering::Release);
        if let Some(stream) = self.stream.take() {
            if !self.stream_reaper.retire(stream) {
                warnings.push(
                    "audio stream shutdown worker was unavailable; the stream handle was retained outside the protocol thread"
                        .to_string(),
                );
                self.faulted.store(true, Ordering::Release);
            }
        } else {
            // Let a pre-created but unused worker exit immediately (for
            // example when activation failed before build_input_stream).
            self.stream_reaper.close_input();
        }
        self.telemetry_stop.store(true, Ordering::Release);
        let telemetry_joined = match self.telemetry_join.as_ref() {
            None => true,
            Some(join) if wait_for_thread_until(join, deadline) => {
                let join = self
                    .telemetry_join
                    .take()
                    .expect("finished telemetry handle disappeared");
                if join.join().is_err() {
                    warnings.push("telemetry thread panicked while stopping".to_string());
                }
                true
            }
            Some(_) => {
                warnings.push(
                    "telemetry thread is still stopping; its handle was retained".to_string(),
                );
                false
            }
        };
        let capture_watchdog_joined = match self.capture_watchdog_join.as_ref() {
            None => true,
            Some(join) if wait_for_thread_until(join, deadline) => {
                let join = self
                    .capture_watchdog_join
                    .take()
                    .expect("finished capture watchdog handle disappeared");
                if join.join().is_err() {
                    warnings.push("capture watchdog thread panicked while stopping".to_string());
                    self.faulted.store(true, Ordering::Release);
                }
                true
            }
            Some(_) => {
                warnings.push(
                    "capture watchdog thread is still stopping; its handle was retained"
                        .to_string(),
                );
                false
            }
        };

        // Close the callback-entry gate before measuring the accepted timeline.
        // A callback already inside conversion may still own a lease. Do not
        // put Stop into the channel until that finite set of callbacks drains.
        let callback_gate_drained = self.writer_queue.close_and_wait_until(deadline);
        if !callback_gate_drained {
            warnings
                .push("audio callback gate is still draining; the writer was retained".to_string());
        }
        let captured = self.captured.load(Ordering::Acquire);

        if callback_gate_drained && !self.stop_requested {
            let (reply_tx, reply_rx) = bounded(1);
            self.stop_requested = true;
            match self.writer_tx.send(WriterMessage::Stop(reply_tx)) {
                Ok(()) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match reply_rx.recv_timeout(remaining) {
                        Ok(Ok(value)) => {
                            // Never let a stale pre-Stop value overwrite a
                            // later durable watermark published by the writer.
                            self.committed.fetch_max(value, Ordering::AcqRel);
                        }
                        Ok(Err(message)) => {
                            warnings.push(format!("audio writer could not finalize: {message}"));
                            self.faulted.store(true, Ordering::Release);
                        }
                        Err(error) => warnings.push(format!(
                            "audio writer is still finalizing; Stop reply was retained by the writer: {error}"
                        )),
                    }
                }
                Err(error) => warnings.push(format!(
                    "audio writer was unavailable when Stop was requested: {error}"
                )),
            }
        }

        let writer_joined = match self.writer_join.as_ref() {
            None => true,
            Some(join) if wait_for_thread_until(join, deadline) => {
                let join = self
                    .writer_join
                    .take()
                    .expect("finished writer handle disappeared");
                if join.join().is_err() {
                    warnings.push("audio writer panicked while stopping".to_string());
                    self.faulted.store(true, Ordering::Release);
                }
                true
            }
            Some(_) => {
                warnings.push("audio writer is still sealing; its handle was retained".to_string());
                false
            }
        };
        // VAD is advisory; the master writer is authoritative. Never spend the
        // shared shutdown budget waiting for analysis before the accepted PCM
        // timeline has been drained and durably finalized.
        let vad_joined = self.shutdown_vad_analysis_until(deadline);
        if !vad_joined {
            warnings.push(
                "speech VAD analysis worker is still stopping; its handle was retained".to_string(),
            );
        }
        let stream_reaper_joined = match self.stream_reaper.finish_until(deadline) {
            DropReaperProgress::Joined => true,
            DropReaperProgress::Pending => {
                warnings.push(
                    "audio stream backend is still stopping; its shutdown handle was retained"
                        .to_string(),
                );
                false
            }
            DropReaperProgress::Failed => {
                warnings.push(
                    "audio stream shutdown worker failed; the session remains locked for manual recovery"
                        .to_string(),
                );
                self.faulted.store(true, Ordering::Release);
                false
            }
        };
        self.stream_reaper.drain_warnings(&mut warnings);
        let capture_resources_joined = callback_gate_drained
            && stream_reaper_joined
            && vad_joined
            && telemetry_joined
            && capture_watchdog_joined
            && writer_joined;
        self.capture_stopped = capture_resources_joined;
        // Reload only after a finished writer has been joined. The writer owns
        // this atomic and may advance it after the first Stop wait times out.
        let committed_samples = self.committed.load(Ordering::Acquire);
        let overflow_samples = self.overflow.load(Ordering::Acquire);
        let audio_safe = capture_resources_joined
            && !self.faulted.load(Ordering::Acquire)
            && overflow_samples == 0
            && committed_samples == captured;
        ActivationCleanupReport {
            warnings,
            capture_resources_joined,
            audio_safe,
            captured_samples: captured,
            committed_samples,
        }
    }

    #[cfg(test)]
    fn cleanup_after_activation_failure(&mut self) -> ActivationCleanupReport {
        self.progress_capture_shutdown_with_timeout(CAPTURE_SHUTDOWN_TIMEOUT)
    }

    fn cleanup_after_activation_failure_with_timeout(
        &mut self,
        timeout: Duration,
    ) -> ActivationCleanupReport {
        self.progress_capture_shutdown_with_timeout(timeout)
    }

    fn persist_activation_failure(
        &mut self,
        stage: &str,
        reason: &str,
        cleanup: &ActivationCleanupReport,
    ) -> Result<()> {
        let status = if !cleanup.capture_resources_joined {
            "stopping"
        } else if cleanup.audio_safe {
            "stopped"
        } else {
            if !persist_audio_fault_marker_fail_closed(
                &self.session_dir,
                &format!("recording activation failed during {stage}: {reason}"),
                cleanup.committed_samples,
                &self.faulted,
            ) {
                eprintln!("activation failure has no durable audio fault marker");
            }
            "faulted"
        };
        self.snapshot.status = status.to_string();
        self.persist(
            "session_activation_failed",
            json!({
                "stage": stage,
                "reason": reason,
                "capture_resources_joined": cleanup.capture_resources_joined,
                "audio_safe": cleanup.audio_safe,
                "resumable": cleanup.capture_resources_joined && cleanup.audio_safe,
                "captured_samples": cleanup.captured_samples,
                "committed_samples": cleanup.committed_samples,
                "cleanup_warnings": &cleanup.warnings,
            }),
        )
    }

    fn latch_metadata_fault(&mut self, failure: &JournalAppendFailure) {
        let message = failure.to_string();
        if self.metadata_fault.is_none() {
            self.metadata_fault = Some(message.clone());
        }
        // Publish durable fault evidence before closing the callback gate. A
        // callback may already own an enqueue lease, so waiting for the gate
        // before latching the fault would leave an unbounded crash window with
        // no durable evidence.
        if !persist_audio_fault_marker_fail_closed(
            &self.session_dir,
            &format!("metadata journal durability failure: {message}"),
            self.committed.load(Ordering::Acquire),
            &self.faulted,
        ) {
            eprintln!("metadata durability failure has no durable audio fault marker");
        }
        // Stop accepting more callback blocks, wait for callbacks already in
        // the enqueue path, then put the fault sentinel behind their sample
        // messages. This gives metadata durability failures the same finite,
        // drain-and-finalize behavior as an audio-device xrun.
        self.writer_queue.close();
        // Keep journal error handling itself bounded. If a callback still owns
        // the enqueue lease, the next stop attempt will wait for it before
        // placing Stop behind the final Samples message.
        if self.writer_queue.in_flight() == 0 {
            let _ = self.writer_tx.try_send(WriterMessage::FaultAndStop(format!(
                "metadata journal durability failure: {message}"
            )));
        }
    }

    fn persist(&mut self, event: &str, payload: Value) -> Result<()> {
        self.ensure_metadata_mutation_allowed()?;
        let mut next_snapshot = self.live_snapshot();
        next_snapshot.journal_seq = self
            .snapshot
            .journal_seq
            .checked_add(1)
            .context("journal sequence overflow")?;
        let event_value = json!({
            "journal_seq": next_snapshot.journal_seq,
            "event": event,
            "at": Utc::now().to_rfc3339(),
            "payload": payload,
            "captured_samples": next_snapshot.captured_samples,
            "committed_samples": next_snapshot.committed_samples,
            "snapshot": &next_snapshot,
        });
        let event_path = self.session_dir.join("metadata/events.jsonl");
        if let Err(failure) =
            append_journal_event(&event_path, &event_value, JournalAppendFault::None)
        {
            self.latch_metadata_fault(&failure);
            return Err(anyhow!(failure));
        }
        // The journal is authoritative. Once its event is durable, advance the
        // in-memory projection even if writing the replaceable snapshot fails.
        self.snapshot = next_snapshot;
        let mut projection_failures = Vec::<String>::new();
        if let Err(error) = atomic_snapshot_json(
            &self.session_dir.join("metadata/items.snapshot.json"),
            &self.snapshot,
        ) {
            projection_failures.push(format!("update items snapshot: {error:#}"));
        }
        if let Err(error) = atomic_json(
            &self.session_dir.join("script/normalized.json"),
            &self.snapshot.items,
        ) {
            projection_failures.push(format!("update normalized script: {error:#}"));
        }
        if let Err(error) = atomic_json(
            &self.session_dir.join("session.json"),
            &json!({
                "schema_version": self.snapshot.schema_version,
                "journal_seq": self.snapshot.journal_seq,
                "session_id": self.snapshot.session_id,
                "script_name": self.snapshot.script_name,
                "status": self.snapshot.status,
                "device_name": self.snapshot.device_name,
                "device_id": self.snapshot.device_id,
                "input_sample_format": self.snapshot.input_sample_format,
                "capture_share_mode": self.snapshot.capture_share_mode,
                "capture_provenance": self.snapshot.capture_provenance,
                "audio_format": self.snapshot.audio_format,
                "storage_layout_version": self.snapshot.storage_layout_version,
                "segment_frames": self.snapshot.segment_frames,
                "input_discontinuity_count": self.snapshot.input_discontinuity_count,
                "input_discontinuity_silence_samples": self.snapshot.input_discontinuity_silence_samples,
                "noise_threshold_dbfs": self.snapshot.noise_threshold_dbfs,
                "silence_duration_ms": self.snapshot.silence_duration_ms,
                "silence_threshold_dbfs": self.snapshot.silence_threshold_dbfs,
                "silence_detector": self.snapshot.silence_detector,
                "started_at": self.snapshot.started_at,
                "updated_at": self.snapshot.updated_at,
            }),
        ) {
            projection_failures.push(format!("update session summary: {error:#}"));
        }
        // Once the replaceable projections are durable, only the latest full
        // journal projection is normally needed. Keep an open attempt's
        // `attempt_started` event until that attempt is closed: active-attempt
        // timing is intentionally reconstructed from the journal after a
        // crash, and a later `session_stopping` projection must not erase it.
        // Atomic compaction otherwise keeps the log bounded to one or two
        // entries even for scripts with thousands of sentences: a crash before
        // replacement leaves the old+new pair, while a crash after replacement
        // leaves the latest self-contained event.
        let active_attempt_remains_open = self.active_attempt.is_some()
            && !matches!(
                event,
                "attempt_stopped" | "attempt_discarded" | "attempt_interrupted"
            );
        if projection_failures.is_empty()
            && !active_attempt_remains_open
            && let Err(error) = atomic_json_line(&event_path, &event_value)
        {
            projection_failures.push(format!("compact journal: {error:#}"));
        }
        for failure in projection_failures {
            eprintln!(
                "metadata projection warning after committed journal event {} seq {}: {failure}",
                event, self.snapshot.journal_seq
            );
        }
        Ok(())
    }

    fn metadata_seal_error(&mut self, committed: u64, mut warnings: Vec<String>) -> anyhow::Error {
        let metadata_fault = self
            .metadata_fault
            .clone()
            .unwrap_or_else(|| "unknown metadata durability failure".to_string());
        if let Some(active) = self.active_attempt.take()
            && let Err(error) = mark_active_attempt_interrupted(
                &mut self.snapshot,
                &active,
                committed,
                self.head_silence.passed_sample.load(Ordering::Acquire),
                self.head_silence.required_samples(),
                self.attempt_signal_start_sample.load(Ordering::Acquire),
            )
        {
            warnings.push(format!("mark active attempt interrupted: {error:#}"));
        }
        self.snapshot = self.live_snapshot();
        self.snapshot.status = "faulted".to_string();
        if !persist_audio_fault_marker_fail_closed(
            &self.session_dir,
            &format!("metadata journal durability failure: {metadata_fault}"),
            committed,
            &self.faulted,
        ) {
            warnings.push("audio fault marker could not be persisted".to_string());
        }

        // The journal itself is the failed component. Publish a best-effort
        // faulted projection without appending another journal event so the
        // desktop shell and a later forensic pass can see that capture ended.
        if let Err(error) = atomic_snapshot_json(
            &self.session_dir.join("metadata/items.snapshot.json"),
            &self.snapshot,
        ) {
            warnings.push(format!("publish faulted items snapshot: {error:#}"));
        }
        if let Err(error) = atomic_json(
            &self.session_dir.join("script/normalized.json"),
            &self.snapshot.items,
        ) {
            warnings.push(format!("publish faulted normalized script: {error:#}"));
        }
        if let Err(error) = atomic_json(
            &self.session_dir.join("session.json"),
            &json!({
                "schema_version": self.snapshot.schema_version,
                "journal_seq": self.snapshot.journal_seq,
                "session_id": self.snapshot.session_id,
                "script_name": self.snapshot.script_name,
                "status": self.snapshot.status,
                "device_name": self.snapshot.device_name,
                "device_id": self.snapshot.device_id,
                "input_sample_format": self.snapshot.input_sample_format,
                "capture_share_mode": self.snapshot.capture_share_mode,
                "capture_provenance": self.snapshot.capture_provenance,
                "audio_format": self.snapshot.audio_format,
                "storage_layout_version": self.snapshot.storage_layout_version,
                "segment_frames": self.snapshot.segment_frames,
                "input_discontinuity_count": self.snapshot.input_discontinuity_count,
                "input_discontinuity_silence_samples": self.snapshot.input_discontinuity_silence_samples,
                "noise_threshold_dbfs": self.snapshot.noise_threshold_dbfs,
                "silence_duration_ms": self.snapshot.silence_duration_ms,
                "silence_threshold_dbfs": self.snapshot.silence_threshold_dbfs,
                "silence_detector": self.snapshot.silence_detector,
                "started_at": self.snapshot.started_at,
                "updated_at": self.snapshot.updated_at,
            }),
        ) {
            warnings.push(format!("publish faulted session summary: {error:#}"));
        }
        warnings.push("元数据日志无法安全封存，已停止采集并保留原始母轨。".to_string());
        anyhow!(MetadataSealError {
            metadata_fault,
            warnings,
        })
    }

    fn stop_with_timeout(&mut self, timeout: Duration) -> Result<Value> {
        if self.capture_stopped {
            bail!("recording capture resources are already stopped");
        }
        let cleanup = self.progress_capture_shutdown_with_timeout(timeout);
        let mut warnings = cleanup.warnings;
        if !cleanup.capture_resources_joined {
            self.snapshot.status = "stopping".to_string();
            if self.metadata_fault.is_none()
                && let Err(error) = self.persist(
                    "session_stopping",
                    json!({
                        "capture_resources_joined": false,
                        "captured_samples": cleanup.captured_samples,
                        "committed_samples": cleanup.committed_samples,
                        "cleanup_warnings": &warnings,
                    }),
                )
            {
                warnings.push(format!("persist stopping state: {error:#}"));
            }
            let warning_context = if warnings.is_empty() {
                String::new()
            } else {
                format!(" 当前状态：{}", warnings.join("; "))
            };
            bail!(
                "音频仍在安全封存，状态已记为 stopping，任务锁与未结束的线程句柄保留；请稍后重试“结束录制”。{warning_context}"
            );
        }
        let committed = self.committed.load(Ordering::Acquire);
        if !cleanup.audio_safe
            && !persist_audio_fault_marker_fail_closed(
                &self.session_dir,
                &format!(
                    "capture resources stopped without a complete durable timeline: captured={}, committed={committed}",
                    cleanup.captured_samples
                ),
                committed,
                &self.faulted,
            )
        {
            warnings.push("audio fault marker could not be persisted".to_string());
        }
        if self.metadata_fault.is_some() {
            return Err(self.metadata_seal_error(committed, warnings));
        }
        if let Some(active) = self.active_attempt.take() {
            let attempt = mark_active_attempt_interrupted(
                &mut self.snapshot,
                &active,
                committed,
                self.head_silence.passed_sample.load(Ordering::Acquire),
                self.head_silence.required_samples(),
                self.attempt_signal_start_sample.load(Ordering::Acquire),
            )?;
            if let Err(error) = self.persist(
                "attempt_interrupted",
                json!({ "item_id": active.item_id, "attempt": attempt }),
            ) {
                if self.metadata_fault.is_some() {
                    return Err(self.metadata_seal_error(committed, warnings));
                }
                return Err(error);
            }
            warnings.push("当前句因录制结束或写盘故障已标记为异常中断，不会进入交付。".to_string());
        }
        self.snapshot.status =
            if self.faulted.load(Ordering::Acquire) || self.overflow.load(Ordering::Acquire) > 0 {
                "faulted".to_string()
            } else {
                "stopped".to_string()
            };
        if let Err(error) =
            self.persist("session_stopped", json!({ "committed_samples": committed }))
        {
            if self.metadata_fault.is_some() {
                return Err(self.metadata_seal_error(committed, warnings));
            }
            return Err(error);
        }
        Ok(json!({
            "session_dir": self.session_dir,
            "snapshot": self.snapshot,
            "warnings": warnings,
        }))
    }

    fn stop(&mut self) -> Result<Value> {
        self.stop_with_timeout(CAPTURE_SHUTDOWN_TIMEOUT)
    }
}

fn validate_live_preview_range(sample_rate: u32, start_frame: u64, end_frame: u64) -> Result<()> {
    if end_frame <= start_frame {
        bail!("试听范围无效");
    }
    let maximum_frames = u64::from(sample_rate)
        .checked_mul(LIVE_PREVIEW_MAX_SECONDS)
        .context("preview duration overflow")?;
    if end_frame - start_frame > maximum_frames {
        bail!("单次实时试听最长支持 10 分钟，请缩短录音后重试");
    }
    Ok(())
}

fn storage_check_requires_stop(consecutive_failures: &mut u8, succeeded: bool) -> bool {
    if succeeded {
        *consecutive_failures = 0;
        return false;
    }
    *consecutive_failures = consecutive_failures.saturating_add(1);
    *consecutive_failures >= 3
}

fn audio_fault_marker_present(session_dir: &Path) -> Result<bool> {
    let marker = session_dir.join(AUDIO_FAULT_MARKER);
    let temporary = marker.with_extension("tmp");
    for candidate in [&marker, &temporary] {
        match std::fs::symlink_metadata(candidate) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("inspect audio fault marker {}", candidate.display())
                });
            }
        }
    }
    Ok(false)
}

fn audio_fault_reserve_value() -> Value {
    json!({
        "schema_version": 1,
        "reserved_audio_fault": true,
        "reason": "audio capture entered an unsafe state before detailed fault metadata could be persisted",
        "committed_frames": 0,
        "timestamp": Utc::now().to_rfc3339(),
    })
}

fn validate_audio_fault_reserve(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("inspect audio fault reserve {}", path.display()))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > AUDIO_FAULT_RESERVE_MAX_BYTES
    {
        bail!("audio fault reserve must be a small regular file");
    }
    let value: Value = serde_json::from_slice(
        &std::fs::read(path)
            .with_context(|| format!("read audio fault reserve {}", path.display()))?,
    )
    .with_context(|| format!("parse audio fault reserve {}", path.display()))?;
    if value.get("schema_version").and_then(Value::as_u64) != Some(1)
        || value.get("reserved_audio_fault").and_then(Value::as_bool) != Some(true)
        || !value
            .get("reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| !reason.trim().is_empty())
        || value.get("committed_frames").and_then(Value::as_u64) != Some(0)
        || !value
            .get("timestamp")
            .and_then(Value::as_str)
            .is_some_and(|timestamp| !timestamp.trim().is_empty())
    {
        bail!("audio fault reserve has invalid recovery evidence");
    }
    Ok(())
}

fn ensure_audio_fault_reserve(session_dir: &Path) -> Result<()> {
    if audio_fault_marker_present(session_dir)? {
        bail!("录制任务已存在音频故障标记，禁止启动新的采集流");
    }
    let reserve = session_dir.join(AUDIO_FAULT_RESERVE);
    match std::fs::symlink_metadata(&reserve) {
        Ok(_) => return validate_audio_fault_reserve(&reserve),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("inspect audio fault reserve {}", reserve.display()));
        }
    }
    atomic_json(&reserve, &audio_fault_reserve_value())
        .with_context(|| format!("provision audio fault reserve {}", reserve.display()))?;
    validate_audio_fault_reserve(&reserve)
}

/// Publishes preallocated generic fault evidence without allocating a new data
/// file. A concurrent fault reporter may win the same rename; re-check the
/// marker after an error before declaring that no durable evidence exists.
fn activate_audio_fault_reserve(session_dir: &Path) -> bool {
    match audio_fault_marker_present(session_dir) {
        Ok(true) => return true,
        Ok(false) => {}
        Err(error) => {
            eprintln!("could not inspect existing audio fault evidence: {error:#}");
            return false;
        }
    }
    let reserve = session_dir.join(AUDIO_FAULT_RESERVE);
    let marker = session_dir.join(AUDIO_FAULT_MARKER);
    if let Err(error) = validate_audio_fault_reserve(&reserve) {
        if error
            .downcast_ref::<std::io::Error>()
            .is_none_or(|io_error| io_error.kind() != std::io::ErrorKind::NotFound)
        {
            eprintln!(
                "could not validate preallocated audio fault reserve {}: {error:#}",
                reserve.display()
            );
        }
        return false;
    }
    match durable_replace(&reserve, &marker) {
        Ok(()) => true,
        Err(error) => {
            eprintln!(
                "could not activate preallocated audio fault reserve {} as {}: {error:#}",
                reserve.display(),
                marker.display()
            );
            audio_fault_marker_present(session_dir).unwrap_or(false)
        }
    }
}

fn ensure_no_audio_fault_marker(session_dir: &Path, operation: &str) -> Result<()> {
    let marker = session_dir.join(AUDIO_FAULT_MARKER);
    let temporary = marker.with_extension("tmp");
    for candidate in [&marker, &temporary] {
        match std::fs::symlink_metadata(candidate) {
            Ok(_) => bail!(
                "录制检测到不可忽略的音频采集故障，禁止{operation}；请保留并人工检查原始母轨：{}",
                candidate.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("inspect audio fault marker {}", candidate.display())
                });
            }
        }
    }
    Ok(())
}

fn persist_audio_fault_marker(session_dir: &Path, reason: &str, committed_frames: u64) -> bool {
    let generic_evidence_published = activate_audio_fault_reserve(session_dir);
    let detailed_evidence_published =
        persist_audio_fault_marker_inner(session_dir, reason, committed_frames, false);
    generic_evidence_published || detailed_evidence_published
}

fn persist_audio_fault_marker_fail_closed(
    session_dir: &Path,
    reason: &str,
    committed_frames: u64,
    faulted: &AtomicBool,
) -> bool {
    // The inability to publish fault evidence can never make a live session
    // safer. Latch the in-memory unsafe state before touching the failing volume.
    faulted.store(true, Ordering::Release);
    let persisted = persist_audio_fault_marker(session_dir, reason, committed_frames);
    if !persisted {
        eprintln!(
            "audio fault evidence could not be persisted; the live session remains unsafe: {reason}"
        );
    }
    persisted
}

#[cfg(test)]
fn injected_storage_full_error() -> std::io::Error {
    #[cfg(windows)]
    const STORAGE_FULL_RAW_ERROR: i32 = 112; // ERROR_DISK_FULL
    #[cfg(not(windows))]
    const STORAGE_FULL_RAW_ERROR: i32 = 28; // ENOSPC on supported Unix targets
    std::io::Error::from_raw_os_error(STORAGE_FULL_RAW_ERROR)
}

#[cfg(test)]
fn audio_fault_detail_create_failures() -> &'static std::sync::Mutex<HashMap<PathBuf, usize>> {
    static FAILURES: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, usize>>> =
        std::sync::OnceLock::new();
    FAILURES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn set_audio_fault_detail_create_failures(session_dir: &Path, count: usize) {
    audio_fault_detail_create_failures()
        .lock()
        .unwrap()
        .insert(session_dir.to_path_buf(), count);
}

#[cfg(test)]
fn take_audio_fault_detail_create_failure(session_dir: &Path) -> bool {
    let mut failures = audio_fault_detail_create_failures().lock().unwrap();
    let Some(remaining) = failures.get_mut(session_dir) else {
        return false;
    };
    if *remaining == 0 {
        failures.remove(session_dir);
        return false;
    }
    *remaining -= 1;
    if *remaining == 0 {
        failures.remove(session_dir);
    }
    true
}

fn persist_audio_fault_marker_inner(
    session_dir: &Path,
    reason: &str,
    committed_frames: u64,
    stop_after_synced_temporary: bool,
) -> bool {
    let marker = session_dir.join(AUDIO_FAULT_MARKER);
    let temporary = marker.with_extension("tmp");
    // An interrupted fixed temporary is already sufficient to fail closed.
    // Never replace it: it may be the only durable evidence from a crash
    // between syncing the candidate and publishing the final name.
    match std::fs::symlink_metadata(&temporary) {
        Ok(_) => return true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            eprintln!(
                "could not inspect audio fault marker {}: {error}",
                temporary.display()
            );
            return false;
        }
    }
    // A later checkpoint may refine the durable frame count and diagnostic
    // reason. A regular final marker can be replaced through the same fixed
    // temporary: the old final remains visible until the new candidate is
    // synced, so there is no crash window without fault evidence.
    match std::fs::symlink_metadata(&marker) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => return true,
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            eprintln!(
                "could not inspect audio fault marker {}: {error}",
                marker.display()
            );
            return false;
        }
    }
    let value = json!({
        "reason": reason,
        "committed_frames": committed_frames,
        "timestamp": Utc::now().to_rfc3339(),
    });
    let result = (|| -> Result<()> {
        #[cfg(test)]
        if take_audio_fault_detail_create_failure(session_dir) {
            return Err(injected_storage_full_error())
                .context("injected ENOSPC while creating detailed audio fault marker");
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .with_context(|| format!("create audio fault marker {}", temporary.display()))?;
        serde_json::to_writer_pretty(&mut file, &value)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        // The fixed, no-follow `create_new` temporary is itself a recovery
        // marker. Make its directory entry durable before replacing the final
        // name so a crash in either phase remains fail-closed.
        sync_parent_directory(&temporary)?;
        if stop_after_synced_temporary {
            bail!("injected stop after synced audio fault temporary");
        }
        durable_replace(&temporary, &marker)
    })();
    if let Err(error) = result {
        // Do not remove the temporary on error. Even a partial candidate means
        // the recorder failed while trying to persist a fault and must block
        // resume/export until a human inspects the source audio.
        eprintln!(
            "could not persist audio fault marker {}: {error:#}",
            marker.display()
        );
        return false;
    }
    true
}

fn latch_audio_fault_marker(
    session_dir: &Path,
    latched_reason: &mut Option<String>,
    reason: impl Into<String>,
    committed_frames: u64,
    faulted: &AtomicBool,
) -> bool {
    let reason = latched_reason.get_or_insert_with(|| reason.into());
    persist_audio_fault_marker_fail_closed(session_dir, reason, committed_frames, faulted)
}

#[cfg(test)]
enum WriterStorageCheckOverride {
    Critical,
    Error(&'static str),
}

#[cfg(test)]
fn writer_storage_check_overrides()
-> &'static std::sync::Mutex<HashMap<PathBuf, VecDeque<WriterStorageCheckOverride>>> {
    static OVERRIDES: std::sync::OnceLock<
        std::sync::Mutex<HashMap<PathBuf, VecDeque<WriterStorageCheckOverride>>>,
    > = std::sync::OnceLock::new();
    OVERRIDES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn set_writer_storage_check_overrides(
    directory: &Path,
    outcomes: impl IntoIterator<Item = WriterStorageCheckOverride>,
) {
    writer_storage_check_overrides()
        .lock()
        .unwrap()
        .insert(directory.to_path_buf(), outcomes.into_iter().collect());
}

#[cfg(test)]
struct WriterWriteFailureGate {
    entered: Sender<()>,
    release: Receiver<()>,
}

#[cfg(test)]
fn writer_write_failure_gates()
-> &'static std::sync::Mutex<HashMap<PathBuf, WriterWriteFailureGate>> {
    static GATES: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, WriterWriteFailureGate>>> =
        std::sync::OnceLock::new();
    GATES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn write_audio_samples(
    writer: &mut AudioWriterBackend,
    _storage_directory: &Path,
    samples: &[f32],
) -> Result<()> {
    #[cfg(test)]
    if let Some(gate) = writer_write_failure_gates()
        .lock()
        .unwrap()
        .remove(_storage_directory)
    {
        let _ = gate.entered.send(());
        let _ = gate.release.recv();
        return Err(injected_storage_full_error()).context("injected audio write failure");
    }
    writer.write_samples(samples)
}

fn automatic_writer_checkpoint_due(
    elapsed: Duration,
    frames_written: u64,
    committed_frames: u64,
    sample_rate: u32,
) -> bool {
    let frame_interval = u64::from(sample_rate) * WRITER_AUTOMATIC_CHECKPOINT_SECONDS;
    elapsed >= Duration::from_secs(WRITER_AUTOMATIC_CHECKPOINT_SECONDS)
        || frames_written.saturating_sub(committed_frames) >= frame_interval
}

fn writer_storage_check_due(storage_directory: &Path, elapsed: Duration) -> bool {
    #[cfg(not(test))]
    let _ = storage_directory;
    #[cfg(test)]
    if writer_storage_check_overrides()
        .lock()
        .unwrap()
        .get(storage_directory)
        .is_some_and(|outcomes| !outcomes.is_empty())
    {
        return true;
    }
    elapsed >= Duration::from_secs(WRITER_STORAGE_CHECK_INTERVAL_SECONDS)
}

fn check_writer_storage(
    storage_directory: &Path,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
) -> Result<StorageReport> {
    #[cfg(test)]
    {
        let outcome = {
            let mut overrides = writer_storage_check_overrides().lock().unwrap();
            let outcome = overrides
                .get_mut(storage_directory)
                .and_then(VecDeque::pop_front);
            if overrides
                .get(storage_directory)
                .is_some_and(VecDeque::is_empty)
            {
                overrides.remove(storage_directory);
            }
            outcome
        };
        match outcome {
            Some(WriterStorageCheckOverride::Critical) => {
                return crate::storage_guard::evaluate_available_space(
                    0,
                    sample_rate,
                    channels,
                    bit_depth,
                );
            }
            Some(WriterStorageCheckOverride::Error(message)) => bail!(message),
            None => {}
        }
    }
    check_storage(storage_directory, sample_rate, channels, bit_depth)
}

#[cfg(test)]
struct ExportWorkerTestGate {
    entered: Sender<()>,
    release: Receiver<()>,
}

#[cfg(test)]
fn export_worker_test_gates() -> &'static std::sync::Mutex<HashMap<PathBuf, ExportWorkerTestGate>> {
    static GATES: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, ExportWorkerTestGate>>> =
        std::sync::OnceLock::new();
    GATES.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn block_export_worker_for_test(destination: &Path) {
    let gate = export_worker_test_gates()
        .lock()
        .unwrap()
        .remove(destination);
    if let Some(gate) = gate {
        let _ = gate.entered.send(());
        let _ = gate.release.recv();
    }
}

fn render_prepared_export(prepared: PreparedWavExport) -> Result<u64, String> {
    #[cfg(test)]
    block_export_worker_for_test(prepared.destination());
    prepared.write().map_err(|error| format!("{error:#}"))
}

#[allow(clippy::too_many_arguments)]
fn writer_loop(
    receiver: Receiver<WriterMessage>,
    path: &Path,
    sample_rate: u32,
    bit_depth: u16,
    append: bool,
    storage_kind: MasterStorageKind,
    max_frames_per_segment: u64,
    storage_directory: &Path,
    captured: Arc<AtomicU64>,
    committed: Arc<AtomicU64>,
    overflow: Arc<AtomicU64>,
    faulted: Arc<AtomicBool>,
    storage_status: Arc<AtomicU32>,
    storage_safe_remaining_seconds: Arc<AtomicU64>,
    queue: WriterQueueBudget,
    waveform: Option<Sender<Vec<[f32; 2]>>>,
    ready: Sender<Result<u64, String>>,
) {
    let initialized = match (storage_kind, append) {
        (MasterStorageKind::LegacySingleWav, true) => {
            RecoverableWav::open_append(path, sample_rate, 1, bit_depth)
                .map(AudioWriterBackend::Legacy)
        }
        (MasterStorageKind::LegacySingleWav, false) => {
            RecoverableWav::create(path, sample_rate, 1, bit_depth).map(AudioWriterBackend::Legacy)
        }
        (MasterStorageKind::SegmentedWav, true) => {
            SegmentedWav::resume(path, sample_rate, 1, bit_depth, max_frames_per_segment)
                .map(AudioWriterBackend::Segmented)
        }
        (MasterStorageKind::SegmentedWav, false) => {
            SegmentedWav::create(path, sample_rate, 1, bit_depth, max_frames_per_segment)
                .map(AudioWriterBackend::Segmented)
        }
    };
    let mut writer = match initialized {
        Ok(writer) => {
            let frames = writer.frames_written();
            committed.store(frames, Ordering::Release);
            let _ = ready.send(Ok(frames));
            writer
        }
        Err(error) => {
            let reason = format!("audio writer initialization failed: {error:#}");
            eprintln!("{reason}");
            if !persist_audio_fault_marker_fail_closed(
                storage_directory,
                &reason,
                committed.load(Ordering::Acquire),
                &faulted,
            ) {
                eprintln!("audio writer initialization failed without durable fault evidence");
            }
            let _ = ready.send(Err(reason));
            return;
        }
    };
    let mut last_checkpoint = Instant::now();
    let mut last_storage_check = Instant::now();
    let mut consecutive_storage_check_failures = 0u8;
    let mut shutdown_after_drain = false;
    let mut pending_stop_reply = None::<Sender<Result<u64, String>>>;
    let mut latched_fault_reason = None::<String>;
    let export_busy = Arc::new(AtomicBool::new(false));
    while let Ok(message) = receiver.recv() {
        match message {
            WriterMessage::Samples(samples) => {
                if let Err(error) = write_audio_samples(&mut writer, storage_directory, &samples) {
                    let base_reason = format!("audio write failed: {error:#}");
                    eprintln!("{base_reason}");
                    // Latch the unsafe state and publish the preallocated
                    // generic marker before waiting for callbacks that already
                    // entered the enqueue path. A stuck callback must not leave
                    // a crash window where recovery sees an ordinary interrupt.
                    let initial_marker_persisted = persist_audio_fault_marker_fail_closed(
                        storage_directory,
                        &base_reason,
                        committed.load(Ordering::Acquire),
                        &faulted,
                    );
                    // Reject new callbacks and wait through every callback that
                    // already entered before measuring accepted audio. The
                    // remaining channel backlog cannot be written safely after
                    // a storage error, so it is accounted as lost explicitly.
                    queue.close_and_wait();
                    let mut checkpoint_failure = None::<String>;
                    let durable_frames = match writer.checkpoint() {
                        Ok(frames) => {
                            committed.store(frames, Ordering::Release);
                            frames
                        }
                        Err(checkpoint_error) => {
                            checkpoint_failure = Some(format!("{checkpoint_error:#}"));
                            committed.load(Ordering::Acquire)
                        }
                    };
                    let accepted_frames = captured.load(Ordering::Acquire);
                    let lost_frames = accepted_frames.saturating_sub(durable_frames);
                    saturating_atomic_add(&overflow, lost_frames);
                    queue.queued_frames.store(0, Ordering::Release);
                    let mut message = format!(
                        "{base_reason}; accepted_frames={accepted_frames}; durable_frames={durable_frames}; lost_frames={lost_frames}"
                    );
                    if let Some(checkpoint_error) = checkpoint_failure {
                        message.push_str(&format!("; checkpoint_failed={checkpoint_error}"));
                    }
                    let detailed_marker_persisted = persist_audio_fault_marker_fail_closed(
                        storage_directory,
                        &message,
                        durable_frames,
                        &faulted,
                    );
                    if !initial_marker_persisted && !detailed_marker_persisted {
                        message.push_str("; audio_fault_marker_persistence_failed=true");
                    }
                    if let Some(reply) = pending_stop_reply.take() {
                        let _ = reply.send(Err(message.clone()));
                    }
                    break;
                }
                // Keep the block charged to the bounded writer backlog until
                // the complete write returns. This makes the 20-second queue
                // budget include the in-progress write instead of allowing a
                // second full queue to accumulate behind it.
                queue.release(samples.len() as u64);
                if let Some(waveform) = &waveform {
                    let _ = waveform.try_send(waveform_bins(&samples));
                }
                let mut fault_stop_reason = None::<String>;
                if !shutdown_after_drain
                    && automatic_writer_checkpoint_due(
                        last_checkpoint.elapsed(),
                        writer.frames_written(),
                        committed.load(Ordering::Acquire),
                        sample_rate,
                    )
                {
                    match writer.checkpoint() {
                        Ok(frames) => {
                            committed.store(frames, Ordering::Release);
                        }
                        Err(error) => {
                            fault_stop_reason = Some(format!("audio checkpoint failed: {error:#}"));
                        }
                    }
                    last_checkpoint = Instant::now();
                }
                // Do not tie this inexpensive guard to `last_checkpoint`.
                // Explicit checkpoints happen at sentence completion and
                // preview time; resetting the storage clock there could starve
                // disk protection indefinitely during a sequence of short
                // takes.
                if !shutdown_after_drain
                    && fault_stop_reason.is_none()
                    && writer_storage_check_due(storage_directory, last_storage_check.elapsed())
                {
                    match check_writer_storage(storage_directory, sample_rate, 1, bit_depth) {
                        Ok(report) if report.status == StorageStatus::Critical => {
                            storage_check_requires_stop(
                                &mut consecutive_storage_check_failures,
                                true,
                            );
                            storage_status.store(2, Ordering::Release);
                            storage_safe_remaining_seconds
                                .store(report.safe_recording_seconds, Ordering::Release);
                            fault_stop_reason = Some(format!(
                                "recording stopped before exhausting disk space: {} bytes available",
                                report.available_bytes
                            ));
                        }
                        Ok(report) => {
                            storage_check_requires_stop(
                                &mut consecutive_storage_check_failures,
                                true,
                            );
                            storage_status.store(
                                if report.status == StorageStatus::Warning {
                                    1
                                } else {
                                    0
                                },
                                Ordering::Release,
                            );
                            storage_safe_remaining_seconds
                                .store(report.safe_recording_seconds, Ordering::Release);
                        }
                        Err(error) => {
                            eprintln!("disk space check failed: {error:#}");
                            if storage_check_requires_stop(
                                &mut consecutive_storage_check_failures,
                                false,
                            ) {
                                fault_stop_reason = Some(
                                    "recording stopped after three consecutive disk space check failures"
                                        .to_string(),
                                );
                            }
                        }
                    }
                    last_storage_check = Instant::now();
                }
                if let Some(reason) = fault_stop_reason {
                    eprintln!("{reason}");
                    // Stop new callbacks first, then wait for every callback
                    // that already entered the enqueue path. Their sample
                    // messages are now a finite FIFO backlog whose frame count
                    // is tracked by `queue`.
                    if !latch_audio_fault_marker(
                        storage_directory,
                        &mut latched_fault_reason,
                        &reason,
                        committed.load(Ordering::Acquire),
                        &faulted,
                    ) {
                        eprintln!("writer storage fault has no durable marker");
                    }
                    queue.close_and_wait();
                    shutdown_after_drain = true;
                }
            }
            WriterMessage::Checkpoint(reply) => {
                let result = writer.checkpoint().map_err(|error| format!("{error:#}"));
                match &result {
                    Ok(frames) => {
                        committed.store(*frames, Ordering::Release);
                        last_checkpoint = Instant::now();
                    }
                    Err(message) => {
                        eprintln!("audio checkpoint failed: {message}");
                        if !latch_audio_fault_marker(
                            storage_directory,
                            &mut latched_fault_reason,
                            format!("audio checkpoint failed: {message}"),
                            committed.load(Ordering::Acquire),
                            &faulted,
                        ) {
                            eprintln!("writer checkpoint fault has no durable marker");
                        }
                        queue.close_and_wait();
                        shutdown_after_drain = true;
                    }
                }
                let _ = reply.send(result);
            }
            WriterMessage::ExportRange {
                destination,
                start_frame,
                end_frame,
                reply,
            } => {
                if shutdown_after_drain {
                    let _ =
                        reply.send(Err("录音写入正在故障封存，暂时不能生成试听文件".to_string()));
                } else if export_busy
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    let _ = reply.send(Err("已有试听文件正在生成，请稍后再试".to_string()));
                } else {
                    let prepared =
                        match validate_live_preview_range(sample_rate, start_frame, end_frame) {
                            Err(error) => Err(error),
                            Ok(()) => match writer.checkpoint() {
                                Ok(frames) => {
                                    committed.store(frames, Ordering::Release);
                                    last_checkpoint = Instant::now();
                                    writer.prepare_export_range_after_checkpoint(
                                        path,
                                        &destination,
                                        sample_rate,
                                        bit_depth,
                                        start_frame,
                                        end_frame,
                                    )
                                }
                                Err(error) => {
                                    let reason = format!(
                                        "audio checkpoint failed before preview: {error:#}"
                                    );
                                    if !latch_audio_fault_marker(
                                        storage_directory,
                                        &mut latched_fault_reason,
                                        &reason,
                                        committed.load(Ordering::Acquire),
                                        &faulted,
                                    ) {
                                        eprintln!("preview checkpoint fault has no durable marker");
                                    }
                                    queue.close_and_wait();
                                    shutdown_after_drain = true;
                                    Err(anyhow!(reason))
                                }
                            },
                        };
                    match prepared {
                        Err(error) => {
                            export_busy.store(false, Ordering::Release);
                            let _ = reply.send(Err(format!("{error:#}")));
                        }
                        Ok(prepared) => {
                            // The active range is now immutable memory and
                            // closed-file descriptors, so slow preview I/O no
                            // longer occupies the real-time master writer.
                            let worker_busy = Arc::clone(&export_busy);
                            let spawn_failure_reply = reply.clone();
                            if let Err(error) = thread::Builder::new()
                                .name("audio-preview-export".to_string())
                                .spawn(move || {
                                    let result = render_prepared_export(prepared);
                                    worker_busy.store(false, Ordering::Release);
                                    let _ = reply.send(result);
                                })
                            {
                                export_busy.store(false, Ordering::Release);
                                let _ = spawn_failure_reply
                                    .send(Err(format!("start audio preview worker: {error}")));
                            }
                        }
                    }
                }
            }
            WriterMessage::WaveformRange {
                start_frame,
                end_frame,
                reply,
            } => {
                if shutdown_after_drain {
                    let _ = reply.send(Err("录音写入正在故障封存，暂时不能生成波形".to_string()));
                } else if export_busy
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    let _ = reply.send(Err("已有试听或波形正在生成，请稍后再试".to_string()));
                } else {
                    let dummy = path.with_file_name(".waveform-preview");
                    let prepared =
                        match validate_live_preview_range(sample_rate, start_frame, end_frame) {
                            Err(error) => Err(error),
                            Ok(()) => match writer.checkpoint() {
                                Ok(frames) => {
                                    committed.store(frames, Ordering::Release);
                                    last_checkpoint = Instant::now();
                                    writer.prepare_export_range_after_checkpoint(
                                        path,
                                        &dummy,
                                        sample_rate,
                                        bit_depth,
                                        start_frame,
                                        end_frame,
                                    )
                                }
                                Err(error) => {
                                    let reason = format!(
                                        "audio checkpoint failed before waveform: {error:#}"
                                    );
                                    if !latch_audio_fault_marker(
                                        storage_directory,
                                        &mut latched_fault_reason,
                                        &reason,
                                        committed.load(Ordering::Acquire),
                                        &faulted,
                                    ) {
                                        eprintln!(
                                            "waveform checkpoint fault has no durable marker"
                                        );
                                    }
                                    queue.close_and_wait();
                                    shutdown_after_drain = true;
                                    Err(anyhow!(reason))
                                }
                            },
                        };
                    match prepared {
                        Err(error) => {
                            export_busy.store(false, Ordering::Release);
                            let _ = reply.send(Err(format!("{error:#}")));
                        }
                        Ok(prepared) => {
                            let worker_busy = Arc::clone(&export_busy);
                            let spawn_failure_reply = reply.clone();
                            if let Err(error) = thread::Builder::new()
                                .name("audio-preview-waveform".to_string())
                                .spawn(move || {
                                    let result = prepared
                                        .waveform_bins()
                                        .map_err(|error| format!("{error:#}"));
                                    worker_busy.store(false, Ordering::Release);
                                    let _ = reply.send(result);
                                })
                            {
                                export_busy.store(false, Ordering::Release);
                                let _ = spawn_failure_reply
                                    .send(Err(format!("start audio waveform worker: {error}")));
                            }
                        }
                    }
                }
            }
            WriterMessage::FaultAndStop(reason) => {
                eprintln!("audio writer stopping after capture fault: {reason}");
                if !latch_audio_fault_marker(
                    storage_directory,
                    &mut latched_fault_reason,
                    &reason,
                    committed.load(Ordering::Acquire),
                    &faulted,
                ) {
                    eprintln!("capture fault has no durable marker");
                }
                queue.close_and_wait();
                shutdown_after_drain = true;
            }
            WriterMessage::Stop(reply) => {
                queue.close_and_wait();
                shutdown_after_drain = true;
                if pending_stop_reply.is_some() {
                    let _ = reply.send(Err("audio writer is already stopping".to_string()));
                } else {
                    pending_stop_reply = Some(reply);
                }
            }
        }
        if shutdown_after_drain && queue.queued_frames.load(Ordering::Acquire) == 0 {
            let mut result = writer.finalize().map_err(|error| format!("{error:#}"));
            match &result {
                Ok(frames) => committed.store(*frames, Ordering::Release),
                Err(message) => {
                    eprintln!("audio writer final checkpoint failed: {message}");
                    if !latch_audio_fault_marker(
                        storage_directory,
                        &mut latched_fault_reason,
                        format!("audio writer final checkpoint failed: {message}"),
                        committed.load(Ordering::Acquire),
                        &faulted,
                    ) {
                        eprintln!("writer finalization fault has no durable marker");
                    }
                }
            }
            if let Some(reason) = latched_fault_reason.as_deref()
                && !persist_audio_fault_marker_fail_closed(
                    storage_directory,
                    reason,
                    committed.load(Ordering::Acquire),
                    &faulted,
                )
            {
                result = Err(format!(
                    "{reason}; audio_fault_marker_persistence_failed=true"
                ));
            }
            if let Some(reply) = pending_stop_reply.take() {
                let _ = reply.send(result);
            }
            queue.queued_frames.store(0, Ordering::Release);
            break;
        }
    }
}

fn require_explicit_input_device_id<'a>(
    requested_id: Option<&'a str>,
    operation: &str,
) -> Result<&'a str> {
    requested_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow!(
                "{operation}需要明确的稳定设备 ID；为避免录错输入，软件不会自动切换到系统默认或同名设备。新任务请返回设备设置重新选择输入；旧任务请保留原始目录并联系项目管理员迁移，当前版本尚不支持恢复时重新绑定设备"
            )
        })
}

fn input_device_name(device: &Device) -> Result<String> {
    device
        .description()
        .map(|description| description.name().to_string())
        .context("read input device description")
}

fn select_device(host: &cpal::Host, requested_id: &str) -> Result<Device> {
    let parsed = requested_id
        .parse::<cpal::DeviceId>()
        .with_context(|| format!("invalid stable input device id: {requested_id}"))?;
    let device = host.device_by_id(&parsed).ok_or_else(|| {
        anyhow!(
            "指定的录音设备已断开或设备 ID 已变化：{requested_id}；为避免录错输入，软件不会自动切换到系统默认或同名设备"
        )
    })?;
    if !device.supports_input() {
        bail!("指定的设备已断开或不再提供录音输入：{requested_id}");
    }
    Ok(device)
}

fn is_supported_input_format(format: SampleFormat) -> bool {
    matches!(
        format,
        SampleFormat::I8
            | SampleFormat::I16
            | SampleFormat::I24
            | SampleFormat::I32
            | SampleFormat::I64
            | SampleFormat::U8
            | SampleFormat::U16
            | SampleFormat::U24
            | SampleFormat::U32
            | SampleFormat::U64
            | SampleFormat::F32
            | SampleFormat::F64
    )
}

fn input_format_score(format: SampleFormat) -> u8 {
    match format {
        // Capture at the best format offered by the driver. Output bit depth is
        // applied independently by the WAV writer.
        SampleFormat::F32 => 12,
        SampleFormat::I32 => 11,
        SampleFormat::I24 => 10,
        SampleFormat::F64 => 9,
        SampleFormat::I64 => 8,
        SampleFormat::I16 => 7,
        SampleFormat::U32 => 6,
        SampleFormat::U24 => 5,
        SampleFormat::U16 => 4,
        SampleFormat::I8 => 3,
        SampleFormat::U8 => 2,
        SampleFormat::U64 => 1,
        _ => 0,
    }
}

fn input_representation_bits(format: SampleFormat) -> Option<u16> {
    match format {
        SampleFormat::I8 | SampleFormat::U8 => Some(8),
        SampleFormat::I16 | SampleFormat::U16 => Some(16),
        SampleFormat::I24 | SampleFormat::U24 => Some(24),
        SampleFormat::I32 | SampleFormat::U32 => Some(32),
        SampleFormat::I64 | SampleFormat::U64 => Some(64),
        // IEEE-754 precision includes the implicit leading significand bit.
        // This describes the driver's sample representation, not ADC ENOB.
        SampleFormat::F32 => Some(24),
        SampleFormat::F64 => Some(53),
        _ => None,
    }
}

fn minimum_input_representation_bits(output_bit_depth: u16) -> Result<u16> {
    match output_bit_depth {
        16 => Ok(16),
        // A 32-bit float delivery file can preserve headroom and processing
        // precision, but commodity drivers normally expose f32 (24 bits of
        // significand precision). Requiring 32 here would wrongly reject the
        // native high-resolution path on most professional interfaces.
        24 | 32 => Ok(24),
        _ => bail!("unsupported output bit depth: {output_bit_depth}"),
    }
}

fn parse_requested_input_sample_format(value: &str) -> Result<Option<SampleFormat>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(match trimmed.to_ascii_lowercase().as_str() {
        "i16" => SampleFormat::I16,
        "i24" => SampleFormat::I24,
        "i32" => SampleFormat::I32,
        "f32" => SampleFormat::F32,
        other => bail!("不支持的采集格式：{other}。可选 i16、i24、i32、f32"),
    }))
}

fn delivery_bit_depth_for_sample_format(format: SampleFormat) -> u16 {
    match format {
        SampleFormat::I16 => 16,
        SampleFormat::I24 => 24,
        // i32 and f32 both land in the existing 32-bit Float WAV writer.
        SampleFormat::I32 | SampleFormat::F32 => 32,
        _ => 24,
    }
}

struct InputFormatCatalog {
    sample_rates: Vec<u32>,
    input_channels: Vec<u16>,
    configurations: Vec<Value>,
    available: bool,
    probe_error: Option<String>,
}

fn collect_input_format_catalog(device: &Device, exclusive: bool) -> InputFormatCatalog {
    let mut sample_rates = Vec::<u32>::new();
    let mut input_channels = Vec::<u16>::new();
    let mut configurations = Vec::<Value>::new();
    let mut probe_error = None;
    match device.supported_input_configs_for(exclusive) {
        Ok(configs) => {
            for config in configs {
                if !is_supported_input_format(config.sample_format()) {
                    continue;
                }
                input_channels.push(config.channels());
                sample_rates.push(config.min_sample_rate());
                sample_rates.push(config.max_sample_rate());
                configurations.push(json!({
                    "min_sample_rate": config.min_sample_rate(),
                    "max_sample_rate": config.max_sample_rate(),
                    "channels": config.channels(),
                    "sample_format": config.sample_format().to_string(),
                    "share_mode": if exclusive { "exclusive" } else { "shared" },
                }));
            }
        }
        Err(error) => {
            probe_error = Some(format!("{error:#}"));
        }
    }
    sample_rates.sort_unstable();
    sample_rates.dedup();
    input_channels.sort_unstable();
    input_channels.dedup();
    let available = !configurations.is_empty();
    InputFormatCatalog {
        sample_rates,
        input_channels,
        configurations,
        available,
        probe_error,
    }
}

fn catalog_sample_formats(catalog: &InputFormatCatalog) -> Vec<String> {
    let mut formats = catalog
        .configurations
        .iter()
        .filter_map(|configuration| {
            configuration
                .get("sample_format")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    formats.sort();
    formats.dedup();
    formats
}

fn select_config_candidates(
    device: &Device,
    sample_rate: u32,
    input_channel_index: usize,
    output_bit_depth: u16,
    share_mode: CaptureShareMode,
    requested_sample_format: Option<SampleFormat>,
) -> Result<Vec<SupportedStreamConfig>> {
    let minimum_representation_bits = if requested_sample_format.is_some() {
        0
    } else {
        minimum_input_representation_bits(output_bit_depth)?
    };
    let mut selected = Vec::<(
        crate::capture_select::InputConfigRank,
        usize,
        SupportedStreamConfig,
    )>::new();
    let mut compatible_rates = Vec::<(u32, u32)>::new();
    let mut formats_at_requested_rate = Vec::<(String, u16)>::new();
    let requested_channel = input_channel_index + 1;
    let exclusive = share_mode.is_exclusive();
    for range in device
        .supported_input_configs_for(exclusive)
        .context(if exclusive {
            "查询独占输入格式失败"
        } else {
            "query supported input formats"
        })?
    {
        if !is_supported_input_format(range.sample_format())
            || usize::from(range.channels()) <= input_channel_index
        {
            continue;
        }
        compatible_rates.push((range.min_sample_rate(), range.max_sample_rate()));
        if sample_rate < range.min_sample_rate() || sample_rate > range.max_sample_rate() {
            continue;
        }
        let representation_bits = input_representation_bits(range.sample_format())
            .context("supported input format has no representation precision")?;
        formats_at_requested_rate.push((range.sample_format().to_string(), representation_bits));
        if requested_sample_format.is_some_and(|requested| requested != range.sample_format()) {
            continue;
        }
        if requested_sample_format.is_none() && representation_bits < minimum_representation_bits {
            continue;
        }
        let rank = crate::capture_select::InputConfigRank {
            format_score: input_format_score(range.sample_format()),
            channels: range.channels(),
        };
        let config = range.with_sample_rate(sample_rate);
        selected.push((rank, selected.len(), config));
    }
    if !selected.is_empty() {
        selected.sort_by(|(left_rank, left_index, _), (right_rank, right_index, _)| {
            crate::capture_select::sort_key(exclusive, right_rank.format_score, right_rank.channels)
                .cmp(&crate::capture_select::sort_key(
                    exclusive,
                    left_rank.format_score,
                    left_rank.channels,
                ))
                .then(left_index.cmp(right_index))
        });
        return Ok(selected.into_iter().map(|(_, _, config)| config).collect());
    }
    if compatible_rates.is_empty() {
        if exclusive {
            bail!(
                "该输入设备未枚举到独占格式，无法以独占模式开流。请关闭占用该声卡的其他程序，或将采集模式改为「系统混音」。不会自动降级。"
            );
        }
        bail!(
            "input channel {requested_channel} is unavailable in every compatible format exposed by this device"
        );
    }
    if !formats_at_requested_rate.is_empty() {
        formats_at_requested_rate.sort_unstable();
        formats_at_requested_rate.dedup();
        let offered = formats_at_requested_rate
            .iter()
            .map(|(format, bits)| {
                if format.starts_with('f') {
                    format!("{format} (约 {bits} 位有效数字精度)")
                } else {
                    format!("{format} ({bits} 位整数表示)")
                }
            })
            .collect::<Vec<_>>()
            .join("、");
        if let Some(requested) = requested_sample_format {
            if exclusive {
                bail!(
                    "独占模式：所选设备在 {sample_rate} Hz、输入通道 {requested_channel} 不支持采集格式 {requested}。当前提供：{offered}。不会自动改选其他格式。"
                );
            }
            bail!(
                "系统混音：所选设备在 {sample_rate} Hz、输入通道 {requested_channel} 不支持采集格式 {requested}。当前提供：{offered}。"
            );
        }
        if exclusive {
            bail!(
                "独占模式：所选设备在 {sample_rate} Hz、输入通道 {requested_channel} 仅提供 {offered}，无法满足 {output_bit_depth}-bit 交付的最低 {minimum_representation_bits} 位输入有效数字精度。可改采样率/位深，或改为「系统混音」。不会自动降级。"
            );
        }
        bail!(
            "所选设备在 {sample_rate} Hz 、输入通道 {requested_channel} 仅提供 {offered}，无法满足 {output_bit_depth}-bit 交付的最低 {minimum_representation_bits} 位输入有效数字精度要求。这是驱动数字样本精度，不等同于声卡 ADC 的有效位数（ENOB）。"
        );
    }
    compatible_rates.sort_unstable();
    compatible_rates.dedup();
    let offered = compatible_rates
        .iter()
        .map(|(minimum, maximum)| {
            if minimum == maximum {
                format!("{minimum} Hz")
            } else {
                format!("{minimum}-{maximum} Hz")
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    if exclusive {
        bail!(
            "独占模式不支持 {sample_rate} Hz（输入通道 {requested_channel}）。该设备独占可用采样率：{offered}。请改采样率，或改为「系统混音」。不会自动降级。"
        );
    }
    bail!(
        "requested sample rate {sample_rate} Hz is unsupported on input channel {requested_channel}; compatible ranges: {offered}"
    )
}

#[allow(clippy::too_many_arguments)]
fn build_stream(
    device: &Device,
    config: &StreamConfig,
    format: SampleFormat,
    input_channel_index: usize,
    writer: Sender<WriterMessage>,
    captured: Arc<AtomicU64>,
    overflow: Arc<AtomicU64>,
    faulted: Arc<AtomicBool>,
    fault_persistence: CaptureFaultPersistence,
    capture_fault_code: Arc<AtomicU32>,
    peak_bits: Arc<AtomicU32>,
    rms_bits: Arc<AtomicU32>,
    queue: WriterQueueBudget,
    waveform: Sender<WaveformPacket>,
    silence: SilenceMonitor,
) -> Result<Stream> {
    match format {
        SampleFormat::F32 => build_typed_stream::<f32>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            |sample| sample,
        ),
        SampleFormat::F64 => build_typed_stream::<f64>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            |sample| sample as f32,
        ),
        SampleFormat::I8 => build_typed_stream::<i8>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            |sample| f32::from(sample) / 128.0,
        ),
        SampleFormat::I16 => build_typed_stream::<i16>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            |sample| f32::from(sample) / 32_768.0,
        ),
        SampleFormat::I24 => build_typed_stream::<I24>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            i24_to_f32,
        ),
        SampleFormat::I32 => build_typed_stream::<i32>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            |sample| (f64::from(sample) / 2_147_483_648.0) as f32,
        ),
        SampleFormat::I64 => build_typed_stream::<i64>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            |sample| (sample as f64 / 9_223_372_036_854_775_808.0) as f32,
        ),
        SampleFormat::U8 => build_typed_stream::<u8>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            |sample| (f32::from(sample) - 128.0) / 128.0,
        ),
        SampleFormat::U16 => build_typed_stream::<u16>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            |sample| (f32::from(sample) - 32_768.0) / 32_768.0,
        ),
        SampleFormat::U24 => build_typed_stream::<U24>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            u24_to_f32,
        ),
        SampleFormat::U32 => build_typed_stream::<u32>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue.clone(),
            waveform.clone(),
            silence.clone(),
            |sample| (f64::from(sample) - 2_147_483_648.0) as f32 / 2_147_483_648.0,
        ),
        SampleFormat::U64 => build_typed_stream::<u64>(
            device,
            config,
            input_channel_index,
            writer,
            captured,
            overflow,
            faulted,
            fault_persistence,
            capture_fault_code,
            peak_bits,
            rms_bits,
            queue,
            waveform,
            silence,
            |sample| {
                ((sample as f64 - 9_223_372_036_854_775_808.0) / 9_223_372_036_854_775_808.0) as f32
            },
        ),
        _ => bail!("unsupported sample format {format:?}"),
    }
}

#[allow(clippy::too_many_arguments)]
fn build_typed_stream<T>(
    device: &Device,
    config: &StreamConfig,
    input_channel_index: usize,
    writer: Sender<WriterMessage>,
    captured: Arc<AtomicU64>,
    overflow: Arc<AtomicU64>,
    faulted: Arc<AtomicBool>,
    fault_persistence: CaptureFaultPersistence,
    capture_fault_code: Arc<AtomicU32>,
    peak_bits: Arc<AtomicU32>,
    rms_bits: Arc<AtomicU32>,
    queue: WriterQueueBudget,
    waveform: Sender<WaveformPacket>,
    silence: SilenceMonitor,
    convert: fn(T) -> f32,
) -> Result<Stream>
where
    T: SizedSample + Copy + Send + 'static,
{
    let channels = usize::from(config.channels);
    if input_channel_index >= channels {
        bail!(
            "input channel {} exceeds the active device channel count {channels}",
            input_channel_index + 1
        );
    }
    let error_emitter = Arc::clone(&faulted);
    let error_capture_fault_code = Arc::clone(&capture_fault_code);
    let error_writer = writer.clone();
    let error_queue = queue.clone();
    let error_fault_persistence = fault_persistence.clone();
    let mut waveform_preview =
        CaptureWaveformPreview::new(waveform, captured.load(Ordering::Acquire));
    Ok(device.build_input_stream(
        *config,
        move |data: &[T], _| {
            // Some backends can wake the callback without exposing a packet.
            // It carries no timeline information and must not consume queue
            // budget or place a zero-frame message in the unbounded channel.
            if data.is_empty() {
                return;
            }
            // Count only buffers that carry timeline data. Repeated empty
            // backend wakeups must not mask a driver that has stopped
            // delivering audio packets.
            saturating_atomic_add(&silence.capture_heartbeat, 1);
            // Register the callback before doing any conversion or metering.
            // A clean stop closes this gate and waits for every callback that
            // already entered it, so a callback descheduled during conversion
            // cannot silently lose the device's final buffer.
            let Some(enqueue_lease) = queue.enter() else {
                if faulted.load(Ordering::Acquire) {
                    saturating_atomic_add(&overflow, data.len().div_ceil(channels) as u64);
                }
                return;
            };
            match convert_frames(data, channels, input_channel_index, convert) {
                Ok(mono) => publish_leased_block_with_preview(
                    mono,
                    &writer,
                    &captured,
                    &overflow,
                    &faulted,
                    &peak_bits,
                    &rms_bits,
                    &queue,
                    enqueue_lease,
                    &silence,
                    Some(&fault_persistence),
                    Some(&mut waveform_preview),
                ),
                Err(error) => fail_capture_block(
                    error.reason,
                    error.dropped_frames,
                    &writer,
                    &overflow,
                    &faulted,
                    &queue,
                    enqueue_lease,
                    Some(&fault_persistence),
                ),
            }
        },
        move |error| {
            if let Some(missing_frames) = recovered_xrun_missing_frames(&error) {
                saturating_atomic_add(&error_fault_persistence.recovery.discontinuities, 1);
                saturating_atomic_add(
                    &error_fault_persistence.recovery.inserted_silence_frames,
                    missing_frames,
                );
                eprintln!("recoverable audio input discontinuity: {error}");
                return;
            }
            latch_capture_fault_code(&error_capture_fault_code, input_stream_fault_code(&error));
            let reason = format!("audio input stream failed: {error}");
            error_emitter.store(true, Ordering::Release);
            // Reject later callback entries before touching the recording
            // volume. The driver error callback may be a real-time thread, so
            // it only activates the already-created generic reserve here; the
            // writer/telemetry threads enrich it with the detailed reason.
            error_queue.close();
            if !error_fault_persistence.activate_reserved_marker() {
                eprintln!("audio input stream fault could not activate its reserved marker");
            }
            error_queue.close_and_wait();
            eprintln!("audio stream error: {error}");
            let _ = error_writer.try_send(WriterMessage::FaultAndStop(reason));
        },
        None,
    )?)
}

fn convert_frames<T: Copy>(
    input: &[T],
    channels: usize,
    input_channel_index: usize,
    convert: impl Fn(T) -> f32,
) -> std::result::Result<Vec<f32>, CaptureBlockError> {
    if input.is_empty() {
        return Ok(Vec::new());
    }
    if channels == 0 || input_channel_index >= channels {
        return Err(CaptureBlockError {
            reason: "audio callback exposed an invalid channel configuration".to_string(),
            dropped_frames: input.len() as u64,
        });
    }
    let dropped_frames = input.len().div_ceil(channels) as u64;
    if !input.len().is_multiple_of(channels) {
        return Err(CaptureBlockError {
            reason: format!(
                "audio callback returned {} samples that do not form complete {channels}-channel frames",
                input.len()
            ),
            dropped_frames,
        });
    }
    let mut mono = Vec::with_capacity(input.len() / channels);
    for (frame_index, frame) in input.chunks_exact(channels).enumerate() {
        let sample = convert(frame[input_channel_index]);
        if !sample.is_finite() {
            return Err(CaptureBlockError {
                reason: format!(
                    "audio callback returned a non-finite sample at frame {frame_index}"
                ),
                dropped_frames,
            });
        }
        // Preserve finite float headroom for 32-bit float delivery. PCM
        // saturation belongs in the encoding branch of the WAV writer; the
        // meter independently clamps its display range and reports overload.
        mono.push(sample);
    }
    Ok(mono)
}

fn normalize_i24_raw(raw: i32, left_aligned_in_i32: bool) -> f32 {
    let value = if left_aligned_in_i32 { raw >> 8 } else { raw };
    value as f32 / 8_388_608.0
}

fn normalize_u24_raw(raw: i32, left_aligned_in_i32: bool) -> f32 {
    let bits = raw as u32;
    let value = if left_aligned_in_i32 { bits >> 8 } else { bits };
    (value as f32 - 8_388_608.0) / 8_388_608.0
}

fn i24_to_f32(sample: I24) -> f32 {
    // WASAPI exposes 24 valid PCM bits left-aligned in a 32-bit container.
    // CPAL 0.18.1 casts that container directly to its i32-backed I24 wrapper,
    // so Windows needs an arithmetic shift before normalization. Other CPAL
    // backends provide the wrapper's normal signed 24-bit logical value.
    normalize_i24_raw(sample.inner(), cfg!(target_os = "windows"))
}

fn u24_to_f32(sample: U24) -> f32 {
    normalize_u24_raw(sample.inner(), cfg!(target_os = "windows"))
}

#[allow(clippy::too_many_arguments)]
fn fail_capture_block(
    reason: String,
    dropped_frames: u64,
    writer: &Sender<WriterMessage>,
    overflow: &AtomicU64,
    faulted: &AtomicBool,
    queue: &WriterQueueBudget,
    enqueue_lease: WriterQueueLease<'_>,
    fault_persistence: Option<&CaptureFaultPersistence>,
) {
    let reason = format!("{reason}; dropped_frames={dropped_frames}");
    faulted.store(true, Ordering::Release);
    saturating_atomic_add(overflow, dropped_frames);
    // Close the entry gate before touching the recording volume so no later
    // callback can extend the accepted timeline after this known discontinuity.
    // The callback only activates the already-created generic reserve; detailed
    // JSON persistence belongs to the writer/telemetry non-real-time threads.
    queue.close();
    if let Some(persistence) = fault_persistence
        && !persistence.activate_reserved_marker()
    {
        eprintln!("capture callback fault could not activate its reserved marker");
    }
    // Publish the generic marker before dropping this callback's lease and
    // waiting. Once every older callback has left its enqueue path, the fault
    // sentinel is guaranteed to sit behind every Samples message that was
    // accepted before the bad block.
    drop(enqueue_lease);
    queue.close_and_wait();
    let _ = writer.try_send(WriterMessage::FaultAndStop(reason));
}

#[cfg(any(test, feature = "system-test", not(windows)))]
#[allow(clippy::too_many_arguments)]
fn publish_block(
    mono: Vec<f32>,
    writer: &Sender<WriterMessage>,
    captured: &AtomicU64,
    overflow: &AtomicU64,
    faulted: &AtomicBool,
    peak_bits: &AtomicU32,
    rms_bits: &AtomicU32,
    queue: &WriterQueueBudget,
    silence: &SilenceMonitor,
) {
    let frames = mono.len() as u64;
    if frames == 0 {
        return;
    }
    let Some(enqueue_lease) = queue.enter() else {
        if faulted.load(Ordering::Acquire) {
            saturating_atomic_add(overflow, frames);
        }
        return;
    };
    publish_leased_block(
        mono,
        writer,
        captured,
        overflow,
        faulted,
        peak_bits,
        rms_bits,
        queue,
        enqueue_lease,
        silence,
    );
}

#[cfg(any(test, feature = "system-test", not(windows)))]
#[allow(clippy::too_many_arguments)]
fn publish_leased_block(
    mono: Vec<f32>,
    writer: &Sender<WriterMessage>,
    captured: &AtomicU64,
    overflow: &AtomicU64,
    faulted: &AtomicBool,
    peak_bits: &AtomicU32,
    rms_bits: &AtomicU32,
    queue: &WriterQueueBudget,
    enqueue_lease: WriterQueueLease<'_>,
    silence: &SilenceMonitor,
) {
    publish_leased_block_with_preview(
        mono,
        writer,
        captured,
        overflow,
        faulted,
        peak_bits,
        rms_bits,
        queue,
        enqueue_lease,
        silence,
        None,
        None,
    );
}

#[allow(clippy::too_many_arguments)]
fn publish_leased_block_with_preview(
    mono: Vec<f32>,
    writer: &Sender<WriterMessage>,
    captured: &AtomicU64,
    overflow: &AtomicU64,
    faulted: &AtomicBool,
    peak_bits: &AtomicU32,
    rms_bits: &AtomicU32,
    queue: &WriterQueueBudget,
    enqueue_lease: WriterQueueLease<'_>,
    silence: &SilenceMonitor,
    fault_persistence: Option<&CaptureFaultPersistence>,
    mut waveform_preview: Option<&mut CaptureWaveformPreview>,
) {
    let frames = mono.len() as u64;
    if frames == 0 {
        drop(enqueue_lease);
        return;
    }
    if mono.iter().any(|sample| !sample.is_finite()) {
        fail_capture_block(
            "audio callback produced a non-finite normalized sample".to_string(),
            frames,
            writer,
            overflow,
            faulted,
            queue,
            enqueue_lease,
            fault_persistence,
        );
        return;
    }
    let digital_silence_block = analyze_digital_silence_block(&mono);
    silence.bandwidth.push(&mono);
    let mut peak = 0f32;
    let mut square_sum = 0f64;
    for sample in &mono {
        let normalized = sample.clamp(-1.0, 1.0);
        peak = peak.max(normalized.abs());
        square_sum += f64::from(normalized) * f64::from(normalized);
    }
    let rms = if mono.is_empty() {
        0.0
    } else {
        (square_sum / mono.len() as f64).sqrt() as f32
    };
    let vad_generation = silence.analysis.generation.load(Ordering::Acquire);
    let vad_wants_block =
        silence.analysis.uses_vad() && !silence.analysis.generation_is_degraded(vad_generation);
    // Reserve both hard limits before copying PCM. A full analysis queue is
    // isolated to VAD diagnostics and never delays or rejects the master write.
    let vad_reserved = vad_wants_block && silence.analysis.queue.try_reserve(frames);
    let vad_copy = vad_reserved.then(|| mono.clone());
    if !queue.reserve(frames) {
        if vad_reserved {
            silence.analysis.queue.release(frames);
        }
        fail_capture_block(
            "audio writer queue exceeded its 20 second frame budget".to_string(),
            frames,
            writer,
            overflow,
            faulted,
            queue,
            enqueue_lease,
            fault_persistence,
        );
        return;
    }
    let Some((block_start, block_end)) = reserve_counter_range(captured, frames) else {
        queue.release(frames);
        if vad_reserved {
            silence.analysis.queue.release(frames);
        }
        fail_capture_block(
            "audio capture timeline counter overflow".to_string(),
            frames,
            writer,
            overflow,
            faulted,
            queue,
            enqueue_lease,
            fault_persistence,
        );
        return;
    };
    let waveform_packet = waveform_preview
        .as_deref_mut()
        .and_then(|preview| preview.prepare(block_start, &mono));
    if writer.try_send(WriterMessage::Samples(mono)).is_err() {
        queue.release(frames);
        if vad_reserved {
            silence.analysis.queue.release(frames);
        }
        let rollback_succeeded = captured
            .compare_exchange(block_end, block_start, Ordering::AcqRel, Ordering::Acquire)
            .is_ok();
        let reason = if rollback_succeeded {
            "audio writer channel disconnected before accepting the callback block".to_string()
        } else {
            "audio writer channel disconnected and the capture timeline reservation could not be rolled back"
                .to_string()
        };
        fail_capture_block(
            reason,
            frames,
            writer,
            overflow,
            faulted,
            queue,
            enqueue_lease,
            fault_persistence,
        );
        return;
    }
    if let (Some(preview), Some(packet)) = (waveform_preview, waveform_packet) {
        preview.publish(packet);
    }
    // The checked timeline reservation is retained only after the complete
    // finite block has entered the writer queue. Once enqueueing fails, later
    // callbacks are rejected so WAV frames and sample annotations cannot drift.
    let analysis_write = begin_analysis_write(&silence.analysis_epoch);
    let previous_digital_silence = silence.digital_silence_samples.load(Ordering::Acquire);
    silence.digital_silence_samples.store(
        apply_digital_silence_block(previous_digital_silence, digital_silence_block),
        Ordering::Release,
    );
    let use_vad = silence.analysis.uses_vad();
    if use_vad {
        drop(analysis_write);
        if vad_wants_block && !vad_reserved {
            silence.analysis.telemetry.latch_issue(
                vad_generation,
                VAD_ISSUE_QUEUE_OVERFLOW,
                block_start,
                block_end,
            );
        }
        if let Some(samples) = vad_copy {
            let generation = vad_generation;
            let vad_frames = block_end.saturating_sub(block_start);
            if let Some(tx) = silence.analysis.tx.as_ref() {
                match tx.try_send(VadAnalysisBlock {
                    samples,
                    block_start,
                    block_end,
                    generation,
                }) {
                    Ok(()) => {}
                    Err(TrySendError::Full(block)) => {
                        silence.analysis.queue.release(vad_frames);
                        silence.analysis.telemetry.latch_issue(
                            generation,
                            VAD_ISSUE_QUEUE_OVERFLOW,
                            block.block_start,
                            block.block_end,
                        );
                    }
                    Err(TrySendError::Disconnected(block)) => {
                        silence.analysis.queue.release(vad_frames);
                        silence.analysis.telemetry.latch_issue(
                            generation,
                            VAD_ISSUE_WORKER_DISCONNECTED,
                            block.block_start,
                            block.block_end,
                        );
                    }
                }
            } else {
                silence.analysis.queue.release(vad_frames);
                silence.analysis.telemetry.latch_issue(
                    generation,
                    VAD_ISSUE_WORKER_DISCONNECTED,
                    block_start,
                    block_end,
                );
            }
        }
        let previous_peak = f32::from_bits(peak_bits.load(Ordering::Relaxed));
        let previous_rms = f32::from_bits(rms_bits.load(Ordering::Relaxed));
        let smoothed_peak = peak.max(previous_peak * 0.86);
        let smoothed_rms = if previous_rms <= f32::EPSILON {
            rms
        } else {
            previous_rms * 0.72 + rms * 0.28
        };
        peak_bits.store(smoothed_peak.to_bits(), Ordering::Relaxed);
        rms_bits.store(smoothed_rms.to_bits(), Ordering::Relaxed);
        return;
    }
    if vad_reserved {
        // Detector selection changed between reservation and publication.
        silence.analysis.queue.release(frames);
    }
    annotate_attempt_block(
        &silence.head_silence,
        &silence.silence_samples,
        &silence.last_signal_sample,
        &silence.attempt_signal_start_sample,
        energy_is_speech(&silence.threshold_bits, rms),
        frames,
        block_start,
        block_end,
    );
    // Publish this only after every signal/silence annotation for the accepted
    // range is visible. `stop_attempt` uses the watermark as the acquire side
    // of that boundary before deciding whether a take contains speech.
    silence
        .analyzed_samples
        .fetch_max(block_end, Ordering::Release);
    drop(analysis_write);
    let previous_peak = f32::from_bits(peak_bits.load(Ordering::Relaxed));
    let previous_rms = f32::from_bits(rms_bits.load(Ordering::Relaxed));
    let smoothed_peak = peak.max(previous_peak * 0.86);
    let smoothed_rms = if previous_rms <= f32::EPSILON {
        rms
    } else {
        previous_rms * 0.72 + rms * 0.28
    };
    peak_bits.store(smoothed_peak.to_bits(), Ordering::Relaxed);
    rms_bits.store(smoothed_rms.to_bits(), Ordering::Relaxed);
}

fn waveform_bins(samples: &[f32]) -> Vec<[f32; 2]> {
    samples
        .chunks(WAVEFORM_BIN_SAMPLES)
        .map(|chunk| {
            let mut minimum = 0f32;
            let mut maximum = 0f32;
            for sample in chunk {
                let normalized = sample.clamp(-1.0, 1.0);
                minimum = minimum.min(normalized);
                maximum = maximum.max(normalized);
            }
            [minimum, maximum]
        })
        .collect()
}

fn linear_to_dbfs(value: f32) -> f32 {
    if value <= 0.000_015_85 {
        -96.0
    } else {
        (20.0 * value.log10()).max(-96.0)
    }
}

fn evaluate_noise(samples: &[f32], threshold_dbfs: f32) -> (bool, usize) {
    const WINDOW_SIZE: usize = 5;
    let failing_windows = samples
        .chunks(WINDOW_SIZE)
        .take(3)
        .filter(|window| window.iter().any(|sample| *sample >= threshold_dbfs))
        .count();
    (failing_windows < 2, failing_windows)
}

fn durable_copy_file(source: &Path, destination: &Path) -> Result<u64> {
    if source == destination {
        bail!("cannot copy an export over its source file");
    }
    let file_name = destination
        .file_name()
        .context("copy destination has no file name")?;
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(".copying");
    let temporary = destination.with_file_name(temporary_name);
    match std::fs::symlink_metadata(&temporary) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!(
                    "temporary copy must be a regular file: {}",
                    temporary.display()
                );
            }
            std::fs::remove_file(&temporary)
                .with_context(|| format!("remove stale copy {}", temporary.display()))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let result = (|| -> Result<u64> {
        let mut input =
            File::open(source).with_context(|| format!("open copy source {}", source.display()))?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .with_context(|| format!("create temporary copy {}", temporary.display()))?;
        let copied = std::io::copy(&mut input, &mut output)?;
        output.flush()?;
        output.sync_all()?;
        drop(output);
        durable_replace(&temporary, destination)?;
        Ok(copied)
    })();
    if result.is_err()
        && let Ok(metadata) = std::fs::symlink_metadata(&temporary)
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn write_empty_wav_export(destination: &Path, sample_rate: u32, bit_depth: u16) -> Result<()> {
    let (temporary, file) = create_unique_temporary_file(destination, "empty-wav")?;
    drop(file);
    std::fs::remove_file(&temporary)?;
    let result = (|| -> Result<()> {
        WavExportWriter::create_new(
            &temporary,
            sample_rate,
            1,
            bit_depth,
            0,
            WavExportMode::AutoRf64,
        )?
        .finalize()?;
        durable_replace(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn append_journal_event(
    path: &Path,
    value: &impl Serialize,
    fault: JournalAppendFault,
) -> std::result::Result<(), JournalAppendFailure> {
    let mut line = serde_json::to_vec(value).map_err(|error| JournalAppendFailure {
        operation: format!("serialize journal event: {error}"),
        rollback: None,
    })?;
    line.push(b'\n');
    if let Ok(metadata) = std::fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(JournalAppendFailure {
            operation: format!("journal path {} is not a regular file", path.display()),
            rollback: None,
        });
    }
    let mut events = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(path)
        .map_err(|error| JournalAppendFailure {
            operation: format!("open journal {}: {error}", path.display()),
            rollback: None,
        })?;
    let original_len = events
        .metadata()
        .map_err(|error| JournalAppendFailure {
            operation: format!("inspect journal {}: {error}", path.display()),
            rollback: None,
        })?
        .len();
    if original_len > 0 {
        events
            .seek(SeekFrom::End(-1))
            .map_err(|error| JournalAppendFailure {
                operation: format!("inspect journal tail {}: {error}", path.display()),
                rollback: None,
            })?;
        let mut final_byte = [0u8; 1];
        events
            .read_exact(&mut final_byte)
            .map_err(|error| JournalAppendFailure {
                operation: format!("read journal tail {}: {error}", path.display()),
                rollback: None,
            })?;
        if final_byte[0] != b'\n' {
            // A crash may lose only the terminator after an otherwise complete
            // JSON event. Keep the separator in the same rollback transaction
            // as the new event so the two objects can never become `}{`.
            line.insert(0, b'\n');
        }
    }
    if checked_journal_append_len(original_len, line.len()).is_none() {
        return Err(JournalAppendFailure {
            operation: format!(
                "journal append would exceed the recoverable {} byte limit (current={original_len}, append={})",
                JOURNAL_MAX_BYTES,
                line.len()
            ),
            rollback: None,
        });
    }
    let operation = (|| -> Result<()> {
        if matches!(
            fault,
            JournalAppendFault::DuringWrite | JournalAppendFault::DuringWriteAndRollback
        ) {
            let partial_len = (line.len() / 2).max(1);
            events.write_all(&line[..partial_len])?;
            bail!("injected journal write failure");
        }
        events.write_all(&line)?;
        if fault == JournalAppendFault::AfterWrite {
            bail!("injected journal failure after write");
        }
        events.flush()?;
        if fault == JournalAppendFault::AfterFlush {
            bail!("injected journal failure after flush");
        }
        events.sync_data()?;
        if fault == JournalAppendFault::AfterSync {
            bail!("injected journal failure after sync");
        }
        // `sync_data` does not make the directory entry of a newly-created
        // events file durable on Unix. Keep the namespace ordered before any
        // replaceable snapshot is advanced.
        sync_parent_directory(path)?;
        Ok(())
    })();
    if let Err(error) = operation {
        // On Windows an append-only handle is opened with FILE_APPEND_DATA,
        // which deliberately does not grant the FILE_WRITE_DATA permission
        // required by SetEndOfFile. Close that handle before reopening the
        // journal with ordinary write access for the rollback. Keeping the
        // append handle alive here makes File::set_len fail with ERROR_ACCESS_DENIED
        // even though the process itself owns the journal.
        drop(events);
        let rollback = if fault == JournalAppendFault::DuringWriteAndRollback {
            Err(anyhow!("injected journal rollback failure"))
        } else {
            (|| -> Result<()> {
                let metadata = std::fs::symlink_metadata(path).with_context(|| {
                    format!("inspect journal before rollback {}", path.display())
                })?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    bail!("journal path {} is not a regular file", path.display());
                }
                if metadata.len() < original_len {
                    bail!(
                        "journal {} shrank from {} to {} bytes before rollback",
                        path.display(),
                        original_len,
                        metadata.len()
                    );
                }
                let rollback_events = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(path)
                    .with_context(|| format!("reopen journal for rollback {}", path.display()))?;
                rollback_events.set_len(original_len)?;
                rollback_events.sync_all()?;
                Ok(())
            })()
        };
        return Err(JournalAppendFailure {
            operation: format!("append journal {}: {error:#}", path.display()),
            rollback: rollback.err().map(|error| format!("{error:#}")),
        });
    }
    Ok(())
}

fn checked_journal_append_len(current_len: u64, append_len: usize) -> Option<u64> {
    let append_len = u64::try_from(append_len).ok()?;
    current_len
        .checked_add(append_len)
        .filter(|next_len| *next_len <= JOURNAL_MAX_BYTES)
}

fn snapshot_file_is_valid(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > SNAPSHOT_MAX_BYTES
    {
        return false;
    }
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<SessionSnapshot>(&bytes).ok())
        .is_some_and(|snapshot| snapshot.schema_version == 1 && !snapshot.session_id.is_empty())
}

fn atomic_snapshot_json(path: &Path, value: &SessionSnapshot) -> Result<()> {
    let (temporary, mut file) = create_unique_temporary_file(path, "snapshot")?;
    let previous = path.with_extension("prev");
    let result = (|| -> Result<()> {
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        // File destructors run at the end of the scope, not necessarily after
        // the last use. MoveFileExW rejects an open source handle on Windows.
        drop(file);

        match std::fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                bail!("snapshot path {} is not a regular file", path.display());
            }
            Ok(_) if snapshot_file_is_valid(path) => {
                // Rotate the last known-good generation without copying it. If
                // the process dies between the two renames, recovery can use
                // `prev`; the authoritative journal retains the newer state.
                durable_replace(path, &previous)?;
            }
            Ok(_) => {
                // Do not overwrite a known-good previous generation with a
                // corrupt final file. The synced temporary replaces the bad
                // final directly.
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        durable_replace(&temporary, path)?;
        Ok(())
    })();
    remove_failed_temporary(&temporary, result.is_err());
    result
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let (temporary, mut file) = create_unique_temporary_file(path, "json")?;
    let result = (|| -> Result<()> {
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        durable_replace(&temporary, path)?;
        Ok(())
    })();
    remove_failed_temporary(&temporary, result.is_err());
    result
}

fn atomic_json_line(path: &Path, value: &impl Serialize) -> Result<()> {
    let (temporary, mut file) = create_unique_temporary_file(path, "compact")?;
    let result = (|| -> Result<()> {
        serde_json::to_writer(&mut file, value)?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        durable_replace(&temporary, path)?;
        Ok(())
    })();
    remove_failed_temporary(&temporary, result.is_err());
    result
}

fn safe_file_name(value: &str) -> String {
    let mut sanitized: String = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect();
    sanitized = sanitized.trim().trim_end_matches(['.', ' ']).to_string();
    if sanitized.is_empty() {
        return "item".to_string();
    }
    // Win32 reserves device names even when an extension follows (for
    // example `CON.txt` and `COM1.take`). Check the stem before the first dot,
    // trimming the spaces/dots that Win32 ignores at that boundary.
    let upper = sanitized
        .split('.')
        .next()
        .unwrap_or(&sanitized)
        .trim_end_matches(['.', ' '])
        .to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && matches!(upper.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        sanitized.insert(0, '_');
    }
    sanitized
}

const MAX_SENTENCE_FILE_NAME_UTF16_UNITS: usize = 200;
const MAX_SENTENCE_FILE_NAME_UTF8_BYTES: usize = 200;

fn truncate_portable_file_stem(
    value: &str,
    maximum_utf8_bytes: usize,
    maximum_utf16_units: usize,
) -> String {
    let mut utf8_bytes = 0usize;
    let mut utf16_units = 0usize;
    value
        .chars()
        .take_while(|character| {
            let next_utf8_bytes = utf8_bytes.saturating_add(character.len_utf8());
            let next_utf16_units = utf16_units.saturating_add(character.len_utf16());
            if next_utf8_bytes > maximum_utf8_bytes || next_utf16_units > maximum_utf16_units {
                return false;
            }
            utf8_bytes = next_utf8_bytes;
            utf16_units = next_utf16_units;
            true
        })
        .collect()
}

fn bounded_wav_stem(value: &str, suffix: &str) -> Result<String> {
    let fixed_utf8_bytes = suffix
        .len()
        .checked_add(".wav".len())
        .context("WAV file suffix length overflow")?;
    let fixed_utf16_units = suffix
        .encode_utf16()
        .count()
        .checked_add(".wav".encode_utf16().count())
        .context("WAV file suffix length overflow")?;
    let maximum_utf8_bytes = MAX_SENTENCE_FILE_NAME_UTF8_BYTES
        .checked_sub(fixed_utf8_bytes)
        .context("WAV file suffix is too long")?;
    let maximum_utf16_units = MAX_SENTENCE_FILE_NAME_UTF16_UNITS
        .checked_sub(fixed_utf16_units)
        .context("WAV file suffix is too long")?;
    let mut stem = truncate_portable_file_stem(
        &safe_file_name(value),
        maximum_utf8_bytes,
        maximum_utf16_units,
    );
    stem = stem.trim_end_matches(['.', ' ']).to_string();
    if stem.is_empty() {
        stem = "item".to_string();
    }
    stem.push_str(suffix);
    Ok(stem)
}

/// A conservative, ASCII-only comparison key for portable file bookkeeping.
/// Unicode is upper-cased before byte escaping, which deliberately folds
/// Windows-equivalent cases such as sigma/final-sigma without relying on the
/// host filesystem's locale. Planned sentence names also carry a unique ASCII
/// sequence prefix, so NFC/NFD aliases cannot target the same real path.
fn portable_file_name_key(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut key = String::with_capacity(value.len());
    for character in value.chars().flat_map(char::to_uppercase) {
        if character.is_ascii() && character != '%' {
            key.push(character);
            continue;
        }
        let mut encoded = [0u8; 4];
        for byte in character.encode_utf8(&mut encoded).as_bytes() {
            key.push('%');
            key.push(char::from(HEX[usize::from(byte >> 4)]));
            key.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    key
}

fn allocate_sentence_file_name(
    item_id: &str,
    item_index: usize,
    used_file_names: &mut std::collections::HashSet<String>,
) -> Result<String> {
    let item_number = item_index
        .checked_add(1)
        .context("sentence export item number overflow")?;
    let prefix = format!("{item_number:06}-");
    let suffix = ".wav";
    let reserved_utf8_bytes = prefix
        .len()
        .checked_add(suffix.len())
        .context("sentence export fixed name length overflow")?;
    let reserved_utf16_units = prefix
        .encode_utf16()
        .count()
        .checked_add(suffix.encode_utf16().count())
        .context("sentence export fixed name length overflow")?;
    let maximum_stem_utf8_bytes = MAX_SENTENCE_FILE_NAME_UTF8_BYTES
        .checked_sub(reserved_utf8_bytes)
        .context("sentence export prefix is too long")?;
    let maximum_stem_utf16_units = MAX_SENTENCE_FILE_NAME_UTF16_UNITS
        .checked_sub(reserved_utf16_units)
        .context("sentence export prefix is too long")?;
    let mut bounded_stem = truncate_portable_file_stem(
        &safe_file_name(item_id),
        maximum_stem_utf8_bytes,
        maximum_stem_utf16_units,
    );
    bounded_stem = bounded_stem.trim_end_matches(['.', ' ']).to_string();
    if bounded_stem.is_empty() {
        bounded_stem = "item".to_string();
    }
    let candidate = format!("{prefix}{bounded_stem}{suffix}");
    if !used_file_names.insert(portable_file_name_key(&candidate)) {
        bail!("sentence export sequence prefix collision for item {item_number}");
    }
    Ok(candidate)
}

fn existing_export_file_size(path: &Path, description: &str) -> Result<Option<u64>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            bail!("{description}必须是普通文件：{}", path.display());
        }
        Ok(metadata) => Ok(Some(metadata.len())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            Err(error).with_context(|| format!("inspect {description} {}", path.display()))
        }
    }
}

fn planned_export_allocation(logical_bytes: u64) -> Result<u64> {
    logical_bytes
        .checked_add(EXPORT_FILE_ALLOCATION_HEADROOM_BYTES)
        .context("export file allocation estimate overflow")
}

fn existing_export_allocation(logical_bytes: Option<u64>) -> u64 {
    // Do not credit estimated allocation padding on an old file: its actual
    // allocation unit is not available portably (notably on Windows), so only
    // its measured logical bytes are guaranteed to be reclaimed.
    logical_bytes.unwrap_or(0)
}

fn existing_sentence_wav_sizes(directory: &Path) -> Result<Vec<u64>> {
    let mut sizes = Vec::new();
    for entry in std::fs::read_dir(directory)
        .with_context(|| format!("inspect sentence exports {}", directory.display()))?
    {
        let entry = entry?;
        let file_name = entry.file_name();
        let file_name = file_name
            .to_str()
            .context("sentence export contains a non-Unicode file name")?;
        if !portable_file_name_key(file_name).ends_with(".WAV") {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .with_context(|| format!("inspect stale sentence export {}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!(
                "stale sentence export must be a regular file: {}",
                path.display()
            );
        }
        sizes.push(metadata.len());
    }
    Ok(sizes)
}

fn export_metadata_headroom(snapshot: &SessionSnapshot) -> Result<u64> {
    // JSON + worst-case CSV escaping can coexist at the end of an export.
    // Keep additional fixed and per-file allocation headroom for status files,
    // filesystem block rounding, and serializer punctuation.
    let snapshot_bytes = u64::try_from(serde_json::to_vec(snapshot)?.len())?;
    let content_headroom = snapshot_bytes
        .checked_mul(3)
        .context("export metadata headroom overflow")?;
    EXPORT_METADATA_BASE_HEADROOM_BYTES
        .checked_add(content_headroom)
        .context("export metadata safety headroom overflow")
}

fn serialized_json_file_size(value: &impl Serialize) -> Result<u64> {
    u64::try_from(serde_json::to_vec_pretty(value)?.len())?
        .checked_add(1)
        .context("serialized JSON file size overflow")
}

fn remove_all_sentence_wavs(directory: &Path) -> Result<()> {
    let mut removed_any = false;
    for entry in std::fs::read_dir(directory)
        .with_context(|| format!("inspect sentence exports {}", directory.display()))?
    {
        let entry = entry?;
        let file_name = entry.file_name();
        let file_name = file_name
            .to_str()
            .context("sentence export contains a non-Unicode file name")?;
        if !portable_file_name_key(file_name).ends_with(".WAV") {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .with_context(|| format!("inspect stale sentence export {}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!(
                "stale sentence export must be a regular file: {}",
                path.display()
            );
        }
        std::fs::remove_file(&path)
            .with_context(|| format!("remove stale sentence export {}", path.display()))?;
        removed_any = true;
    }
    if removed_any {
        sync_directory(directory)?;
    }
    Ok(())
}

fn create_unique_temporary_file(path: &Path, operation: &str) -> Result<(PathBuf, File)> {
    let file_name = path
        .file_name()
        .context("atomic destination has no file name")?;
    let timestamp = Utc::now().timestamp_micros();
    for _ in 0..128 {
        let sequence = TEMP_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let mut temporary_name = OsString::from(".");
        temporary_name.push(file_name);
        temporary_name.push(format!(
            ".{operation}-{}-{timestamp}-{sequence}.tmp",
            std::process::id()
        ));
        let temporary = path.with_file_name(temporary_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => return Ok((temporary, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("create temporary file {}", temporary.display()));
            }
        }
    }
    bail!("could not allocate a unique temporary file")
}

fn remove_failed_temporary(temporary: &Path, failed: bool) {
    if !failed {
        return;
    }
    if let Ok(metadata) = std::fs::symlink_metadata(temporary)
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        let _ = std::fs::remove_file(temporary);
    }
}

fn write_csv(path: &Path, exported: &Value) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            bail!("CSV export path must be a regular file: {}", path.display());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let (temporary, mut file) = create_unique_temporary_file(path, "csv")?;
    let result = (|| -> Result<()> {
        writeln!(
            file,
            "id,text,label,attempt_id,start_sample,recording_started_sample,head_silence_armed_sample,head_silence_passed_sample,required_head_silence_samples,content_started_sample,content_started_seconds,end_sample,duration_samples,file,forced_without_tail_silence,tail_silence_samples,required_tail_silence_samples"
        )?;
        if let Some(rows) = exported.as_array() {
            for row in rows {
                writeln!(
                    file,
                    "{},{},{},{},{},{},{},{},{},{},{:.6},{},{},{},{},{},{}",
                    csv_cell(row["id"].as_str().unwrap_or_default()),
                    csv_cell(row["text"].as_str().unwrap_or_default()),
                    csv_cell(row["label"].as_str().unwrap_or_default()),
                    csv_cell(row["attempt_id"].as_str().unwrap_or_default()),
                    row["start_sample"].as_u64().unwrap_or_default(),
                    row["recording_started_sample"].as_u64().unwrap_or_default(),
                    row["head_silence_armed_sample"]
                        .as_u64()
                        .unwrap_or_default(),
                    row["head_silence_passed_sample"]
                        .as_u64()
                        .unwrap_or_default(),
                    row["required_head_silence_samples"]
                        .as_u64()
                        .unwrap_or_default(),
                    row["content_started_sample"].as_u64().unwrap_or_default(),
                    row["content_started_seconds"].as_f64().unwrap_or_default(),
                    row["end_sample"].as_u64().unwrap_or_default(),
                    row["duration_samples"].as_u64().unwrap_or_default(),
                    csv_cell(row["file"].as_str().unwrap_or_default()),
                    row["forced_without_tail_silence"]
                        .as_bool()
                        .unwrap_or_default(),
                    row["tail_silence_samples"].as_u64().unwrap_or_default(),
                    row["required_tail_silence_samples"]
                        .as_u64()
                        .unwrap_or_default(),
                )?;
            }
        }
        file.flush()?;
        file.sync_all()?;
        drop(file);
        durable_replace(&temporary, path)?;
        Ok(())
    })();
    remove_failed_temporary(&temporary, result.is_err());
    result
}

fn stored_zip_size(plans: &[SentenceExportPlan], extra: Option<(&str, u64)>) -> Result<u64> {
    let mut total = 22u64;
    for plan in plans {
        let name_len = u64::try_from("cuts/".len() + plan.file_name.len())
            .context("ZIP file name too long")?;
        total = total
            .checked_add(30 + name_len + plan.file_bytes)
            .and_then(|value| value.checked_add(46 + name_len))
            .context("ZIP archive size overflow")?;
    }
    if let Some((name, bytes)) = extra {
        let name_len = u64::try_from(name.len()).context("ZIP file name too long")?;
        total = total
            .checked_add(30 + name_len + bytes)
            .and_then(|value| value.checked_add(46 + name_len))
            .context("ZIP archive size overflow")?;
    }
    Ok(total)
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320u32 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

fn write_stored_zip_entry(
    file: &mut File,
    central_entries: &mut Vec<(String, u32, u32, u32)>,
    name: String,
    bytes: &[u8],
) -> Result<()> {
    let size = u32::try_from(bytes.len()).context("ZIP entry is too large for ZIP32")?;
    let name_bytes = name.as_bytes();
    let name_len = u16::try_from(name_bytes.len()).context("ZIP file name too long")?;
    let checksum = crc32(bytes);
    let offset =
        u32::try_from(file.stream_position()?).context("ZIP archive exceeds ZIP32 limit")?;
    file.write_all(&0x04034b50u32.to_le_bytes())?;
    file.write_all(&20u16.to_le_bytes())?;
    file.write_all(&0u16.to_le_bytes())?;
    file.write_all(&0u16.to_le_bytes())?;
    file.write_all(&0u16.to_le_bytes())?;
    file.write_all(&0u16.to_le_bytes())?;
    file.write_all(&checksum.to_le_bytes())?;
    file.write_all(&size.to_le_bytes())?;
    file.write_all(&size.to_le_bytes())?;
    file.write_all(&name_len.to_le_bytes())?;
    file.write_all(&0u16.to_le_bytes())?;
    file.write_all(name_bytes)?;
    file.write_all(bytes)?;
    central_entries.push((name, checksum, size, offset));
    Ok(())
}

fn write_stored_zip(
    path: &Path,
    sentences_dir: &Path,
    plans: &[SentenceExportPlan],
    extra: Option<(&str, &[u8])>,
) -> Result<()> {
    let (temporary, mut file) = create_unique_temporary_file(path, "zip")?;
    let result = (|| -> Result<()> {
        let mut central_entries = Vec::<(String, u32, u32, u32)>::new();
        for plan in plans {
            let source = sentences_dir.join(&plan.file_name);
            let bytes = std::fs::read(&source)
                .with_context(|| format!("read exported cut {}", source.display()))?;
            let name = format!("cuts/{}", plan.file_name);
            write_stored_zip_entry(&mut file, &mut central_entries, name, &bytes)?;
        }
        if let Some((name, bytes)) = extra {
            write_stored_zip_entry(&mut file, &mut central_entries, name.to_string(), bytes)?;
        }
        let central_offset =
            u32::try_from(file.stream_position()?).context("ZIP archive exceeds ZIP32 limit")?;
        for (name, checksum, size, offset) in &central_entries {
            let name_bytes = name.as_bytes();
            let name_len = u16::try_from(name_bytes.len()).context("ZIP file name too long")?;
            file.write_all(&0x02014b50u32.to_le_bytes())?;
            file.write_all(&20u16.to_le_bytes())?;
            file.write_all(&20u16.to_le_bytes())?;
            file.write_all(&0u16.to_le_bytes())?;
            file.write_all(&0u16.to_le_bytes())?;
            file.write_all(&0u16.to_le_bytes())?;
            file.write_all(&0u16.to_le_bytes())?;
            file.write_all(&checksum.to_le_bytes())?;
            file.write_all(&size.to_le_bytes())?;
            file.write_all(&size.to_le_bytes())?;
            file.write_all(&name_len.to_le_bytes())?;
            file.write_all(&0u16.to_le_bytes())?;
            file.write_all(&0u16.to_le_bytes())?;
            file.write_all(&0u16.to_le_bytes())?;
            file.write_all(&0u16.to_le_bytes())?;
            file.write_all(&0u32.to_le_bytes())?;
            file.write_all(&offset.to_le_bytes())?;
            file.write_all(name_bytes)?;
        }
        let central_end =
            u32::try_from(file.stream_position()?).context("ZIP archive exceeds ZIP32 limit")?;
        let central_size = central_end
            .checked_sub(central_offset)
            .context("ZIP central directory underflow")?;
        let count =
            u16::try_from(central_entries.len()).context("too many files for ZIP32 archive")?;
        file.write_all(&0x06054b50u32.to_le_bytes())?;
        file.write_all(&0u16.to_le_bytes())?;
        file.write_all(&0u16.to_le_bytes())?;
        file.write_all(&count.to_le_bytes())?;
        file.write_all(&count.to_le_bytes())?;
        file.write_all(&central_size.to_le_bytes())?;
        file.write_all(&central_offset.to_le_bytes())?;
        file.write_all(&0u16.to_le_bytes())?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        durable_replace(&temporary, path)?;
        Ok(())
    })();
    remove_failed_temporary(&temporary, result.is_err());
    result
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("open {} for SHA-256", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("read {} for SHA-256", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static DEV_WEB_CAPTURE_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(feature = "system-test")]
    #[test]
    fn system_test_signal_patterns_are_exact_and_deterministic() {
        assert_eq!(
            system_test_sample(SystemTestSignalPattern::Silence, 9, 42, 48_000),
            0.0
        );
        let first = system_test_sample(SystemTestSignalPattern::Speech, 9, 42, 48_000);
        let second = system_test_sample(SystemTestSignalPattern::Speech, 9, 42, 48_000);
        assert_eq!(first, second);
        assert_ne!(first, 0.0);
        assert!((-1.0..=1.0).contains(&first));
    }

    #[cfg(feature = "system-test")]
    #[test]
    fn system_test_speech_pattern_is_recognized_as_voice() {
        let mut detector = earshot::Detector::default_boxed();
        for _ in 0..94 {
            let silence = [0.0; crate::vad::VAD_FRAME_SAMPLES];
            let _ = detector.predict_f32(&silence);
        }
        let mut speech_frames = 0usize;
        for frame_index in 0..96usize {
            let frame: Vec<f32> = (0..crate::vad::VAD_FRAME_SAMPLES)
                .map(|offset| {
                    let index = frame_index * crate::vad::VAD_FRAME_SAMPLES + offset;
                    system_test_sample(
                        SystemTestSignalPattern::Speech,
                        0x5a17,
                        index as u64,
                        16_000,
                    )
                })
                .collect();
            if detector.predict_f32(&frame) > 0.5 {
                speech_frames += 1;
            }
        }
        assert!(
            speech_frames >= 80,
            "system-test speech must be stably classified as voice; got {speech_frames}/96 frames"
        );
    }

    #[cfg(feature = "system-test")]
    #[test]
    fn system_test_feed_returns_authoritative_analysis_diagnostics() {
        let root = test_root("system-test-feed-diagnostics");
        std::fs::remove_dir_all(&root).unwrap();
        let mut engine = Engine::new(Emitter::new());
        engine
            .start_system_test_session(SystemTestStartSessionPayload {
                session: StartSessionPayload {
                    session_dir: root.to_string_lossy().into_owned(),
                    session_id: "system-test-feed-diagnostics".to_string(),
                    script_name: "script.csv".to_string(),
                    device_id: None,
                    device_name: None,
                    sample_rate: 48_000,
                    bit_depth: 24,
                    input_sample_format: "f32".to_string(),
                    input_channel: 1,
                    capture_share_mode: CaptureShareMode::Shared,
                    silence_duration_ms: 200,
                    noise_threshold_dbfs: Some(-42.0),
                    silence_threshold_dbfs: -42.0,
                    silence_detector: SilenceDetector::Energy,
                    items: vec![ScriptItem {
                        id: "001".to_string(),
                        text: "第一句".to_string(),
                        label: String::new(),
                    }],
                },
                segment_frames: 48_000,
            })
            .unwrap();
        engine.start_attempt("001", false).unwrap();

        let silence = engine
            .system_test_feed(9_600, 7, 256, SystemTestSignalPattern::Silence)
            .unwrap();
        assert_eq!(silence["pattern"], "silence");
        assert_eq!(silence["silence_samples"], 9_600);
        assert_eq!(silence["last_signal_sample"], 0);
        assert_eq!(silence["analyzed_samples"], 9_600);
        assert_eq!(silence["head_silence_phase"], "ready_for_speech");

        let speech = engine
            .system_test_feed(256, 7, 256, SystemTestSignalPattern::Speech)
            .unwrap();
        assert_eq!(speech["pattern"], "speech");
        assert_eq!(speech["silence_samples"], 0);
        assert_eq!(speech["last_signal_sample"], 9_856);
        assert_eq!(speech["analyzed_samples"], 9_856);
        assert_eq!(speech["head_silence_phase"], "speech_started");

        let tail = engine
            .system_test_feed(9_600, 8, 256, SystemTestSignalPattern::Silence)
            .unwrap();
        assert_eq!(tail["silence_samples"], 9_600);
        assert_eq!(tail["last_signal_sample"], 9_856);
        assert_eq!(tail["analyzed_samples"], 19_456);
        assert_eq!(tail["head_silence_phase"], "speech_started");
        engine.stop_attempt(false, false, false).unwrap();
        engine.stop_session().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "recorder-engine-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("metadata")).unwrap();
        root
    }

    fn test_writer_queue() -> WriterQueueBudget {
        WriterQueueBudget {
            queued_frames: Arc::new(AtomicU64::new(0)),
            enqueue_state: Arc::new(AtomicU64::new(0)),
            max_frames: 48_000 * WRITER_QUEUE_AUDIO_BUDGET_SECONDS,
        }
    }

    fn test_head_silence_monitor() -> HeadSilenceMonitor {
        HeadSilenceMonitor::new(48_000)
    }

    #[test]
    fn full_vad_budget_does_not_enqueue_a_block_or_fault_master_capture() {
        let vad_queue = VadQueueBudget::new(48_000);
        assert!(vad_queue.try_reserve(vad_queue.max_samples()));
        let (vad_tx, vad_rx) = bounded::<VadAnalysisBlock>(1_024);
        let telemetry = VadTelemetry::default();
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            analysis: SilenceAnalysisPorts {
                detector_kind: Arc::new(AtomicU32::new(DETECTOR_VAD)),
                generation: Arc::new(AtomicU64::new(7)),
                tx: Some(vad_tx),
                queue: vad_queue.clone(),
                telemetry: telemetry.clone(),
            },
        };
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = AtomicU64::new(0);
        let overflow = AtomicU64::new(0);
        let faulted = AtomicBool::new(false);
        let peak = AtomicU32::new(0f32.to_bits());
        let rms = AtomicU32::new(0f32.to_bits());
        let writer_queue = test_writer_queue();

        publish_block(
            vec![0.125; 256],
            &writer_tx,
            &captured,
            &overflow,
            &faulted,
            &peak,
            &rms,
            &writer_queue,
            &silence,
        );

        assert!(
            matches!(writer_rx.try_recv(), Ok(WriterMessage::Samples(samples)) if samples.len() == 256)
        );
        assert!(
            vad_rx.try_recv().is_err(),
            "full VAD queue must not receive PCM"
        );
        assert!(!faulted.load(Ordering::Acquire));
        assert_eq!(overflow.load(Ordering::Acquire), 0);
        assert_eq!(telemetry.overflow_count.load(Ordering::Acquire), 1);
        assert_eq!(vad_queue.queued_samples(), vad_queue.max_samples());
        vad_queue.release(vad_queue.max_samples());
        assert_eq!(vad_queue.queued_samples(), 0);
        assert_eq!(vad_queue.queued_blocks(), 0);
        writer_queue.release(256);
    }

    #[test]
    fn vad_health_reports_lagging_degraded_and_unavailable_in_priority_order() {
        let queue = VadQueueBudget::new(48_000);
        let (tx, _rx) = bounded::<VadAnalysisBlock>(1);
        let analysis = SilenceAnalysisPorts {
            detector_kind: Arc::new(AtomicU32::new(DETECTOR_VAD)),
            generation: Arc::new(AtomicU64::new(1)),
            tx: Some(tx),
            queue: queue.clone(),
            telemetry: VadTelemetry::default(),
        };
        assert_eq!(analysis.health_name(48_000), "healthy");
        assert!(queue.try_reserve(23_999));
        assert_eq!(analysis.health_name(48_000), "healthy");
        assert!(queue.try_reserve(1));
        assert_eq!(analysis.health_name(48_000), "lagging");

        analysis
            .telemetry
            .latch_issue(1, VAD_ISSUE_CLASSIFIER_FAILURE, 20_000, 24_000);
        assert_eq!(analysis.health_name(48_000), "degraded");
        analysis
            .telemetry
            .latch_issue(1, VAD_ISSUE_WORKER_DISCONNECTED, 24_000, 24_000);
        assert_eq!(analysis.health_name(48_000), "unavailable");

        queue.release(1);
        queue.release(23_999);
    }

    #[test]
    fn vad_degradation_isolated_to_the_active_take_and_retains_a_good_old_version() {
        for has_old_version in [false, true] {
            let root = test_root(if has_old_version {
                "vad-degraded-retains-old"
            } else {
                "vad-degraded-first-take"
            });
            std::fs::create_dir_all(root.join("script")).unwrap();
            let mut session = prepare_metadata_test_session(&root);
            session.snapshot.silence_detector = SilenceDetector::Vad;
            session
                .silence_analysis
                .detector_kind
                .store(DETECTOR_VAD, Ordering::Release);
            session
                .silence_analysis
                .generation
                .store(7, Ordering::Release);
            session
                .silence_analysis
                .telemetry
                .latch_issue(7, VAD_ISSUE_QUEUE_OVERFLOW, 40, 50);
            session.captured.store(100, Ordering::Release);
            session.committed.store(100, Ordering::Release);
            session.active_attempt = Some(ActiveAttempt {
                item_id: "001".to_string(),
                attempt_id: "001-a2".to_string(),
                start_sample: 20,
                recording_started_sample: 20,
                input_discontinuity_count_at_start: 0,
            });
            if has_old_version {
                session.snapshot.items[0].status = "accepted".to_string();
                session.snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
                session.snapshot.items[0].attempts =
                    vec![test_attempt("001-a1", 0, 10, "accepted")];
            }
            let (writer_tx, writer_rx) = bounded::<WriterMessage>(1);
            session.writer_tx = writer_tx;
            let writer_join = thread::spawn(move || {
                if let Ok(WriterMessage::Checkpoint(reply)) = writer_rx.recv() {
                    let _ = reply.send(Ok(100));
                }
            });
            let mut engine = Engine::new(Emitter::new());
            engine.session = Some(session);

            let stopped = engine.stop_attempt(true, true, false).unwrap();
            assert_eq!(stopped["attempt"]["status"], "needs_rerecord");
            assert_eq!(
                stopped["attempt"]["quality_issues"][0]["code"],
                "vad_queue_overflow"
            );
            let item = &engine.session.as_ref().unwrap().snapshot.items[0];
            if has_old_version {
                assert_eq!(item.status, "accepted");
                assert_eq!(item.selected_attempt_id.as_deref(), Some("001-a1"));
            } else {
                assert_eq!(item.status, "review");
                assert!(item.selected_attempt_id.is_none());
            }
            writer_join.join().unwrap();
            drop(engine);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn flush_timeout_counter_is_persisted_on_the_non_deliverable_take() {
        let root = test_root("vad-flush-timeout-attempt");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.silence_detector = SilenceDetector::Vad;
        session
            .silence_analysis
            .detector_kind
            .store(DETECTOR_VAD, Ordering::Release);
        session
            .silence_analysis
            .generation
            .store(11, Ordering::Release);
        session.captured.store(100, Ordering::Release);
        session.committed.store(100, Ordering::Release);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 20,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });
        let (vad_control_tx, vad_control_rx) = bounded::<VadControlMessage>(1);
        session.vad_tx = Some(vad_control_tx);
        let vad_control_join = thread::spawn(move || {
            let VadControlMessage::Flush { done, .. } = vad_control_rx.recv().unwrap() else {
                panic!("stop attempt must issue a VAD flush");
            };
            done.send(VadFlushOutcome::Timeout).unwrap();
        });
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(1);
        session.writer_tx = writer_tx;
        let writer_join = thread::spawn(move || {
            if let Ok(WriterMessage::Checkpoint(reply)) = writer_rx.recv() {
                let _ = reply.send(Ok(100));
            }
        });
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let stopped = engine.stop_attempt(true, true, false).unwrap();
        assert_eq!(stopped["attempt"]["status"], "needs_rerecord");
        assert_eq!(
            stopped["attempt"]["quality_issues"][0]["code"],
            "vad_flush_timeout"
        );
        let session = engine.session.as_ref().unwrap();
        assert_eq!(
            session
                .silence_analysis
                .telemetry
                .flush_timeout_count
                .load(Ordering::Acquire),
            1
        );
        assert_eq!(
            session
                .snapshot
                .vad_diagnostics
                .as_ref()
                .unwrap()
                .flush_timeout_count,
            1
        );
        vad_control_join.join().unwrap();
        writer_join.join().unwrap();
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn idle_vad_degradation_does_not_contaminate_the_next_generation() {
        let telemetry = VadTelemetry::default();
        telemetry.latch_issue(3, VAD_ISSUE_QUEUE_OVERFLOW, 100, 120);
        assert!(telemetry.issue_for_generation(3).is_some());
        telemetry.clear_generation(4);
        assert!(telemetry.issue_for_generation(3).is_none());
        assert!(telemetry.issue_for_generation(4).is_none());
        assert_eq!(telemetry.overflow_count.load(Ordering::Acquire), 1);
    }

    #[test]
    fn disconnected_vad_reset_marks_unavailable_and_prevents_recording() {
        let root = test_root("vad-reset-disconnected");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.silence_detector = SilenceDetector::Vad;
        session
            .silence_analysis
            .detector_kind
            .store(DETECTOR_VAD, Ordering::Release);
        let (control_tx, control_rx) = bounded::<VadControlMessage>(8);
        drop(control_rx);
        session.vad_tx = Some(control_tx);
        let telemetry = session.silence_analysis.telemetry.clone();
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let error = engine.start_attempt("001", false).unwrap_err();
        assert!(format!("{error:#}").contains("VAD reset"));
        assert!(engine.session.as_ref().unwrap().active_attempt.is_none());
        assert_eq!(
            telemetry.health.load(Ordering::Acquire),
            VAD_HEALTH_UNAVAILABLE
        );
        assert_eq!(telemetry.worker_disconnect_count.load(Ordering::Acquire), 1);
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    fn test_stream_reaper() -> StreamReaper {
        StreamReaper::spawn("test-audio-stream-reaper").unwrap()
    }

    #[test]
    fn production_capture_requires_an_explicit_stable_device_id() {
        for missing in [None, Some(""), Some("   ")] {
            let error = require_explicit_input_device_id(missing, "继续录制").unwrap_err();
            let message = format!("{error:#}");
            assert!(message.contains("稳定设备 ID"));
            assert!(message.contains("不会自动切换"));
        }

        assert_eq!(
            require_explicit_input_device_id(Some("wasapi:stable-endpoint"), "继续录制").unwrap(),
            "wasapi:stable-endpoint"
        );
    }

    #[test]
    fn device_selection_rejects_invalid_stable_id_without_fallback() {
        let host = cpal::default_host();
        let error = select_device(&host, "not-a-stable-device-id").unwrap_err();
        assert!(format!("{error:#}").contains("invalid stable input device id"));
    }

    #[test]
    fn drop_reaper_timeout_is_bounded_and_can_be_joined_after_release() {
        struct BlockingDrop {
            entered: Sender<()>,
            release: Receiver<()>,
        }

        impl Drop for BlockingDrop {
            fn drop(&mut self) {
                let _ = self.entered.send(());
                let _ = self.release.recv();
            }
        }

        let mut reaper = DropReaper::spawn("blocking-drop-reaper-test").unwrap();
        let (entered_tx, entered_rx) = bounded(1);
        let (release_tx, release_rx) = bounded(1);
        assert!(reaper.retire(BlockingDrop {
            entered: entered_tx,
            release: release_rx,
        }));
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let timeout = Duration::from_millis(50);
        let started = Instant::now();
        assert_eq!(
            reaper.finish_until(started + timeout),
            DropReaperProgress::Pending
        );
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "blocking Drop escaped the bounded reaper wait"
        );

        release_tx.send(()).unwrap();
        assert_eq!(
            reaper.finish_until(Instant::now() + Duration::from_secs(1)),
            DropReaperProgress::Joined
        );
    }

    #[test]
    fn drop_reaper_worker_panic_is_fail_closed() {
        struct PanickingDrop;

        impl Drop for PanickingDrop {
            fn drop(&mut self) {
                panic!("injected blocking resource destructor panic");
            }
        }

        let mut reaper = DropReaper::spawn("panicking-drop-reaper-test").unwrap();
        assert!(reaper.retire(PanickingDrop));
        assert_eq!(
            reaper.finish_until(Instant::now() + Duration::from_secs(1)),
            DropReaperProgress::Failed
        );
    }

    #[test]
    fn drop_reaper_missing_worker_never_drops_resource_on_caller() {
        static DROPPED: AtomicBool = AtomicBool::new(false);

        struct ObservableDrop;

        impl Drop for ObservableDrop {
            fn drop(&mut self) {
                DROPPED.store(true, Ordering::Release);
            }
        }

        DROPPED.store(false, Ordering::Release);
        let mut reaper = DropReaper::<ObservableDrop> {
            sender: None,
            join: None,
            failed: false,
        };
        assert!(!reaper.retire(ObservableDrop));
        assert!(!DROPPED.load(Ordering::Acquire));
        assert_eq!(
            reaper.finish_until(Instant::now()),
            DropReaperProgress::Failed
        );
    }

    #[test]
    fn abnormal_capture_drop_retires_off_caller_and_retains_directory_lock() {
        struct ThreadObservedDrop(Sender<std::thread::ThreadId>);

        impl Drop for ThreadObservedDrop {
            fn drop(&mut self) {
                let _ = self.0.send(thread::current().id());
            }
        }

        let root = test_root("abnormal-drop-fail-closed");
        let queue = test_writer_queue();
        let faulted = AtomicBool::new(false);
        let (dropped_tx, dropped_rx) = bounded(1);
        let mut resource = Some(ThreadObservedDrop(dropped_tx));
        let mut reaper = DropReaper::spawn("abnormal-drop-resource-reaper").unwrap();
        let mut session_lock = Some(SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap());
        let mut retained_lock = None;
        let caller_thread = thread::current().id();

        assert!(fail_closed_abnormal_capture_drop(
            false,
            &queue,
            &faulted,
            &mut resource,
            |resource| reaper.retire(resource),
            &mut session_lock,
            |lock| retained_lock = Some(lock),
        ));

        assert!(resource.is_none());
        assert!(session_lock.is_none());
        assert!(faulted.load(Ordering::Acquire));
        assert!(queue.enter().is_none(), "callback gate must stay closed");
        assert!(
            SessionLock::acquire(&root, "2026-08-11T00:00:01Z").is_err(),
            "retained lease must prevent another recorder from reopening the task"
        );
        let drop_thread = dropped_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_ne!(
            drop_thread, caller_thread,
            "backend resource destructor ran on the caller thread"
        );
        assert_eq!(
            reaper.finish_until(Instant::now() + Duration::from_secs(1)),
            DropReaperProgress::Joined
        );

        drop(retained_lock.take());
        let reopened = SessionLock::acquire(&root, "2026-08-11T00:00:02Z").unwrap();
        drop(reopened);
        let _ = std::fs::remove_dir_all(root);
    }

    struct AttemptAnalysisHarness {
        writer: Sender<WriterMessage>,
        _receiver: Receiver<WriterMessage>,
        captured: AtomicU64,
        overflow: AtomicU64,
        faulted: AtomicBool,
        peak: AtomicU32,
        rms: AtomicU32,
        queue: WriterQueueBudget,
        silence: SilenceMonitor,
    }

    impl AttemptAnalysisHarness {
        fn armed_at(armed_sample: u64, required_samples: u64) -> Self {
            let (writer, receiver) = unbounded();
            let head_silence = HeadSilenceMonitor::new(required_samples);
            head_silence.arm(armed_sample);
            Self {
                writer,
                _receiver: receiver,
                captured: AtomicU64::new(armed_sample),
                overflow: AtomicU64::new(0),
                faulted: AtomicBool::new(false),
                peak: AtomicU32::new(0f32.to_bits()),
                rms: AtomicU32::new(0f32.to_bits()),
                queue: test_writer_queue(),
                silence: SilenceMonitor {
                    silence_samples: Arc::new(AtomicU64::new(0)),
                    digital_silence_samples: Arc::new(AtomicU64::new(0)),
                    last_signal_sample: Arc::new(AtomicU64::new(0)),
                    attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
                    analyzed_samples: Arc::new(AtomicU64::new(armed_sample)),
                    analysis_epoch: Arc::new(AtomicU64::new(0)),
                    threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
                    capture_heartbeat: Arc::new(AtomicU64::new(0)),
                    head_silence,
                    bandwidth: crate::bandwidth::BandwidthProbe::default(),
                    analysis: SilenceAnalysisPorts::energy(),
                },
            }
        }

        fn publish(&self, samples: Vec<f32>) {
            publish_block(
                samples,
                &self.writer,
                &self.captured,
                &self.overflow,
                &self.faulted,
                &self.peak,
                &self.rms,
                &self.queue,
                &self.silence,
            );
            assert!(!self.faulted.load(Ordering::Acquire));
        }
    }

    #[test]
    fn digital_silence_warning_threshold_uses_the_actual_sample_rate() {
        for sample_rate in [44_100, 48_000, 96_000] {
            let threshold = u64::from(sample_rate) * DIGITAL_SILENCE_WARNING_SECONDS;
            assert!(!digital_silence_suspected(threshold - 1, sample_rate));
            assert!(digital_silence_suspected(threshold, sample_rate));
        }
        assert!(!digital_silence_suspected(u64::MAX, 0));
    }

    #[test]
    fn exact_digital_silence_run_resets_on_nonzero_and_keeps_only_trailing_zeroes() {
        let all_zero = analyze_digital_silence_block(&[0.0, -0.0, 0.0]);
        assert_eq!(
            all_zero,
            DigitalSilenceBlock {
                all_equilibrium: true,
                trailing_samples: 3,
            }
        );
        assert_eq!(apply_digital_silence_block(7, all_zero), 10);

        let mixed = analyze_digital_silence_block(&[0.0, f32::EPSILON, 0.0, -0.0]);
        assert_eq!(
            mixed,
            DigitalSilenceBlock {
                all_equilibrium: false,
                trailing_samples: 2,
            }
        );
        assert_eq!(apply_digital_silence_block(10, mixed), 2);
        assert_eq!(
            apply_digital_silence_block(2, analyze_digital_silence_block(&[0.125])),
            0
        );
    }

    #[test]
    fn digital_silence_is_quality_telemetry_not_a_capture_fault() {
        let harness = AttemptAnalysisHarness::armed_at(0, 48_000);
        harness.publish(vec![0.0; 128]);
        assert_eq!(
            harness
                .silence
                .digital_silence_samples
                .load(Ordering::Acquire),
            128
        );
        assert!(!harness.faulted.load(Ordering::Acquire));

        harness.publish(vec![0.25, 0.0, 0.0]);
        assert_eq!(
            harness
                .silence
                .digital_silence_samples
                .load(Ordering::Acquire),
            2
        );
        assert!(!harness.faulted.load(Ordering::Acquire));
        assert_eq!(harness.overflow.load(Ordering::Acquire), 0);
    }

    fn disconnected_waveform_sender() -> Option<Sender<Vec<[f32; 2]>>> {
        None
    }

    fn assert_storage_fault_drains_backlog(
        name: &str,
        outcomes: Vec<WriterStorageCheckOverride>,
        expected_reason: &str,
    ) {
        let root = test_root(name);
        let path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(0));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let queue = test_writer_queue();
        let peak = AtomicU32::new(0f32.to_bits());
        let rms = AtomicU32::new(0f32.to_bits());
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            analysis: SilenceAnalysisPorts::energy(),
        };
        const BLOCKS: usize = 4;
        const FRAMES_PER_BLOCK: usize = 4;
        for _ in 0..BLOCKS {
            publish_block(
                vec![0.125; FRAMES_PER_BLOCK],
                &writer_tx,
                &captured,
                &overflow,
                &faulted,
                &peak,
                &rms,
                &queue,
                &silence,
            );
        }
        let expected_frames = (BLOCKS * FRAMES_PER_BLOCK) as u64;
        assert_eq!(captured.load(Ordering::Acquire), expected_frames);
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), expected_frames);
        set_writer_storage_check_overrides(&root, outcomes);

        let (ready_tx, ready_rx) = bounded(1);
        let (done_tx, done_rx) = bounded(1);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_queue = queue.clone();
        let storage_status = Arc::new(AtomicU32::new(0));
        let writer_storage_status = Arc::clone(&storage_status);
        let join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                writer_storage_status,
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                disconnected_waveform_sender(),
                ready_tx,
            );
            let _ = done_tx.send(());
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);
        done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        join.join().unwrap();

        assert!(faulted.load(Ordering::Acquire));
        assert_eq!(overflow.load(Ordering::Acquire), 0);
        assert_eq!(committed.load(Ordering::Acquire), expected_frames);
        assert_eq!(captured.load(Ordering::Acquire), expected_frames);
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        let marker: Value =
            serde_json::from_slice(&std::fs::read(root.join(AUDIO_FAULT_MARKER)).unwrap()).unwrap();
        assert!(marker["reason"].as_str().unwrap().contains(expected_reason));
        assert_eq!(marker["committed_frames"].as_u64(), Some(expected_frames));
        assert!(ensure_no_audio_fault_marker(&root, "生成常规交付").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    fn test_snapshot() -> SessionSnapshot {
        SessionSnapshot {
            schema_version: 1,
            journal_seq: 0,
            session_id: "resume-test".to_string(),
            script_name: "test.csv".to_string(),
            status: "recording".to_string(),
            device_name: "test".to_string(),
            device_id: "null:test".to_string(),
            input_sample_format: "f32".to_string(),
            capture_share_mode: CaptureShareMode::Exclusive,
            capture_provenance: Vec::new(),
            audio_format: AudioFormat {
                sample_rate: 48_000,
                bit_depth: 24,
                encoding: "pcm".to_string(),
                channels: 1,
                input_channels: 1,
                input_channel: 1,
            },
            master_audio: "audio/master.wav".to_string(),
            storage_layout_version: STORAGE_LAYOUT_VERSION,
            segment_frames: Some(48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS),
            captured_samples: 0,
            committed_samples: 0,
            overflow_samples: 0,
            input_discontinuity_count: 0,
            input_discontinuity_silence_samples: 0,
            started_at: "2026-08-10T11:00:00Z".to_string(),
            updated_at: "2026-08-10T12:00:00Z".to_string(),
            noise_check: None,
            noise_threshold_dbfs: Some(-42.0),
            silence_duration_ms: 1_000,
            silence_threshold_dbfs: -42.0,
            silence_detector: SilenceDetector::Energy,
            vad_diagnostics: None,
            items: vec![ItemState {
                id: "001".to_string(),
                text: "测试文本".to_string(),
                label: String::new(),
                status: "pending".to_string(),
                attempts: Vec::new(),
                selected_attempt_id: None,
            }],
        }
    }

    fn test_attempt(attempt_id: &str, start_sample: u64, end_sample: u64, status: &str) -> Attempt {
        Attempt {
            attempt_id: attempt_id.to_string(),
            start_sample,
            recording_started_sample: start_sample,
            head_silence_armed_sample: 0,
            head_silence_passed_sample: 0,
            required_head_silence_samples: 0,
            content_started_sample: start_sample,
            end_sample,
            forced_without_tail_silence: false,
            tail_silence_samples: 0,
            required_tail_silence_samples: 0,
            status: status.to_string(),
            created_at: "2026-08-11T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        }
    }

    fn select_safe_first_attempt(snapshot: &mut SessionSnapshot, end_sample: u64) {
        cover_committed_test_audio(snapshot);
        let item = &mut snapshot.items[0];
        item.status = "accepted".to_string();
        item.selected_attempt_id = Some("001-a1".to_string());
        item.attempts = vec![test_attempt("001-a1", 0, end_sample, "accepted")];
    }

    fn cover_committed_test_audio(snapshot: &mut SessionSnapshot) {
        snapshot.capture_provenance = if snapshot.committed_samples == 0 {
            Vec::new()
        } else {
            vec![capture_span_from_snapshot(
                snapshot,
                0,
                snapshot.committed_samples,
            )]
        };
    }

    fn sequenced_event(kind: &str, snapshot: &SessionSnapshot) -> Value {
        json!({
            "journal_seq": snapshot.journal_seq,
            "event": kind,
            "at": "2026-08-10T12:00:00Z",
            "payload": {},
            "captured_samples": snapshot.captured_samples,
            "committed_samples": snapshot.committed_samples,
            "snapshot": snapshot,
        })
    }

    #[test]
    fn rust_export_scope_matches_the_normative_p1_workflow_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../scripts/fixtures/p1-workflow-matrix.json"
        ))
        .unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        let selected_names = fixture["scope_case"]["item_names"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        let mut snapshot = test_snapshot();
        snapshot.status = "stopped".to_string();
        snapshot.captured_samples = fixture["committed_samples"].as_u64().unwrap();
        snapshot.committed_samples = snapshot.captured_samples;
        cover_committed_test_audio(&mut snapshot);
        snapshot.items = selected_names
            .iter()
            .map(|name| {
                let case = cases
                    .iter()
                    .find(|case| case["name"].as_str() == Some(*name))
                    .unwrap();
                serde_json::from_value::<ItemState>(case["item"].clone()).unwrap()
            })
            .collect();

        validate_snapshot_for_cut_scope(&snapshot, ExportScope::ConfirmedOnly).unwrap();
        let included = snapshot
            .items
            .iter()
            .filter(|item| item.status == "accepted")
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        let excluded = snapshot
            .items
            .iter()
            .filter(|item| item.status != "accepted")
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>();
        let expected_included = fixture["scope_case"]["confirmed_only"]["included"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        let expected_excluded = fixture["scope_case"]["confirmed_only"]["excluded"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(included, expected_included);
        assert_eq!(excluded, expected_excluded);
        assert!(validate_snapshot_for_cut_scope(&snapshot, ExportScope::CompleteTask).is_err());

        let unknown_item: ItemState = serde_json::from_value(
            cases
                .iter()
                .find(|case| case["name"] == "unknown quality code fails closed")
                .unwrap()["item"]
                .clone(),
        )
        .unwrap();
        snapshot.items = vec![unknown_item];
        assert!(validate_snapshot_for_cut_scope(&snapshot, ExportScope::ConfirmedOnly).is_err());

        let retained_with_review_status: ItemState = serde_json::from_value(
            cases
                .iter()
                .find(|case| case["name"] == "retained previous requires accepted item status")
                .unwrap()["item"]
                .clone(),
        )
        .unwrap();
        snapshot.items = vec![retained_with_review_status];
        assert!(validate_snapshot_for_cut_scope(&snapshot, ExportScope::ConfirmedOnly).is_err());

        let review_without_candidate: ItemState = serde_json::from_value(
            cases
                .iter()
                .find(|case| {
                    case["name"] == "review with selected version but no candidate fails closed"
                })
                .unwrap()["item"]
                .clone(),
        )
        .unwrap();
        snapshot.items = vec![review_without_candidate];
        assert!(validate_snapshot_for_cut_scope(&snapshot, ExportScope::ConfirmedOnly).is_err());

        let selected_clean: ItemState = serde_json::from_value(
            cases
                .iter()
                .find(|case| case["name"] == "selected clean version")
                .unwrap()["item"]
                .clone(),
        )
        .unwrap();
        for provenance_case in fixture["task_provenance_cases"].as_array().unwrap() {
            let mut provenance_snapshot = test_snapshot();
            provenance_snapshot.status = "stopped".to_string();
            provenance_snapshot.captured_samples = fixture["committed_samples"].as_u64().unwrap();
            provenance_snapshot.committed_samples = provenance_snapshot.captured_samples;
            provenance_snapshot.items = vec![selected_clean.clone()];
            provenance_snapshot.capture_provenance = provenance_case
                .get("capture_provenance")
                .map(|value| serde_json::from_value(value.clone()).unwrap())
                .unwrap_or_default();
            let actual =
                validate_snapshot_for_cut_scope(&provenance_snapshot, ExportScope::ConfirmedOnly)
                    .is_ok();
            assert_eq!(
                actual,
                provenance_case["expected_ready"].as_bool().unwrap(),
                "{}",
                provenance_case["name"].as_str().unwrap()
            );
        }
    }

    #[test]
    fn retained_previous_warning_only_tracks_the_latest_unresolved_bad_retake() {
        let mut old = test_attempt("001-a1", 0, 10, "accepted");
        let bad = Attempt {
            quality_issues: vec![AttemptQualityIssue {
                code: "vad_queue_overflow".to_string(),
                start_sample: Some(10),
                end_sample: Some(20),
                detector_generation: Some(2),
            }],
            ..test_attempt("001-a2", 10, 20, "needs_rerecord")
        };
        let mut item = ItemState {
            id: "001".to_string(),
            text: "测试文本".to_string(),
            label: String::new(),
            status: "accepted".to_string(),
            attempts: vec![old.clone(), bad],
            selected_attempt_id: Some("001-a1".to_string()),
        };
        assert!(cut_export_warning_codes(&item, &old).contains(&"retained_previous"));

        old.status = "rejected_by_operator".to_string();
        item.attempts[0] = old;
        let clean = test_attempt("001-a3", 20, 30, "accepted");
        item.attempts.push(clean.clone());
        item.selected_attempt_id = Some(clean.attempt_id.clone());
        assert!(
            !cut_export_warning_codes(&item, &clean).contains(&"retained_previous"),
            "a historical bad take followed by a clean selected take is no longer unresolved"
        );
    }

    fn write_journal(root: &Path, entries: &[Value]) {
        let mut bytes = Vec::<u8>::new();
        for entry in entries {
            serde_json::to_writer(&mut bytes, entry).unwrap();
            bytes.push(b'\n');
        }
        std::fs::write(root.join("metadata/events.jsonl"), bytes).unwrap();
    }

    fn write_snapshot_file(path: &Path, snapshot: &SessionSnapshot) {
        let mut bytes = serde_json::to_vec_pretty(snapshot).unwrap();
        bytes.push(b'\n');
        std::fs::write(path, bytes).unwrap();
    }

    fn write_open_attempt_metadata(root: &Path, snapshot: &SessionSnapshot) {
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), snapshot);
        write_journal(
            root,
            &[json!({
                "journal_seq": snapshot.journal_seq,
                "event": "attempt_started",
                "at": "2026-08-10T12:00:00Z",
                "payload": {
                    "item_id": "001",
                    "attempt_id": "001-a1",
                    "start_sample": 1,
                    "recording_started_sample": 2,
                    "head_silence_armed_sample": 2,
                    "required_head_silence_samples": 48_000,
                },
                "captured_samples": snapshot.captured_samples,
                "committed_samples": snapshot.committed_samples,
                "snapshot": snapshot,
            })],
        );
    }

    fn offline_seal_fixture(name: &str) -> (PathBuf, SessionSnapshot, Vec<u8>) {
        let root = test_root(name);
        for name in ["audio", "script"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        // Deliberately omit optional preview/export directories: crash
        // recovery must not depend on delivery or UI projections.
        let master = root.join(LEGACY_MASTER_AUDIO);
        let mut writer = RecoverableWav::create(&master, 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.125, -0.25, 0.5]).unwrap();
        assert_eq!(writer.finalize().unwrap(), 3);
        let complete_wav = std::fs::read(&master).unwrap();
        let mut file = OpenOptions::new().append(true).open(&master).unwrap();
        file.write_all(&[0x55, 0xaa]).unwrap();
        file.sync_all().unwrap();
        drop(file);

        let mut snapshot = test_snapshot();
        snapshot.journal_seq = 1;
        snapshot.captured_samples = 2;
        snapshot.committed_samples = 2;
        write_open_attempt_metadata(&root, &snapshot);
        (root, snapshot, complete_wav)
    }

    fn metadata_test_session(root: &Path) -> RecordingSession {
        let (writer_tx, _writer_rx) = bounded::<WriterMessage>(1);
        RecordingSession {
            _session_lock: Some(SessionLock::acquire(root, "2026-08-11T00:00:00Z").unwrap()),
            session_dir: root.to_path_buf(),
            snapshot: test_snapshot(),
            stream: None,
            stream_reaper: test_stream_reaper(),
            writer_tx,
            writer_queue: test_writer_queue(),
            writer_join: None,
            telemetry_join: None,
            capture_watchdog_join: None,
            telemetry_stop: Arc::new(AtomicBool::new(false)),
            capture_watchdog_armed: Arc::new(AtomicBool::new(false)),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            captured: Arc::new(AtomicU64::new(0)),
            committed: Arc::new(AtomicU64::new(0)),
            overflow: Arc::new(AtomicU64::new(0)),
            capture_recovery: CaptureRecoveryTelemetry::default(),
            faulted: Arc::new(AtomicBool::new(false)),
            peak: Arc::new(AtomicU32::new(0)),
            rms: Arc::new(AtomicU32::new(0)),
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            silence_duration_ms: Arc::new(AtomicU32::new(1_000)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            silence_analysis: SilenceAnalysisPorts::energy(),
            vad_tx: None,
            vad_join: None,
            active_attempt: None,
            metadata_fault: None,
            stop_requested: false,
            capture_stopped: false,
        }
    }

    fn prepare_metadata_test_session(root: &Path) -> RecordingSession {
        let mut snapshot = test_snapshot();
        snapshot.journal_seq = 1;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_journal(root, &[sequenced_event("session_started", &snapshot)]);
        let mut session = metadata_test_session(root);
        session.snapshot = snapshot;
        session
    }

    fn assert_delivery_mutations_reject_capture_fault(
        fixture_name: &str,
        faulted: bool,
        overflow_samples: u64,
    ) {
        let root = test_root(fixture_name);
        std::fs::create_dir_all(root.join("script")).unwrap();
        let mut session = prepare_metadata_test_session(&root);
        let attempt = Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 10,
            recording_started_sample: 0,
            head_silence_armed_sample: 0,
            head_silence_passed_sample: 5,
            required_head_silence_samples: 5,
            content_started_sample: 10,
            end_sample: 20,
            forced_without_tail_silence: false,
            tail_silence_samples: 5,
            required_tail_silence_samples: 5,
            status: "recorded".to_string(),
            created_at: "2026-08-11T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        };
        session.snapshot.items[0].status = "review".to_string();
        session.snapshot.items[0].attempts.push(attempt.clone());
        session
            .persist(
                "attempt_stopped",
                json!({ "item_id": "001", "attempt": attempt }),
            )
            .unwrap();
        session.faulted.store(faulted, Ordering::Release);
        session.overflow.store(overflow_samples, Ordering::Release);

        // The capture atomics are authoritative before the telemetry thread
        // publishes its next meter event. Commands must fail closed without
        // waiting for that UI-facing projection.
        let snapshot_before = serde_json::to_value(&session.snapshot).unwrap();
        let journal_before = std::fs::read(root.join("metadata/events.jsonl")).unwrap();
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let accept_error = engine.accept_attempt("001", "001-a1").unwrap_err();
        assert!(format!("{accept_error:#}").contains("禁止确认或跳过"));
        let skip_error = engine.skip_item("001").unwrap_err();
        assert!(format!("{skip_error:#}").contains("禁止确认或跳过"));

        let session = engine.session.as_ref().unwrap();
        assert_eq!(
            serde_json::to_value(&session.snapshot).unwrap(),
            snapshot_before
        );
        assert_eq!(
            std::fs::read(root.join("metadata/events.jsonl")).unwrap(),
            journal_before
        );
        assert_eq!(session.snapshot.items[0].status, "review");
        assert_eq!(session.snapshot.items[0].attempts[0].status, "recorded");
        assert!(session.snapshot.items[0].selected_attempt_id.is_none());
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn faulted_capture_blocks_delivery_mutations_before_the_next_meter_event() {
        assert_delivery_mutations_reject_capture_fault(
            "faulted-delivery-mutation-before-meter",
            true,
            0,
        );
    }

    #[test]
    fn overflow_blocks_delivery_mutations_before_the_next_meter_event() {
        assert_delivery_mutations_reject_capture_fault(
            "overflow-delivery-mutation-before-meter",
            false,
            1,
        );
    }

    #[test]
    fn accept_attempt_can_keep_the_current_version_and_reject_new_candidates() {
        let root = test_root("accept-keep-current-version");
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.items[0].status = "review".to_string();
        session.snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        session.snapshot.items[0].attempts = vec![
            test_attempt("001-a1", 0, 10, "accepted"),
            test_attempt("001-a2", 10, 20, "recorded"),
            test_attempt("001-a3", 20, 30, "recorded"),
        ];
        session.snapshot.captured_samples = 30;
        session.snapshot.committed_samples = 30;
        cover_committed_test_audio(&mut session.snapshot);
        session.captured.store(30, Ordering::Release);
        session.committed.store(30, Ordering::Release);
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let kept = engine.accept_attempt("001", "001-a1").unwrap();

        assert_eq!(kept["attempt_id"], "001-a1");
        let item = &engine.session.as_ref().unwrap().snapshot.items[0];
        assert_eq!(item.status, "accepted");
        assert_eq!(item.selected_attempt_id.as_deref(), Some("001-a1"));
        assert_eq!(item.attempts[0].status, "accepted");
        assert_eq!(item.attempts[1].status, "rejected_by_operator");
        assert_eq!(item.attempts[2].status, "rejected_by_operator");
        assert!(engine.accept_attempt("001", "001-a2").is_err());

        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn attempts_no_longer_require_the_legacy_three_window_noise_check() {
        let root = test_root("start-attempt-without-noise-check");
        let session = prepare_metadata_test_session(&root);
        session.silence_samples.store(48_000, Ordering::Release);
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let started = engine.start_attempt("001", false).unwrap();

        assert_eq!(started["attempt_id"], "001-a1");
        assert_eq!(started["head_silence_phase"], "waiting_for_head_silence");
        assert_eq!(started["head_silence_progress_samples"], 0);
        assert_eq!(started["head_silence_passed_sample"], 0);
        assert!(engine.session.as_ref().unwrap().active_attempt.is_some());
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn head_silence_before_the_click_never_satisfies_a_new_take() {
        let root = test_root("head-silence-starts-at-click");
        let session = prepare_metadata_test_session(&root);
        session.silence_samples.store(u64::MAX, Ordering::Release);
        session.captured.store(12_345, Ordering::Release);
        session.analyzed_samples.store(12_345, Ordering::Release);
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let started = engine.start_attempt("001", false).unwrap();

        assert_eq!(started["recording_started_sample"], 12_345);
        assert_eq!(started["head_silence_armed_sample"], 12_345);
        assert_eq!(started["head_silence_progress_samples"], 0);
        assert_eq!(started["head_silence_passed_sample"], 0);
        assert_eq!(started["content_started_sample"], 0);
        let state = engine.get_state().unwrap();
        assert_eq!(
            state["active_attempt"]["head_silence_phase"],
            "waiting_for_head_silence"
        );
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn noise_during_pending_does_not_reset_the_timer() {
        let harness = AttemptAnalysisHarness::armed_at(100, 4);
        harness.publish(vec![0.0; 3]);
        assert_eq!(
            harness
                .silence
                .head_silence
                .progress_samples
                .load(Ordering::Acquire),
            3
        );

        harness.publish(vec![0.1]);

        assert_eq!(
            harness
                .silence
                .head_silence
                .progress_samples
                .load(Ordering::Acquire),
            4
        );
        assert_eq!(
            harness.silence.head_silence.phase.load(Ordering::Acquire),
            HEAD_SILENCE_SPEECH_STARTED
        );
        assert_eq!(
            harness
                .silence
                .attempt_signal_start_sample
                .load(Ordering::Acquire),
            103
        );
        assert_eq!(
            harness
                .silence
                .head_silence
                .passed_sample
                .load(Ordering::Acquire),
            104
        );
    }

    #[test]
    fn enforced_pending_resets_when_noise_breaks_silence() {
        let harness = AttemptAnalysisHarness::armed_at(100, 4);
        harness.silence.head_silence.set_enforce(true);
        harness.publish(vec![0.0; 3]);
        assert_eq!(
            harness
                .silence
                .head_silence
                .progress_samples
                .load(Ordering::Acquire),
            3
        );
        assert_eq!(
            harness.silence.head_silence.phase.load(Ordering::Acquire),
            HEAD_SILENCE_WAITING
        );

        harness.publish(vec![0.1]);
        assert_eq!(
            harness
                .silence
                .head_silence
                .progress_samples
                .load(Ordering::Acquire),
            0
        );
        assert_eq!(
            harness.silence.head_silence.phase.load(Ordering::Acquire),
            HEAD_SILENCE_WAITING
        );
        assert_eq!(
            harness
                .silence
                .attempt_signal_start_sample
                .load(Ordering::Acquire),
            0
        );

        harness.publish(vec![0.0; 4]);
        assert_eq!(
            harness
                .silence
                .head_silence
                .progress_samples
                .load(Ordering::Acquire),
            4
        );
        assert_eq!(
            harness.silence.head_silence.phase.load(Ordering::Acquire),
            HEAD_SILENCE_PASSED
        );
        assert_eq!(
            harness
                .silence
                .head_silence
                .passed_sample
                .load(Ordering::Acquire),
            108
        );
    }

    #[test]
    fn first_head_silence_pass_is_latched_for_the_whole_take() {
        let harness = AttemptAnalysisHarness::armed_at(20, 4);
        harness.publish(vec![0.0; 4]);
        assert_eq!(
            harness
                .silence
                .head_silence
                .passed_sample
                .load(Ordering::Acquire),
            24
        );

        harness.publish(vec![0.1; 2]);
        harness.publish(vec![0.0; 2]);
        harness.publish(vec![0.2; 2]);

        assert_eq!(
            harness
                .silence
                .head_silence
                .passed_sample
                .load(Ordering::Acquire),
            24
        );
        assert_eq!(
            harness
                .silence
                .head_silence
                .progress_samples
                .load(Ordering::Acquire),
            4
        );
        assert_eq!(
            harness.silence.head_silence.phase.load(Ordering::Acquire),
            HEAD_SILENCE_SPEECH_STARTED
        );
    }

    #[test]
    fn sound_during_pending_is_content_but_does_not_block_the_timer() {
        let harness = AttemptAnalysisHarness::armed_at(40, 4);

        harness.publish(vec![0.2; 3]);

        assert_eq!(
            harness
                .silence
                .attempt_signal_start_sample
                .load(Ordering::Acquire),
            40
        );
        assert_eq!(
            harness.silence.last_signal_sample.load(Ordering::Acquire),
            43
        );
        assert_eq!(
            harness.silence.head_silence.phase.load(Ordering::Acquire),
            HEAD_SILENCE_WAITING
        );
        assert_eq!(
            harness
                .silence
                .head_silence
                .progress_samples
                .load(Ordering::Acquire),
            3
        );
    }

    #[test]
    fn first_sound_after_head_silence_pass_is_sentence_content() {
        let harness = AttemptAnalysisHarness::armed_at(60, 4);
        harness.publish(vec![0.0; 4]);

        harness.publish(vec![0.2; 3]);

        assert_eq!(
            harness
                .silence
                .head_silence
                .passed_sample
                .load(Ordering::Acquire),
            64
        );
        assert_eq!(
            harness
                .silence
                .attempt_signal_start_sample
                .load(Ordering::Acquire),
            64
        );
        assert_eq!(
            harness.silence.last_signal_sample.load(Ordering::Acquire),
            67
        );
    }

    #[test]
    fn forced_stop_before_pass_or_before_speech_creates_no_attempt() {
        let root = test_root("forced-stop-before-head-or-speech");
        let session = prepare_metadata_test_session(&root);
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        engine.start_attempt("001", false).unwrap();
        let before_pass = engine.stop_attempt(true, true, false).unwrap();
        assert_eq!(before_pass["discarded"], true);
        assert!(before_pass["attempt"].is_null());

        engine.start_attempt("001", false).unwrap();
        {
            let session = engine.session.as_ref().unwrap();
            session
                .head_silence
                .progress_samples
                .store(48_000, Ordering::Release);
            session
                .head_silence
                .passed_sample
                .store(48_000, Ordering::Release);
            session
                .head_silence
                .phase
                .store(HEAD_SILENCE_PASSED, Ordering::Release);
        }
        let before_speech = engine.stop_attempt(true, true, false).unwrap();
        assert_eq!(before_speech["discarded"], true);
        assert!(before_speech["attempt"].is_null());
        assert!(
            engine.session.as_ref().unwrap().snapshot.items[0]
                .attempts
                .is_empty()
        );
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn forced_stop_discards_an_attempt_that_never_received_speech() {
        let root = test_root("forced-stop-without-speech");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let mut session = prepare_metadata_test_session(&root);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 0,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let stopped = engine.stop_attempt(true, true, false).unwrap();

        assert_eq!(stopped["discarded"], true);
        assert!(stopped["attempt"].is_null());
        let session = engine.session.as_ref().unwrap();
        assert!(session.active_attempt.is_none());
        assert_eq!(session.snapshot.items[0].status, "pending");
        let journal = read_journal(&root).unwrap();
        assert_eq!(journal.entries.len(), 1);
        assert_eq!(
            journal.entries.last().unwrap()["event"],
            "attempt_discarded"
        );
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn keep_empty_stop_without_speech_creates_an_attempt() {
        let root = test_root("keep-empty-without-speech");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let mut session = prepare_metadata_test_session(&root);
        session.captured.store(100, Ordering::Release);
        session.committed.store(100, Ordering::Release);
        session.analyzed_samples.store(100, Ordering::Release);
        session
            .head_silence
            .armed_sample
            .store(20, Ordering::Release);
        session
            .head_silence
            .progress_samples
            .store(20, Ordering::Release);
        session
            .head_silence
            .passed_sample
            .store(40, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_PASSED, Ordering::Release);
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(1);
        session.writer_tx = writer_tx;
        session.writer_join = Some(thread::spawn(move || {
            if let Ok(WriterMessage::Checkpoint(reply)) = writer_rx.recv() {
                let _ = reply.send(Ok(100));
            }
        }));
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 0,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let stopped = engine.stop_attempt(true, false, false).unwrap();

        assert_eq!(stopped["discarded"], Value::Null);
        assert_eq!(stopped["attempt"]["attempt_id"], "001-a1");
        assert_eq!(stopped["attempt"]["content_started_sample"], 0);
        assert_eq!(stopped["attempt"]["start_sample"], 20);
        assert_eq!(stopped["attempt"]["end_sample"], 100);
        assert_eq!(
            engine.session.as_ref().unwrap().snapshot.items[0].status,
            "review"
        );
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_forced_discard_retains_the_active_attempt_for_fault_sealing() {
        let root = test_root("forced-discard-journal-failure");
        let mut session = prepare_metadata_test_session(&root);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 0,
            recording_started_sample: 0,
            input_discontinuity_count_at_start: 0,
        });
        let event_path = root.join("metadata/events.jsonl");
        std::fs::remove_file(&event_path).unwrap();
        std::fs::create_dir(&event_path).unwrap();
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        assert!(engine.stop_attempt(true, true, false).is_err());

        let session = engine.session.as_ref().unwrap();
        assert!(session.active_attempt.is_some());
        assert!(session.metadata_fault.is_some());
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn analysis_snapshot_never_pairs_an_old_boundary_with_new_signal_fields() {
        let root = test_root("analysis-snapshot-seqlock");
        let session = prepare_metadata_test_session(&root);
        session.captured.store(130, Ordering::Release);
        session.analyzed_samples.store(100, Ordering::Release);
        session
            .attempt_signal_start_sample
            .store(20, Ordering::Release);
        session.last_signal_sample.store(80, Ordering::Release);
        // Model a callback that has started publishing a later signal block.
        session.analysis_epoch.store(1, Ordering::Release);
        let analyzed = Arc::clone(&session.analyzed_samples);
        let last_signal = Arc::clone(&session.last_signal_sample);
        let epoch = Arc::clone(&session.analysis_epoch);
        let updater = thread::spawn(move || {
            last_signal.store(120, Ordering::Release);
            analyzed.store(130, Ordering::Release);
            epoch.store(2, Ordering::Release);
        });

        let snapshot = session.wait_for_analysis_snapshot(100).unwrap();

        updater.join().unwrap();
        assert_eq!(
            snapshot,
            CaptureAnalysisSnapshot {
                boundary: 130,
                head_silence_phase: HEAD_SILENCE_IDLE,
                head_silence_armed_sample: 0,
                head_silence_progress_samples: 0,
                head_silence_passed_sample: 0,
                content_started_sample: 20,
                last_signal_sample: 120,
            }
        );
        assert_eq!(
            snapshot
                .boundary
                .saturating_sub(snapshot.last_signal_sample.min(snapshot.boundary)),
            10
        );
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn task_silence_settings_change_rearms_only_the_active_detection_phase() {
        let root = test_root("task-silence-threshold-change");
        let session = prepare_metadata_test_session(&root);
        session.analyzed_samples.store(120, Ordering::Release);
        session.silence_samples.store(30, Ordering::Release);
        session
            .attempt_signal_start_sample
            .store(45, Ordering::Release);
        session.last_signal_sample.store(90, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_WAITING, Ordering::Release);
        session
            .head_silence
            .armed_sample
            .store(20, Ordering::Release);
        session
            .head_silence
            .progress_samples
            .store(30, Ordering::Release);

        let (boundary, reset_kind) = session.apply_silence_settings(-36.0, 800);

        assert_eq!(boundary, 120);
        assert_eq!(reset_kind, "head_silence");
        assert_eq!(
            f32::from_bits(session.silence_threshold_bits.load(Ordering::Acquire)),
            -36.0,
        );
        assert_eq!(session.silence_samples.load(Ordering::Acquire), 0);
        assert_eq!(session.silence_duration_ms.load(Ordering::Acquire), 800);
        assert_eq!(session.head_silence.required_samples(), 38_400);
        assert_eq!(
            session.head_silence.armed_sample.load(Ordering::Acquire),
            120
        );
        assert_eq!(
            session
                .head_silence
                .progress_samples
                .load(Ordering::Acquire),
            0
        );
        assert_eq!(
            session.attempt_signal_start_sample.load(Ordering::Acquire),
            0
        );

        session.analyzed_samples.store(200, Ordering::Release);
        session.silence_samples.store(18, Ordering::Release);
        session
            .attempt_signal_start_sample
            .store(150, Ordering::Release);
        session.last_signal_sample.store(185, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_SPEECH_STARTED, Ordering::Release);

        let (boundary, reset_kind) = session.apply_silence_settings(-48.0, 1_500);

        assert_eq!(boundary, 200);
        assert_eq!(reset_kind, "tail_silence");
        assert_eq!(session.silence_samples.load(Ordering::Acquire), 0);
        assert_eq!(session.silence_duration_ms.load(Ordering::Acquire), 1_500);
        assert_eq!(session.head_silence.required_samples(), 38_400);
        assert_eq!(
            session.attempt_signal_start_sample.load(Ordering::Acquire),
            150
        );
        assert_eq!(session.last_signal_sample.load(Ordering::Acquire), 200);
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_snapshot_detector_keeps_the_energy_gate() {
        let snapshot = test_snapshot();
        let encoded = serde_json::to_value(&snapshot).unwrap();
        let mut without_detector = encoded.as_object().unwrap().clone();
        without_detector.remove("silence_detector");
        let restored: SessionSnapshot =
            serde_json::from_value(serde_json::Value::Object(without_detector)).unwrap();
        assert_eq!(restored.silence_detector, SilenceDetector::Energy);
    }

    #[test]
    fn new_session_payload_defaults_to_ai_vad() {
        let payload: StartSessionPayload = serde_json::from_value(json!({
            "session_dir": "/tmp/unused",
            "session_id": "new-vad-default",
            "sample_rate": 48_000,
            "bit_depth": 24,
            "silence_duration_ms": 1_000,
            "silence_threshold_dbfs": -42.0,
            "items": [{ "id": "001", "text": "一句" }]
        }))
        .unwrap();
        assert_eq!(payload.silence_detector, SilenceDetector::Vad);
    }

    #[test]
    fn active_capture_locks_the_detector_between_attempts() {
        let root = test_root("detector-task-lock");
        let session = prepare_metadata_test_session(&root);
        assert!(session.active_attempt.is_none());
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let error = engine
            .set_silence_settings(SetSilenceSettingsPayload {
                threshold_dbfs: -42.0,
                silence_duration_ms: 1_000,
                enforce_silence: None,
                silence_detector: Some(SilenceDetector::Vad),
            })
            .unwrap_err();
        assert!(format!("{error:#}").contains("任务启动后"));
        assert_eq!(
            engine.session.as_ref().unwrap().snapshot.silence_detector,
            SilenceDetector::Energy
        );
        drop(engine.session.take());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn vad_stop_trims_pad_around_detected_speech() {
        let root = test_root("vad-stop-trims-pad");
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.audio_format.sample_rate = 100;
        session.snapshot.silence_duration_ms = 200;
        session.snapshot.silence_detector = SilenceDetector::Vad;
        session.captured.store(100, Ordering::Release);
        session.committed.store(100, Ordering::Release);
        session.analyzed_samples.store(100, Ordering::Release);
        session.last_signal_sample.store(80, Ordering::Release);
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(1);
        session.writer_tx = writer_tx;
        session.writer_join = Some(thread::spawn(move || {
            if let Ok(WriterMessage::Checkpoint(reply)) = writer_rx.recv() {
                let _ = reply.send(Ok(100));
            }
        }));
        session
            .attempt_signal_start_sample
            .store(50, Ordering::Release);
        session
            .head_silence
            .passed_sample
            .store(40, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_SPEECH_STARTED, Ordering::Release);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 10,
            recording_started_sample: 10,
            input_discontinuity_count_at_start: 0,
        });
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let stopped = engine.stop_attempt(true, true, true).unwrap();
        assert_eq!(stopped["attempt"]["start_sample"], 30);
        assert_eq!(stopped["attempt"]["end_sample"], 100);
        assert_eq!(stopped["attempt"]["content_started_sample"], 50);
        assert_eq!(stopped["attempt"]["tail_silence_samples"], 20);
        drop(engine.session.take());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn forced_stop_keeps_detected_speech_when_tail_silence_is_short() {
        let root = test_root("forced-stop-short-tail");
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.audio_format.sample_rate = 100;
        session.snapshot.silence_duration_ms = 200;
        session.snapshot.items[0].status = "accepted".to_string();
        session.snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        session.snapshot.items[0].attempts.push(Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 0,
            recording_started_sample: 0,
            head_silence_armed_sample: 0,
            head_silence_passed_sample: 5,
            required_head_silence_samples: 5,
            content_started_sample: 5,
            end_sample: 10,
            forced_without_tail_silence: false,
            tail_silence_samples: 5,
            required_tail_silence_samples: 5,
            status: "accepted".to_string(),
            created_at: "2026-08-11T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        });
        session.head_silence = HeadSilenceMonitor::new(20);
        session.snapshot.captured_samples = 100;
        session.snapshot.committed_samples = 100;
        cover_committed_test_audio(&mut session.snapshot);
        session.captured.store(100, Ordering::Release);
        session.committed.store(100, Ordering::Release);
        session.analyzed_samples.store(100, Ordering::Release);
        session.last_signal_sample.store(95, Ordering::Release);
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(1);
        session.writer_tx = writer_tx;
        session.writer_join = Some(thread::spawn(move || {
            if let Ok(WriterMessage::Checkpoint(reply)) = writer_rx.recv() {
                let _ = reply.send(Ok(100));
            }
        }));
        session
            .attempt_signal_start_sample
            .store(50, Ordering::Release);
        session
            .head_silence
            .armed_sample
            .store(20, Ordering::Release);
        session
            .head_silence
            .progress_samples
            .store(20, Ordering::Release);
        session
            .head_silence
            .passed_sample
            .store(40, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_SPEECH_STARTED, Ordering::Release);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a2".to_string(),
            start_sample: 0,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let stopped = engine.stop_attempt(true, true, false).unwrap();

        assert_eq!(stopped["forced"], true);
        assert_eq!(stopped["attempt"]["attempt_id"], "001-a2");
        assert_eq!(stopped["attempt"]["content_started_sample"], 50);
        assert_eq!(stopped["attempt"]["head_silence_armed_sample"], 20);
        assert_eq!(stopped["attempt"]["head_silence_passed_sample"], 40);
        assert_eq!(stopped["attempt"]["start_sample"], 20);
        assert_eq!(stopped["attempt"]["end_sample"], 100);
        assert_eq!(stopped["attempt"]["forced_without_tail_silence"], true);
        assert_eq!(stopped["attempt"]["tail_silence_samples"], 5);
        assert_eq!(stopped["attempt"]["required_tail_silence_samples"], 20);
        let session = engine.session.as_ref().unwrap();
        assert!(session.active_attempt.is_none());
        assert_eq!(stopped["auto_selected"], false);
        assert_eq!(session.snapshot.items[0].status, "review");
        assert_eq!(
            session.snapshot.items[0].selected_attempt_id.as_deref(),
            Some("001-a1")
        );
        assert_eq!(session.snapshot.items[0].attempts[0].status, "accepted");
        assert_eq!(session.snapshot.items[0].attempts[1].status, "recorded");
        assert_eq!(session.snapshot.items[0].attempts.len(), 2);

        let accepted = engine.accept_attempt("001", "001-a2").unwrap();
        assert_eq!(accepted["attempt_id"], "001-a2");
        let session = engine.session.as_ref().unwrap();
        assert_eq!(session.snapshot.items[0].status, "accepted");
        assert_eq!(
            session.snapshot.items[0].selected_attempt_id.as_deref(),
            Some("001-a2")
        );
        assert_eq!(
            session.snapshot.items[0].attempts[0].status,
            "rejected_by_operator"
        );
        assert_eq!(session.snapshot.items[0].attempts[1].status, "accepted");
        engine
            .session
            .as_mut()
            .unwrap()
            .writer_join
            .take()
            .unwrap()
            .join()
            .unwrap();
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stop_without_force_rejects_speech_when_tail_silence_is_short() {
        let root = test_root("gated-stop-short-tail");
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.audio_format.sample_rate = 100;
        session.snapshot.silence_duration_ms = 200;
        session.head_silence = HeadSilenceMonitor::new(20);
        session.captured.store(100, Ordering::Release);
        session.committed.store(100, Ordering::Release);
        session.analyzed_samples.store(100, Ordering::Release);
        session.last_signal_sample.store(95, Ordering::Release);
        session
            .attempt_signal_start_sample
            .store(50, Ordering::Release);
        session
            .head_silence
            .armed_sample
            .store(20, Ordering::Release);
        session
            .head_silence
            .progress_samples
            .store(20, Ordering::Release);
        session
            .head_silence
            .passed_sample
            .store(40, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_SPEECH_STARTED, Ordering::Release);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 20,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let error = engine.stop_attempt(false, true, false).unwrap_err();
        assert!(format!("{error:#}").contains("尾静音未满"), "{error:#}");
        assert!(engine.session.as_ref().unwrap().active_attempt.is_some());
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn enforce_silence_starts_the_take_at_head_silence_pass() {
        let root = test_root("enforce-silence-start");
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.audio_format.sample_rate = 100;
        session.snapshot.silence_duration_ms = 200;
        session.head_silence = HeadSilenceMonitor::new(20);
        session.captured.store(100, Ordering::Release);
        session.committed.store(100, Ordering::Release);
        session.analyzed_samples.store(100, Ordering::Release);
        session.last_signal_sample.store(80, Ordering::Release);
        session
            .attempt_signal_start_sample
            .store(50, Ordering::Release);
        session
            .head_silence
            .armed_sample
            .store(20, Ordering::Release);
        session
            .head_silence
            .progress_samples
            .store(20, Ordering::Release);
        session
            .head_silence
            .passed_sample
            .store(40, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_SPEECH_STARTED, Ordering::Release);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 20,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(1);
        session.writer_tx = writer_tx;
        session.writer_join = Some(thread::spawn(move || {
            if let Ok(WriterMessage::Checkpoint(reply)) = writer_rx.recv() {
                let _ = reply.send(Ok(100));
            }
        }));
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let stopped = engine.stop_attempt(true, true, true).unwrap();
        assert_eq!(stopped["attempt"]["start_sample"], 40);
        assert_eq!(stopped["attempt"]["recording_started_sample"], 20);
        assert_eq!(stopped["attempt"]["head_silence_passed_sample"], 40);
        engine
            .session
            .as_mut()
            .unwrap()
            .writer_join
            .take()
            .unwrap()
            .join()
            .unwrap();
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovered_discontinuity_retake_keeps_the_previous_accepted_version() {
        let root = test_root("recovered-discontinuity-keeps-previous");
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.audio_format.sample_rate = 100;
        session.snapshot.silence_duration_ms = 200;
        session.snapshot.items[0].status = "accepted".to_string();
        session.snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        session.snapshot.items[0].attempts.push(Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 0,
            recording_started_sample: 0,
            head_silence_armed_sample: 0,
            head_silence_passed_sample: 5,
            required_head_silence_samples: 5,
            content_started_sample: 5,
            end_sample: 10,
            forced_without_tail_silence: false,
            tail_silence_samples: 5,
            required_tail_silence_samples: 5,
            status: "accepted".to_string(),
            created_at: "2026-08-11T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        });
        session
            .capture_recovery
            .discontinuities
            .store(1, Ordering::Release);
        session.head_silence = HeadSilenceMonitor::new(20);
        session.snapshot.captured_samples = 100;
        session.snapshot.committed_samples = 100;
        cover_committed_test_audio(&mut session.snapshot);
        session.captured.store(100, Ordering::Release);
        session.committed.store(100, Ordering::Release);
        session.analyzed_samples.store(100, Ordering::Release);
        session.last_signal_sample.store(80, Ordering::Release);
        session
            .attempt_signal_start_sample
            .store(50, Ordering::Release);
        session
            .head_silence
            .armed_sample
            .store(20, Ordering::Release);
        session
            .head_silence
            .passed_sample
            .store(40, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_SPEECH_STARTED, Ordering::Release);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a2".to_string(),
            start_sample: 20,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(1);
        session.writer_tx = writer_tx;
        session.writer_join = Some(thread::spawn(move || {
            if let Ok(WriterMessage::Checkpoint(reply)) = writer_rx.recv() {
                let _ = reply.send(Ok(100));
            }
        }));
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let stopped = engine.stop_attempt(false, true, false).unwrap();

        assert_eq!(stopped["recovered_discontinuity"], true);
        assert_eq!(stopped["attempt"]["status"], "needs_rerecord");
        assert_eq!(stopped["auto_selected"], false);
        let session = engine.session.as_ref().unwrap();
        assert_eq!(session.snapshot.items[0].status, "accepted");
        assert_eq!(
            session.snapshot.items[0].selected_attempt_id.as_deref(),
            Some("001-a1")
        );
        assert_eq!(session.snapshot.items[0].attempts[0].status, "accepted");
        assert_eq!(
            session.snapshot.items[0].attempts[1].status,
            "needs_rerecord"
        );

        assert!(engine.accept_attempt("001", "001-a2").is_err());
        assert!(engine.render_attempt("001", "001-a2").is_err());
        assert!(engine.preview_attempt_waveform("001", "001-a2").is_err());
        let mut stopped_snapshot = engine.session.as_ref().unwrap().live_snapshot();
        stopped_snapshot.status = "stopped".to_string();
        validate_snapshot_for_artifact(&stopped_snapshot, Some(ExportArtifact::CutsZip)).unwrap();
        engine
            .session
            .as_mut()
            .unwrap()
            .writer_join
            .take()
            .unwrap()
            .join()
            .unwrap();
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovered_discontinuity_without_a_previous_version_requires_rerecord() {
        let root = test_root("recovered-discontinuity-requires-rerecord");
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.audio_format.sample_rate = 100;
        session.snapshot.silence_duration_ms = 200;
        session
            .capture_recovery
            .discontinuities
            .store(1, Ordering::Release);
        session.head_silence = HeadSilenceMonitor::new(20);
        session.captured.store(100, Ordering::Release);
        session.committed.store(100, Ordering::Release);
        session.analyzed_samples.store(100, Ordering::Release);
        session.last_signal_sample.store(80, Ordering::Release);
        session
            .attempt_signal_start_sample
            .store(50, Ordering::Release);
        session
            .head_silence
            .armed_sample
            .store(20, Ordering::Release);
        session
            .head_silence
            .passed_sample
            .store(40, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_SPEECH_STARTED, Ordering::Release);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 20,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(1);
        session.writer_tx = writer_tx;
        session.writer_join = Some(thread::spawn(move || {
            if let Ok(WriterMessage::Checkpoint(reply)) = writer_rx.recv() {
                let _ = reply.send(Ok(100));
            }
        }));
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let stopped = engine.stop_attempt(false, true, false).unwrap();

        assert_eq!(stopped["attempt"]["status"], "needs_rerecord");
        assert_eq!(stopped["auto_selected"], false);
        let session = engine.session.as_ref().unwrap();
        assert_eq!(session.snapshot.items[0].status, "review");
        assert!(session.snapshot.items[0].selected_attempt_id.is_none());
        assert_eq!(
            session.snapshot.items[0].attempts[0].status,
            "needs_rerecord"
        );

        assert!(engine.accept_attempt("001", "001-a1").is_err());
        assert!(engine.render_attempt("001", "001-a1").is_err());
        assert!(engine.preview_attempt_waveform("001", "001-a1").is_err());
        let mut stopped_snapshot = engine.session.as_ref().unwrap().live_snapshot();
        stopped_snapshot.status = "stopped".to_string();
        assert!(
            validate_snapshot_for_artifact(&stopped_snapshot, Some(ExportArtifact::CutsZip))
                .is_err()
        );
        validate_snapshot_for_artifact(&stopped_snapshot, Some(ExportArtifact::FullTrack)).unwrap();

        engine
            .session
            .as_mut()
            .unwrap()
            .writer_join
            .take()
            .unwrap()
            .join()
            .unwrap();
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn writer_fault_while_finishing_never_records_a_truncated_take() {
        let root = test_root("writer-fault-while-finishing-attempt");
        let mut session = prepare_metadata_test_session(&root);
        session.snapshot.audio_format.sample_rate = 100;
        session.snapshot.silence_duration_ms = 200;
        session.head_silence = HeadSilenceMonitor::new(20);
        session.captured.store(100, Ordering::Release);
        session.committed.store(35, Ordering::Release);
        session.analyzed_samples.store(100, Ordering::Release);
        session.last_signal_sample.store(95, Ordering::Release);
        session
            .attempt_signal_start_sample
            .store(50, Ordering::Release);
        session
            .head_silence
            .armed_sample
            .store(20, Ordering::Release);
        session
            .head_silence
            .progress_samples
            .store(20, Ordering::Release);
        session
            .head_silence
            .passed_sample
            .store(40, Ordering::Release);
        session
            .head_silence
            .phase
            .store(HEAD_SILENCE_SPEECH_STARTED, Ordering::Release);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 20,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });

        let (writer_tx, writer_rx) = bounded::<WriterMessage>(1);
        let writer_faulted = Arc::clone(&session.faulted);
        let writer_committed = Arc::clone(&session.committed);
        session.writer_tx = writer_tx;
        session.writer_join = Some(thread::spawn(move || {
            if let Ok(WriterMessage::Checkpoint(reply)) = writer_rx.recv() {
                writer_committed.store(35, Ordering::Release);
                writer_faulted.store(true, Ordering::Release);
                let _ = reply.send(Err(
                    "injected writer failure after analysis snapshot".to_string()
                ));
            }
        }));

        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);
        let stopped = engine.stop_attempt(true, true, false).unwrap();

        assert_eq!(stopped["interrupted"], true);
        assert_eq!(stopped["attempt"]["status"], "interrupted");
        assert_eq!(stopped["attempt"]["start_sample"], 20);
        assert_eq!(stopped["attempt"]["content_started_sample"], 0);
        assert_eq!(stopped["attempt"]["end_sample"], 35);
        let session = engine.session.as_mut().unwrap();
        assert!(session.active_attempt.is_none());
        assert_eq!(session.snapshot.items[0].status, "pending");
        validate_attempt_boundaries(&session.snapshot, 35).unwrap();
        let journal = read_journal(&root).unwrap();
        let event = journal.entries.last().unwrap();
        assert_eq!(event["event"], "attempt_interrupted");
        assert!(
            event["payload"]["reason"]
                .as_str()
                .unwrap()
                .contains("audio_writer_fault_while_finishing")
        );
        session.writer_join.take().unwrap().join().unwrap();
        drop(engine);
        let _ = std::fs::remove_dir_all(root);
    }

    fn activation_test_session(root: &Path, overflow_samples: u64) -> RecordingSession {
        for name in ["audio", "script"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let master_path = root.join(LEGACY_MASTER_AUDIO);
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let queue = test_writer_queue();
        let captured = Arc::new(AtomicU64::new(0));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(overflow_samples));
        let faulted = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = bounded(1);
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_queue = queue.clone();
        let writer_path = master_path.clone();
        let writer_storage_dir = root.to_path_buf();
        let writer_join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                disconnected_waveform_sender(),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);

        RecordingSession {
            _session_lock: Some(SessionLock::acquire(root, "2026-08-11T00:00:00Z").unwrap()),
            session_dir: root.to_path_buf(),
            snapshot: test_snapshot(),
            stream: None,
            stream_reaper: test_stream_reaper(),
            writer_tx,
            writer_queue: queue,
            writer_join: Some(writer_join),
            telemetry_join: None,
            capture_watchdog_join: None,
            telemetry_stop: Arc::new(AtomicBool::new(false)),
            capture_watchdog_armed: Arc::new(AtomicBool::new(false)),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            captured,
            committed,
            overflow,
            capture_recovery: CaptureRecoveryTelemetry::default(),
            faulted,
            peak: Arc::new(AtomicU32::new(0)),
            rms: Arc::new(AtomicU32::new(0)),
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            silence_duration_ms: Arc::new(AtomicU32::new(1_000)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            silence_analysis: SilenceAnalysisPorts::energy(),
            vad_tx: None,
            vad_join: None,
            active_attempt: None,
            metadata_fault: None,
            stop_requested: false,
            capture_stopped: false,
        }
    }

    #[test]
    fn file_names_are_safe_and_stable() {
        assert_eq!(safe_file_name("abc-01_x"), "abc-01_x");
        assert_eq!(safe_file_name("中文 / 01"), "中文 _ 01");
        assert_eq!(safe_file_name("///"), "___");
        assert_eq!(safe_file_name("CON"), "_CON");
        assert_eq!(safe_file_name("CON.txt"), "_CON.txt");
        assert_eq!(safe_file_name("com1.take"), "_com1.take");
        assert_eq!(safe_file_name("LPT9 .wav"), "_LPT9 .wav");
        assert_eq!(safe_file_name("hello. "), "hello");
    }

    #[test]
    fn sentence_export_file_names_have_unique_portable_prefixes_and_bounded_lengths() {
        let mut used = std::collections::HashSet::new();
        let first = allocate_sentence_file_name("A-3", 0, &mut used).unwrap();
        let second = allocate_sentence_file_name("a", 1, &mut used).unwrap();
        let third = allocate_sentence_file_name("A", 2, &mut used).unwrap();
        let sigma = allocate_sentence_file_name("σ", 3, &mut used).unwrap();
        let final_sigma = allocate_sentence_file_name("ς", 4, &mut used).unwrap();
        let nfc = allocate_sentence_file_name("é", 5, &mut used).unwrap();
        let nfd = allocate_sentence_file_name("e\u{301}", 6, &mut used).unwrap();

        assert_eq!(first, "000001-A-3.wav");
        assert_eq!(second, "000002-a.wav");
        assert_eq!(third, "000003-A.wav");
        assert_eq!(sigma, "000004-σ.wav");
        assert_eq!(final_sigma, "000005-ς.wav");
        assert_eq!(nfc, "000006-é.wav");
        assert_eq!(nfd, "000007-e\u{301}.wav");
        // Windows folds sigma/final-sigma. The conservative key sees that
        // equivalence, while the unique ASCII item prefixes keep the actual
        // planned paths distinct on every filesystem.
        assert_eq!(
            portable_file_name_key("000004-σ.wav").trim_start_matches("000004-"),
            portable_file_name_key("000005-ς.wav").trim_start_matches("000005-")
        );
        assert_ne!(&sigma[..7], &final_sigma[..7]);
        assert_ne!(&nfc[..7], &nfd[..7]);

        let long = allocate_sentence_file_name(&"声".repeat(400), 7, &mut used).unwrap();
        assert!(long.len() <= MAX_SENTENCE_FILE_NAME_UTF8_BYTES);
        assert!(long.encode_utf16().count() <= MAX_SENTENCE_FILE_NAME_UTF16_UNITS);
        assert!(long.ends_with(".wav"));

        let attempt = bounded_wav_stem(&"声".repeat(400), "-a123").unwrap();
        assert!(format!("{attempt}.wav").len() <= MAX_SENTENCE_FILE_NAME_UTF8_BYTES);
        assert!(
            format!("{attempt}.wav").encode_utf16().count() <= MAX_SENTENCE_FILE_NAME_UTF16_UNITS
        );
        assert!(attempt.ends_with("-a123"));

        let legacy_preview = bounded_wav_stem(&"🎧".repeat(300), "").unwrap();
        assert!(format!("{legacy_preview}.wav").len() <= MAX_SENTENCE_FILE_NAME_UTF8_BYTES);
        assert!(
            format!("{legacy_preview}.wav").encode_utf16().count()
                <= MAX_SENTENCE_FILE_NAME_UTF16_UNITS
        );

        let long_emoji = allocate_sentence_file_name(&"🎤".repeat(400), 8, &mut used).unwrap();
        assert!(long_emoji.len() <= MAX_SENTENCE_FILE_NAME_UTF8_BYTES);
        assert!(long_emoji.encode_utf16().count() <= MAX_SENTENCE_FILE_NAME_UTF16_UNITS);
    }

    #[test]
    fn sentence_generation_removes_all_old_wavs_before_new_outputs() {
        let root = test_root("sentence-generation-cleanup");
        std::fs::create_dir_all(&root).unwrap();
        let names = [
            "000001-σ.wav",
            "000002-ς.WAV",
            "000003-é.wav",
            "000004-e\u{301}.wav",
        ];
        for (index, name) in names.iter().enumerate() {
            std::fs::write(root.join(name), vec![0u8; index + 1]).unwrap();
        }
        std::fs::write(root.join("keep.txt"), b"not a sentence wav").unwrap();

        let mut sizes = existing_sentence_wav_sizes(&root).unwrap();
        sizes.sort_unstable();
        assert_eq!(sizes, vec![1, 2, 3, 4]);
        remove_all_sentence_wavs(&root).unwrap();

        for name in names {
            assert!(!root.join(name).exists());
        }
        assert!(root.join("keep.txt").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_allocation_headroom_is_never_credited_to_old_files() {
        assert_eq!(
            planned_export_allocation(1_000).unwrap(),
            1_000 + EXPORT_FILE_ALLOCATION_HEADROOM_BYTES
        );
        assert_eq!(existing_export_allocation(Some(1_000)), 1_000);
        assert_eq!(existing_export_allocation(None), 0);
    }

    #[test]
    fn frame_conversion_selects_requested_channel() {
        assert_eq!(
            convert_frames(&[1i16, 2, 3, 4], 2, 0, |sample| f32::from(sample) / 4.0).unwrap(),
            vec![0.25, 0.75]
        );
        assert_eq!(
            convert_frames(&[1i16, 2, 3, 4], 2, 1, |sample| f32::from(sample) / 4.0).unwrap(),
            vec![0.5, 1.0]
        );
    }

    #[test]
    fn frame_conversion_preserves_finite_float_headroom() {
        assert_eq!(
            convert_frames(&[1.25f32, -1.5], 1, 0, |sample| sample).unwrap(),
            vec![1.25, -1.5]
        );
    }

    #[test]
    fn delivery_depth_requires_an_honest_driver_representation() {
        assert_eq!(minimum_input_representation_bits(16).unwrap(), 16);
        assert_eq!(minimum_input_representation_bits(24).unwrap(), 24);
        assert_eq!(minimum_input_representation_bits(32).unwrap(), 24);
        assert!(minimum_input_representation_bits(20).is_err());

        assert_eq!(input_representation_bits(SampleFormat::I16), Some(16));
        assert_eq!(input_representation_bits(SampleFormat::I24), Some(24));
        assert_eq!(input_representation_bits(SampleFormat::I32), Some(32));
        assert_eq!(input_representation_bits(SampleFormat::F32), Some(24));
        assert_eq!(input_representation_bits(SampleFormat::F64), Some(53));
        assert!(
            input_representation_bits(SampleFormat::I16).unwrap()
                < minimum_input_representation_bits(24).unwrap()
        );
        assert!(
            input_representation_bits(SampleFormat::F32).unwrap()
                >= minimum_input_representation_bits(32).unwrap()
        );
    }

    #[test]
    fn capture_provenance_upgrades_legacy_audio_and_tracks_resumes() {
        let mut snapshot = test_snapshot();
        snapshot.captured_samples = 100;
        snapshot.committed_samples = 100;
        let previous_source = capture_span_from_snapshot(&snapshot, 0, 0);

        snapshot.device_name = "replacement interface".to_string();
        snapshot.device_id = "null:replacement".to_string();
        snapshot.input_sample_format = "f64".to_string();
        snapshot.audio_format.input_channels = 2;
        snapshot.audio_format.input_channel = 2;
        begin_capture_provenance(&mut snapshot, previous_source, 100).unwrap();

        assert_eq!(snapshot.capture_provenance.len(), 2);
        assert_eq!(snapshot.capture_provenance[0].start_sample, 0);
        assert_eq!(snapshot.capture_provenance[0].end_sample, 100);
        assert_eq!(snapshot.capture_provenance[0].device_id, "null:test");
        assert_eq!(snapshot.capture_provenance[1].start_sample, 100);
        assert_eq!(snapshot.capture_provenance[1].end_sample, 100);
        assert_eq!(snapshot.capture_provenance[1].device_id, "null:replacement");

        assert!(reconcile_capture_provenance_after_recovery(&mut snapshot, 125).unwrap());
        assert_eq!(snapshot.capture_provenance[1].end_sample, 125);
        validate_capture_provenance(&snapshot, 125, true).unwrap();
    }

    #[test]
    fn capture_provenance_rejects_gaps_and_unknown_recovery_sources() {
        let mut snapshot = test_snapshot();
        snapshot.capture_provenance = vec![CaptureProvenanceSpan {
            start_sample: 1,
            end_sample: 10,
            device_name: "test".to_string(),
            device_id: "null:test".to_string(),
            input_sample_format: "f32".to_string(),
            input_channels: 1,
            input_channel: 1,
            sample_rate: 48_000,
        }];
        assert!(validate_capture_provenance(&snapshot, 10, true).is_err());

        snapshot.capture_provenance[0].start_sample = 0;
        snapshot.device_id = "null:changed".to_string();
        assert!(reconcile_capture_provenance_after_recovery(&mut snapshot, 11).is_err());
    }

    #[test]
    fn frame_conversion_rejects_incomplete_and_non_finite_blocks() {
        assert!(
            convert_frames::<f32>(&[], 2, 0, |sample| sample)
                .unwrap()
                .is_empty()
        );

        let incomplete = convert_frames(&[1i16, 2, 3], 2, 0, f32::from).unwrap_err();
        assert_eq!(incomplete.dropped_frames, 2);
        assert!(incomplete.reason.contains("complete 2-channel frames"));

        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let error = convert_frames(&[invalid], 1, 0, |sample| sample).unwrap_err();
            assert_eq!(error.dropped_frames, 1);
            assert!(error.reason.contains("non-finite"));
        }
    }

    #[test]
    fn cpal_i24_normalization_handles_logical_and_wasapi_container_values() {
        assert_eq!(normalize_i24_raw(-8_388_608, false), -1.0);
        assert_eq!(normalize_i24_raw(0, false), 0.0);
        assert_eq!(
            normalize_i24_raw(8_388_607, false),
            8_388_607.0 / 8_388_608.0
        );
        assert_eq!(normalize_i24_raw(i32::MIN, true), -1.0);
        assert_eq!(normalize_i24_raw(0x4000_0000, true), 0.5);
        assert_eq!(
            normalize_i24_raw(0x7fff_ff00, true),
            8_388_607.0 / 8_388_608.0
        );

        assert_eq!(normalize_u24_raw(0x8000_0000u32 as i32, true), 0.0);
        assert_eq!(normalize_u24_raw(0x4000_0000, true), -0.5);
        assert_eq!(normalize_u24_raw(8_388_608, false), 0.0);
    }

    #[test]
    fn ambient_noise_requires_two_failing_windows_to_block() {
        let mut samples = vec![-55.0; 15];
        samples[1] = -30.0;
        assert_eq!(evaluate_noise(&samples, -42.0), (true, 1));
        samples[7] = -31.0;
        assert_eq!(evaluate_noise(&samples, -42.0), (false, 2));
    }

    #[test]
    fn ambient_noise_treats_the_limit_as_over_threshold() {
        let mut samples = vec![-55.0; 15];
        samples[0] = -42.0;
        samples[5] = -42.0;
        assert_eq!(evaluate_noise(&samples, -42.0), (false, 2));
    }

    #[test]
    fn capture_heartbeat_watchdog_requires_an_armed_stall_and_resets_on_progress() {
        let started = Instant::now();
        let timeout = Duration::from_secs(5);
        let mut watchdog = CaptureHeartbeatWatchdog::new(started);

        // Slow activation metadata I/O happens while disarmed and must not be
        // mistaken for a live capture stall.
        assert!(!watchdog.observe(started + Duration::from_secs(30), false, 0, false, timeout,));
        let armed_at = started + Duration::from_secs(31);
        assert!(!watchdog.observe(armed_at, true, 0, false, timeout));
        assert!(!watchdog.observe(
            armed_at + timeout - Duration::from_nanos(1),
            true,
            0,
            false,
            timeout,
        ));

        // A non-empty callback heartbeat restarts the full deadline.
        let progressed_at = armed_at + timeout - Duration::from_millis(1);
        assert!(!watchdog.observe(progressed_at, true, 1, false, timeout));
        assert!(!watchdog.observe(
            progressed_at + timeout - Duration::from_nanos(1),
            true,
            1,
            false,
            timeout,
        ));
        assert!(watchdog.observe(progressed_at + timeout, true, 1, false, timeout,));
        assert!(!watchdog.observe(
            progressed_at + timeout + Duration::from_secs(1),
            true,
            1,
            false,
            timeout,
        ));

        // Safe-stop disarms before pausing the stream, including at the exact
        // timeout boundary where a racing observer would otherwise trip.
        let mut stopping_watchdog = CaptureHeartbeatWatchdog::new(started);
        assert!(!stopping_watchdog.observe(started, true, 9, false, timeout));
        assert!(!stopping_watchdog.observe(started + timeout, false, 9, false, timeout,));
        assert!(!stopping_watchdog.observe(
            started + timeout + Duration::from_secs(30),
            false,
            9,
            false,
            timeout,
        ));
    }

    #[test]
    fn capture_heartbeat_watchdog_does_not_duplicate_an_existing_capture_fault() {
        let started = Instant::now();
        let timeout = Duration::from_secs(5);
        let mut watchdog = CaptureHeartbeatWatchdog::new(started);
        assert!(!watchdog.observe(started, true, 7, false, timeout));
        assert!(!watchdog.observe(started + timeout, true, 7, true, timeout));
    }

    #[test]
    fn input_stream_faults_have_stable_operator_facing_codes() {
        assert_eq!(
            input_stream_fault_code(&cpal::Error::new(cpal::ErrorKind::DeviceNotAvailable)),
            CAPTURE_FAULT_DEVICE_UNAVAILABLE,
        );
        assert_eq!(
            input_stream_fault_code(&cpal::Error::new(cpal::ErrorKind::Xrun)),
            CAPTURE_FAULT_INPUT_DISCONTINUITY,
        );
        assert_eq!(
            input_stream_fault_code(&cpal::Error::new(cpal::ErrorKind::BackendError)),
            CAPTURE_FAULT_INPUT_STREAM_ERROR,
        );
        assert_eq!(
            capture_fault_telemetry(CAPTURE_FAULT_DEVICE_UNAVAILABLE).0,
            "device_unavailable",
        );
        assert_eq!(
            capture_fault_telemetry(CAPTURE_FAULT_DEVICE_STALLED).0,
            "device_stalled",
        );
    }

    #[test]
    fn capture_fault_code_preserves_the_first_failure() {
        let code = AtomicU32::new(CAPTURE_FAULT_NONE);
        latch_capture_fault_code(&code, CAPTURE_FAULT_DEVICE_UNAVAILABLE);
        latch_capture_fault_code(&code, CAPTURE_FAULT_INPUT_STREAM_ERROR);
        assert_eq!(
            code.load(Ordering::Acquire),
            CAPTURE_FAULT_DEVICE_UNAVAILABLE,
        );
    }

    #[test]
    fn recovered_xrun_is_quality_telemetry_not_a_terminal_capture_fault() {
        let recovered = cpal::Error::with_message(
            cpal::ErrorKind::RecoveredXrun,
            "WASAPI input discontinuity recovered; missing_frames=480; driver_reported=true",
        );
        assert_eq!(recovered_xrun_missing_frames(&recovered), Some(480));
        assert_eq!(
            input_stream_fault_code(&recovered),
            CAPTURE_FAULT_INPUT_STREAM_ERROR
        );

        let terminal = cpal::Error::with_message(
            cpal::ErrorKind::Xrun,
            "WASAPI capture device position moved backward",
        );
        assert_eq!(recovered_xrun_missing_frames(&terminal), None);
        assert_eq!(
            input_stream_fault_code(&terminal),
            CAPTURE_FAULT_INPUT_DISCONTINUITY
        );
    }

    #[test]
    fn stalled_capture_fault_is_durable_drains_writer_and_closes_callback_gate() {
        let root = test_root("capture-watchdog-fault");
        let path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(0));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let queue = test_writer_queue();
        let (ready_tx, ready_rx) = bounded(1);
        let (done_tx, done_rx) = bounded(1);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_queue = queue.clone();
        let writer_join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                disconnected_waveform_sender(),
                ready_tx,
            );
            let _ = done_tx.send(());
        });
        assert_eq!(
            ready_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap(),
            0
        );

        let peak = AtomicU32::new(0f32.to_bits());
        let rms = AtomicU32::new(0f32.to_bits());
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(1)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            analysis: SilenceAnalysisPorts::energy(),
        };
        publish_block(
            vec![0.25, -0.25, 0.5, -0.5],
            &writer_tx,
            &captured,
            &overflow,
            &faulted,
            &peak,
            &rms,
            &queue,
            &silence,
        );
        assert_eq!(captured.load(Ordering::Acquire), 4);

        assert!(trip_stalled_capture(
            &root,
            "injected capture callback stall",
            &committed,
            &faulted,
            &queue,
            &writer_tx,
        ));
        done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        writer_join.join().unwrap();

        // This is the same atomic telemetry publishes as `meter.faulted`.
        assert!(faulted.load(Ordering::Acquire));
        assert!(queue.enter().is_none());
        assert_eq!(overflow.load(Ordering::Acquire), 0);
        assert_eq!(committed.load(Ordering::Acquire), 4);
        assert!(ensure_no_audio_fault_marker(&root, "生成常规交付").is_err());
        let marker: Value =
            serde_json::from_slice(&std::fs::read(root.join(AUDIO_FAULT_MARKER)).unwrap()).unwrap();
        assert!(
            marker["reason"]
                .as_str()
                .unwrap()
                .contains("capture callback stall")
        );
        assert_eq!(marker["committed_frames"].as_u64(), Some(4));
        let recovered = RecoverableWav::open_append(&path, 48_000, 1, 24).unwrap();
        assert_eq!(recovered.frames_written(), 4);
        drop(recovered);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn waveform_bins_preserve_minimum_and_maximum() {
        let samples = vec![-0.5, -0.03, 0.09, 0.5];
        let bins = waveform_bins(&samples);
        assert_eq!(bins.len(), 1);
        assert!((bins[0][0] + 0.5).abs() < 0.001);
        assert!((bins[0][1] - 0.5).abs() < 0.001);
    }

    #[test]
    fn waveform_binner_carries_partial_bins_across_callback_sizes() {
        for callback_frames in [240usize, 441, 480, 512] {
            let start_sample = 1_003u64;
            let callback_count = 100usize;
            let mut binner = WaveformBinner::new(start_sample);
            let mut cursor = start_sample;
            let mut emitted_bins = 0usize;
            let mut last_end_sample = start_sample;
            for callback in 0..callback_count {
                let mut samples = vec![0.25; callback_frames];
                if callback == 0 {
                    samples[0] = -0.75;
                }
                if let Some(packet) = binner.push_block(cursor, &samples) {
                    emitted_bins += packet.bins.len();
                    last_end_sample = packet.end_sample;
                }
                cursor += callback_frames as u64;
            }
            let total_frames = callback_frames * callback_count;
            assert_eq!(
                emitted_bins,
                total_frames / WAVEFORM_BIN_SAMPLES,
                "callback size {callback_frames} must not round each callback tail up to a bin"
            );
            assert_eq!(
                binner.pending_samples,
                total_frames % WAVEFORM_BIN_SAMPLES,
                "callback size {callback_frames} must retain the exact cross-callback remainder"
            );
            assert_eq!(
                last_end_sample,
                start_sample + (emitted_bins * WAVEFORM_BIN_SAMPLES) as u64
            );
        }
    }

    #[test]
    fn waveform_binner_reports_authoritative_sample_endpoint() {
        let mut binner = WaveformBinner::new(10_000);
        assert!(binner.push_block(10_000, &[0.25; 63]).is_none());
        let packet = binner.push_block(10_063, &[-0.5, 0.75]).unwrap();
        assert_eq!(packet.end_sample, 10_064);
        assert_eq!(packet.bins, vec![[-0.5, 0.25]]);
        assert_eq!(binner.pending_samples, 1);
    }

    #[test]
    fn telemetry_waveform_batch_does_not_hide_dropped_sample_ranges() {
        let mut waveform = Vec::new();
        let mut end_sample = 0;
        append_waveform_packet(
            &mut waveform,
            &mut end_sample,
            WaveformPacket {
                bins: vec![[0.0, 0.1], [0.0, 0.2]],
                end_sample: 128,
            },
            2_048,
        );
        append_waveform_packet(
            &mut waveform,
            &mut end_sample,
            WaveformPacket {
                bins: vec![[-0.3, 0.3]],
                end_sample: 320,
            },
            2_048,
        );
        assert_eq!(waveform, vec![[-0.3, 0.3]]);
        assert_eq!(end_sample, 320);
    }

    #[test]
    fn full_waveform_channel_never_blocks_or_rejects_authoritative_audio() {
        let harness = AttemptAnalysisHarness::armed_at(0, 64);
        let (waveform_tx, waveform_rx) = bounded(1);
        waveform_tx
            .try_send(WaveformPacket {
                bins: vec![[0.0, 0.0]],
                end_sample: 64,
            })
            .unwrap();
        let mut preview = CaptureWaveformPreview::new(waveform_tx, 0);
        let enqueue_lease = harness.queue.enter().unwrap();
        publish_leased_block_with_preview(
            vec![0.25; 64],
            &harness.writer,
            &harness.captured,
            &harness.overflow,
            &harness.faulted,
            &harness.peak,
            &harness.rms,
            &harness.queue,
            enqueue_lease,
            &harness.silence,
            None,
            Some(&mut preview),
        );

        assert_eq!(harness.captured.load(Ordering::Acquire), 64);
        assert!(!harness.faulted.load(Ordering::Acquire));
        match harness._receiver.try_recv().unwrap() {
            WriterMessage::Samples(samples) => assert_eq!(samples, vec![0.25; 64]),
            _ => panic!("accepted audio must enter the authoritative writer queue"),
        }
        assert_eq!(waveform_rx.try_recv().unwrap().end_sample, 64);
        assert!(
            waveform_rx.try_recv().is_err(),
            "new preview may be dropped under pressure"
        );
    }

    #[test]
    fn live_preview_is_limited_to_ten_minutes() {
        let ten_minutes = 48_000 * LIVE_PREVIEW_MAX_SECONDS;
        validate_live_preview_range(48_000, 7, 7 + ten_minutes).unwrap();
        assert!(validate_live_preview_range(48_000, 7, 8 + ten_minutes).is_err());
        assert!(validate_live_preview_range(48_000, 9, 9).is_err());
    }

    #[test]
    fn storage_checks_fail_closed_on_the_third_consecutive_error_and_reset_on_success() {
        let mut failures = 0;
        assert!(!storage_check_requires_stop(&mut failures, false));
        assert!(!storage_check_requires_stop(&mut failures, false));
        assert_eq!(failures, 2);
        assert!(!storage_check_requires_stop(&mut failures, true));
        assert_eq!(failures, 0);
        assert!(!storage_check_requires_stop(&mut failures, false));
        assert!(!storage_check_requires_stop(&mut failures, false));
        assert!(storage_check_requires_stop(&mut failures, false));
        assert_eq!(failures, 3);
    }

    #[test]
    fn automatic_checkpoint_is_ten_seconds_and_tail_budget_is_at_most_thirty() {
        let sample_rate = 48_000;
        let nine_seconds = u64::from(sample_rate) * 9;
        let ten_seconds = u64::from(sample_rate) * WRITER_AUTOMATIC_CHECKPOINT_SECONDS;

        assert!(!automatic_writer_checkpoint_due(
            Duration::from_secs(9),
            nine_seconds,
            0,
            sample_rate,
        ));
        assert!(automatic_writer_checkpoint_due(
            Duration::from_secs(WRITER_AUTOMATIC_CHECKPOINT_SECONDS),
            nine_seconds,
            0,
            sample_rate,
        ));
        assert!(automatic_writer_checkpoint_due(
            Duration::ZERO,
            ten_seconds,
            0,
            sample_rate,
        ));
        assert_eq!(
            WRITER_AUTOMATIC_CHECKPOINT_SECONDS + WRITER_QUEUE_AUDIO_BUDGET_SECONDS,
            WRITER_POWER_LOSS_TAIL_BUDGET_SECONDS
        );
    }

    #[test]
    fn explicit_checkpoint_clock_cannot_starve_the_storage_guard() {
        let sample_rate = 48_000;
        let fully_committed = u64::from(sample_rate) * 5;

        // Model a sentence-completion checkpoint that just reset the expensive
        // audio-sync clock. The independent disk clock is still due and must
        // remain able to trip the critical-reserve guard.
        assert!(!automatic_writer_checkpoint_due(
            Duration::ZERO,
            fully_committed,
            fully_committed,
            sample_rate,
        ));
        assert!(writer_storage_check_due(
            Path::new("storage-clock-independent-of-checkpoint"),
            Duration::from_secs(WRITER_STORAGE_CHECK_INTERVAL_SECONDS),
        ));
    }

    #[test]
    fn storage_critical_drains_every_preaccepted_sample_and_marks_the_session() {
        assert_storage_fault_drains_backlog(
            "storage-critical-drain",
            vec![WriterStorageCheckOverride::Critical],
            "before exhausting disk space",
        );
    }

    #[test]
    fn resume_recovery_acquires_the_session_lock_before_reading_any_projection() {
        let root = test_root("resume-lock-before-projection");
        let mut snapshot = test_snapshot();
        snapshot.journal_seq = 7;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_journal(&root, &[sequenced_event("attempt_accepted", &snapshot)]);

        let owner = SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap();
        let journal_path = root.join("metadata/events.jsonl");
        std::fs::remove_file(&journal_path).unwrap();
        std::fs::create_dir(&journal_path).unwrap();

        // The competing recovery must fail on the lease without inspecting the
        // deliberately invalid journal. Reading first would return an event-log
        // error and retain a stale snapshot that could become writable after the
        // current owner releases its lock.
        let error =
            load_locked_recovery_snapshot(&root, "继续录制", Some(snapshot.session_id.as_str()))
                .err()
                .expect("a competing recovery must not read mutable metadata");
        assert!(
            format!("{error:#}").contains("already open in another recorder process"),
            "unexpected pre-lock recovery error: {error:#}"
        );

        drop(owner);
        std::fs::remove_dir(&journal_path).unwrap();
        write_journal(&root, &[sequenced_event("attempt_accepted", &snapshot)]);
        let (recovery_lock, journal, recovered) =
            load_locked_recovery_snapshot(&root, "继续录制", Some(snapshot.session_id.as_str()))
                .unwrap();
        assert_eq!(recovered.journal_seq, 7);
        assert_eq!(journal.entries.len(), 1);
        assert!(SessionLock::acquire(&root, "2026-08-11T00:00:01Z").is_err());
        drop(recovery_lock);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resume_recovery_rejects_any_identity_conflict_while_holding_the_lease() {
        let root = test_root("resume-expected-identity-consensus");
        let mut snapshot = test_snapshot();
        snapshot.journal_seq = 2;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_journal(&root, &[sequenced_event("session_started", &snapshot)]);

        let mut foreign = snapshot.clone();
        foreign.session_id = "replaced-after-electron-preflight".to_string();
        foreign.journal_seq = 3;
        write_snapshot_file(&root.join("metadata/items.snapshot.backup"), &foreign);

        let error =
            load_locked_recovery_snapshot(&root, "继续录制", Some(snapshot.session_id.as_str()))
                .err()
                .expect("conflicting persisted identities must fail closed");
        assert!(format!("{error:#}").contains("属于其他录制"));
        assert!(SessionLock::acquire(&root, "2026-08-12T00:00:00Z").is_ok());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn expected_identity_must_agree_with_the_identity_file_and_every_journal_projection() {
        for conflict_source in ["session-file", "journal"] {
            let root = test_root(&format!("resume-{conflict_source}-identity-conflict"));
            let mut snapshot = test_snapshot();
            snapshot.journal_seq = 2;
            write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
            write_journal(&root, &[sequenced_event("session_started", &snapshot)]);

            let mut foreign = snapshot.clone();
            foreign.session_id = format!("foreign-{conflict_source}");
            foreign.journal_seq = 3;
            match conflict_source {
                "session-file" => std::fs::write(
                    root.join("session.json"),
                    serde_json::to_vec_pretty(&json!({
                        "schema_version": 1,
                        "session_id": foreign.session_id,
                    }))
                    .unwrap(),
                )
                .unwrap(),
                "journal" => write_journal(
                    &root,
                    &[
                        sequenced_event("session_started", &snapshot),
                        sequenced_event("attempt_started", &foreign),
                    ],
                ),
                _ => unreachable!(),
            }

            let error = load_locked_recovery_snapshot(
                &root,
                "继续录制",
                Some(snapshot.session_id.as_str()),
            )
            .err()
            .expect("every valid persisted identity must agree");
            let message = format!("{error:#}");
            assert!(
                message.contains("身份文件与预期任务不一致") || message.contains("属于其他录制"),
                "unexpected {conflict_source} error: {message}"
            );
            assert!(SessionLock::acquire(&root, "2026-08-12T00:00:00Z").is_ok());
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn resume_without_a_stable_device_id_fails_closed_without_fallback() {
        let root = test_root("resume-missing-stable-device-id");
        for name in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let mut snapshot = test_snapshot();
        snapshot.journal_seq = 1;
        snapshot.device_id.clear();
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_journal(&root, &[sequenced_event("session_started", &snapshot)]);

        let mut engine = Engine::new(Emitter::new());
        let error = engine
            .resume_session(ResumeSessionPayload {
                session_dir: root.to_string_lossy().into_owned(),
                expected_session_id: snapshot.session_id.clone(),
            })
            .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("稳定设备 ID"));
        assert!(message.contains("不会自动切换"));
        assert!(message.contains("当前版本尚不支持恢复时重新绑定设备"));
        assert!(message.contains("保留原始目录"));
        assert!(engine.session.is_none());

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn repeated_storage_query_failures_drain_the_backlog_and_mark_the_session() {
        assert_storage_fault_drains_backlog(
            "storage-query-failure-drain",
            vec![
                WriterStorageCheckOverride::Error("injected storage query failure 1"),
                WriterStorageCheckOverride::Error("injected storage query failure 2"),
                WriterStorageCheckOverride::Error("injected storage query failure 3"),
            ],
            "three consecutive disk space check failures",
        );
    }

    #[test]
    fn audio_fault_marker_blocks_resume_and_normal_export() {
        let root = test_root("audio-fault-marker-gate");
        for name in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        persist_audio_fault_marker(&root, "injected xrun", 123);

        let mut engine = Engine::new(Emitter::new());
        let resume_error = engine
            .resume_session(ResumeSessionPayload {
                session_dir: root.to_string_lossy().into_owned(),
                expected_session_id: "audio-fault-marker-gate".to_string(),
            })
            .unwrap_err();
        assert!(format!("{resume_error:#}").contains("禁止继续录制"));

        let export_error = engine.export_session(&root).unwrap_err();
        assert!(format!("{export_error:#}").contains("导出任务"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_acquires_the_task_lease_before_consulting_fault_evidence() {
        let root = test_root("export-lock-before-fault-marker");
        for name in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        persist_audio_fault_marker(&root, "injected xrun", 123);
        let owner = SessionLock::acquire(&root, "2026-08-12T00:00:00Z").unwrap();

        let engine = Engine::new(Emitter::new());
        let locked_error = engine
            .export_session_expected(&root, "export-lock-before-fault-marker")
            .unwrap_err();
        assert!(
            format!("{locked_error:#}").contains("already open in another recorder process"),
            "export inspected mutable fault evidence before the task lease: {locked_error:#}"
        );

        drop(owner);
        let fault_error = engine
            .export_session_expected(&root, "export-lock-before-fault-marker")
            .unwrap_err();
        assert!(format!("{fault_error:#}").contains("导出任务"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn synced_audio_fault_temporary_survives_publish_crash_and_fails_closed() {
        let root = test_root("audio-fault-synced-temporary");
        for name in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let marker = root.join(AUDIO_FAULT_MARKER);
        let temporary = marker.with_extension("tmp");

        assert!(!persist_audio_fault_marker_inner(
            &root,
            "injected device xrun",
            456,
            true,
        ));
        assert!(!marker.exists());
        assert!(temporary.is_file());
        let temporary_before = std::fs::read(&temporary).unwrap();
        let evidence: Value = serde_json::from_slice(&temporary_before).unwrap();
        assert_eq!(evidence["reason"].as_str(), Some("injected device xrun"));
        assert_eq!(evidence["committed_frames"].as_u64(), Some(456));
        assert!(
            evidence["timestamp"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
        );

        // The synced fixed temporary is itself durable fault evidence. Readers
        // must reject the session even though the final rename never happened.
        assert!(audio_fault_marker_present(&root).unwrap());
        assert!(ensure_no_audio_fault_marker(&root, "继续录制").is_err());
        let mut engine = Engine::new(Emitter::new());
        let resume_error = engine
            .resume_session(ResumeSessionPayload {
                session_dir: root.to_string_lossy().into_owned(),
                expected_session_id: "audio-fault-synced-temporary".to_string(),
            })
            .unwrap_err();
        assert!(format!("{resume_error:#}").contains("禁止继续录制"));
        let export_error = engine.export_session(&root).unwrap_err();
        assert!(format!("{export_error:#}").contains("导出任务"));

        // Re-reporting a later fault must not replace the first evidence or
        // allocate an unrecognized unique temporary name.
        assert!(persist_audio_fault_marker(
            &root,
            "later fault must not replace the first one",
            999,
        ));
        assert!(!marker.exists());
        assert_eq!(std::fs::read(&temporary).unwrap(), temporary_before);
        let mut marker_files = std::fs::read_dir(root.join("metadata"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        marker_files.sort();
        assert_eq!(
            marker_files,
            vec![
                OsString::from("audio-fault.tmp"),
                // Resume now acquires the task lease before consulting the
                // marker. The persistent owner diagnostic is expected; no
                // unrecognized fault-marker temporary may be allocated.
                OsString::from("session.lock"),
            ]
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn writer_advances_durable_watermark_only_after_sync() {
        let root = test_root("durable-watermark");
        let path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(4);
        let committed = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let writer_captured = Arc::new(AtomicU64::new(0));
        let writer_overflow = Arc::new(AtomicU64::new(0));
        let (ready_tx, ready_rx) = bounded(1);
        let (waveform_tx, waveform_rx) = bounded(1);
        let committed_thread = Arc::clone(&committed);
        let faulted_thread = Arc::clone(&faulted);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                16,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                committed_thread,
                writer_overflow,
                faulted_thread,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                test_writer_queue(),
                Some(waveform_tx),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);
        writer_tx
            .send(WriterMessage::Samples(vec![0.1, 0.2, 0.3, 0.4]))
            .unwrap();
        assert_eq!(
            waveform_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            vec![[0.0, 0.4]]
        );
        let deadline = Instant::now() + Duration::from_secs(1);
        while std::fs::metadata(&path).unwrap().len() <= 44 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert!(std::fs::metadata(&path).unwrap().len() > 44);
        assert_eq!(committed.load(Ordering::Acquire), 0);

        let (checkpoint_tx, checkpoint_rx) = bounded(1);
        writer_tx
            .send(WriterMessage::Checkpoint(checkpoint_tx))
            .unwrap();
        assert_eq!(checkpoint_rx.recv().unwrap().unwrap(), 4);
        assert_eq!(committed.load(Ordering::Acquire), 4);

        let (stop_tx, stop_rx) = bounded(1);
        writer_tx.send(WriterMessage::Stop(stop_tx)).unwrap();
        assert_eq!(stop_rx.recv().unwrap().unwrap(), 4);
        join.join().unwrap();
        assert!(!faulted.load(Ordering::Acquire));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn automatic_checkpoint_commits_ten_seconds_and_stop_commits_the_tail() {
        let root = test_root("automatic-checkpoint-cadence");
        let path = root.join("audio/master.wav");
        let sample_rate = 10;
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let committed = Arc::new(AtomicU64::new(0));
        let committed_thread = Arc::clone(&committed);
        let faulted = Arc::new(AtomicBool::new(false));
        let faulted_thread = Arc::clone(&faulted);
        let queue = WriterQueueBudget {
            queued_frames: Arc::new(AtomicU64::new(0)),
            enqueue_state: Arc::new(AtomicU64::new(0)),
            max_frames: sample_rate * WRITER_QUEUE_AUDIO_BUDGET_SECONDS,
        };
        let writer_queue = queue.clone();
        let (ready_tx, ready_rx) = bounded(1);
        let (waveform_tx, waveform_rx) = bounded(3);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                u32::try_from(sample_rate).unwrap(),
                16,
                false,
                MasterStorageKind::LegacySingleWav,
                sample_rate * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                Arc::new(AtomicU64::new(0)),
                committed_thread,
                Arc::new(AtomicU64::new(0)),
                faulted_thread,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                Some(waveform_tx),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);

        assert!(queue.reserve(99));
        writer_tx
            .send(WriterMessage::Samples(vec![0.1; 99]))
            .unwrap();
        waveform_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(committed.load(Ordering::Acquire), 0);

        assert!(queue.reserve(1));
        writer_tx.send(WriterMessage::Samples(vec![0.1])).unwrap();
        waveform_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        while committed.load(Ordering::Acquire) != 100 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(committed.load(Ordering::Acquire), 100);

        assert!(queue.reserve(7));
        writer_tx
            .send(WriterMessage::Samples(vec![0.1; 7]))
            .unwrap();
        waveform_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(committed.load(Ordering::Acquire), 100);

        let (stop_tx, stop_rx) = bounded(1);
        writer_tx.send(WriterMessage::Stop(stop_tx)).unwrap();
        assert_eq!(
            stop_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap(),
            107
        );
        join.join().unwrap();
        assert_eq!(committed.load(Ordering::Acquire), 107);
        assert!(!faulted.load(Ordering::Acquire));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stop_waits_for_a_callback_that_enqueues_samples_after_the_stop_message() {
        let root = test_root("stop-waits-for-late-callback");
        let path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(4));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let queue = test_writer_queue();
        let (ready_tx, ready_rx) = bounded(1);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_queue = queue.clone();
        let join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                disconnected_waveform_sender(),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);

        // Model a CPAL callback that already acquired its enqueue lease when
        // Stop overtakes it on another sender. The writer must close the gate,
        // wait for this lease, then drain the Samples message queued after Stop.
        let enqueue_lease = queue.enter().unwrap();
        assert!(queue.reserve(4));
        let (stop_tx, stop_rx) = bounded(1);
        writer_tx.send(WriterMessage::Stop(stop_tx)).unwrap();
        writer_tx
            .send(WriterMessage::Samples(vec![0.1, 0.2, 0.3, 0.4]))
            .unwrap();
        drop(enqueue_lease);

        assert_eq!(
            stop_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap(),
            4
        );
        join.join().unwrap();
        assert_eq!(committed.load(Ordering::Acquire), 4);
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        assert!(!faulted.load(Ordering::Acquire));
        assert!(!root.join(AUDIO_FAULT_MARKER).exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn callback_entry_gate_waits_through_conversion_before_closing() {
        let queue = test_writer_queue();
        // This lease models the first line of a CPAL data callback. Conversion
        // and metering have not happened yet.
        let callback_lease = queue.enter().unwrap();
        let closing_queue = queue.clone();
        let (closed_tx, closed_rx) = bounded(1);
        let closer = thread::spawn(move || {
            closing_queue.close_and_wait();
            closed_tx.send(()).unwrap();
        });

        assert!(closed_rx.recv_timeout(Duration::from_millis(25)).is_err());
        drop(callback_lease);
        closed_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        closer.join().unwrap();
        assert!(queue.enter().is_none());
    }

    #[test]
    fn capture_fault_finalizes_every_sample_queued_before_the_fault() {
        let root = test_root("capture-fault-finalize");
        let path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(4));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let queue = test_writer_queue();
        let (ready_tx, ready_rx) = bounded(1);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_queue = queue.clone();
        let join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                disconnected_waveform_sender(),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);
        assert!(queue.reserve(4));
        writer_tx
            .send(WriterMessage::Samples(vec![0.1, 0.2, 0.3, 0.4]))
            .unwrap();
        writer_tx
            .send(WriterMessage::FaultAndStop(
                "injected device disconnect".to_string(),
            ))
            .unwrap();
        join.join().unwrap();

        assert!(faulted.load(Ordering::Acquire));
        assert_eq!(overflow.load(Ordering::Acquire), 0);
        assert_eq!(committed.load(Ordering::Acquire), 4);
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 12);
        let marker: Value =
            serde_json::from_slice(&std::fs::read(root.join(AUDIO_FAULT_MARKER)).unwrap()).unwrap();
        assert!(
            marker["reason"]
                .as_str()
                .unwrap()
                .contains("injected device disconnect")
        );
        assert_eq!(marker["committed_frames"].as_u64(), Some(4));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn writer_failure_closes_the_gate_and_accounts_an_inflight_backlog() {
        let root = test_root("writer-failure-backlog-accounting");
        let path = root.join("audio/master.wav");
        ensure_audio_fault_reserve(&root).unwrap();
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(0));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let queue = test_writer_queue();
        let peak = AtomicU32::new(0f32.to_bits());
        let rms = AtomicU32::new(0f32.to_bits());
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            analysis: SilenceAnalysisPorts::energy(),
        };
        let (write_entered_tx, write_entered_rx) = bounded(1);
        let (release_write_tx, release_write_rx) = bounded(1);
        writer_write_failure_gates().lock().unwrap().insert(
            root.clone(),
            WriterWriteFailureGate {
                entered: write_entered_tx,
                release: release_write_rx,
            },
        );

        let (ready_tx, ready_rx) = bounded(1);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_queue = queue.clone();
        let join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                disconnected_waveform_sender(),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);

        publish_block(
            vec![0.1; 4],
            &writer_tx,
            &captured,
            &overflow,
            &faulted,
            &peak,
            &rms,
            &queue,
            &silence,
        );
        write_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap();

        // This callback entered before the writer observed its failure. It must
        // be allowed to finish queueing, then counted as accepted-but-lost.
        let late_lease = queue.enter().unwrap();
        release_write_tx.send(()).unwrap();
        let close_deadline = Instant::now() + Duration::from_secs(5);
        while queue.enqueue_state.load(Ordering::Acquire) & WRITER_QUEUE_CLOSED == 0
            && Instant::now() < close_deadline
        {
            thread::yield_now();
        }
        assert_ne!(
            queue.enqueue_state.load(Ordering::Acquire) & WRITER_QUEUE_CLOSED,
            0
        );
        assert!(
            faulted.load(Ordering::Acquire),
            "the unsafe state must latch before waiting for an in-flight callback"
        );
        assert!(
            root.join(AUDIO_FAULT_MARKER).is_file(),
            "durable fault evidence must exist before the in-flight callback is released"
        );
        publish_leased_block(
            vec![0.2; 2],
            &writer_tx,
            &captured,
            &overflow,
            &faulted,
            &peak,
            &rms,
            &queue,
            late_lease,
            &silence,
        );
        join.join().unwrap();

        assert!(faulted.load(Ordering::Acquire));
        assert_eq!(captured.load(Ordering::Acquire), 6);
        assert_eq!(committed.load(Ordering::Acquire), 0);
        assert_eq!(overflow.load(Ordering::Acquire), 6);
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        let marker: Value =
            serde_json::from_slice(&std::fs::read(root.join(AUDIO_FAULT_MARKER)).unwrap()).unwrap();
        let reason = marker["reason"].as_str().unwrap();
        assert!(reason.contains("accepted_frames=6"), "{reason}");
        assert!(reason.contains("durable_frames=0"), "{reason}");
        assert!(reason.contains("lost_frames=6"), "{reason}");
        assert_eq!(marker["committed_frames"].as_u64(), Some(0));
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 0);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn writer_enospc_activates_reserve_when_detailed_fault_marker_cannot_be_created() {
        let root = test_root("writer-enospc-reserved-fault-marker");
        let path = root.join("audio/master.wav");
        ensure_audio_fault_reserve(&root).unwrap();
        let reserve = root.join(AUDIO_FAULT_RESERVE);
        assert!(reserve.is_file());

        // Model the dangerous ordering from production: the PCM write consumes
        // the remaining allocatable space, and both attempts to create the
        // detailed `audio-fault.tmp` fail with ENOSPC. The pre-synced reserve
        // must still become the final fail-closed marker.
        set_audio_fault_detail_create_failures(&root, 2);
        let (write_entered_tx, write_entered_rx) = bounded(1);
        let (release_write_tx, release_write_rx) = bounded(1);
        writer_write_failure_gates().lock().unwrap().insert(
            root.clone(),
            WriterWriteFailureGate {
                entered: write_entered_tx,
                release: release_write_rx,
            },
        );

        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(4));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let queue = test_writer_queue();
        let (ready_tx, ready_rx) = bounded(1);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_queue = queue.clone();
        let join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                disconnected_waveform_sender(),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);
        assert!(queue.reserve(4));
        writer_tx
            .send(WriterMessage::Samples(vec![0.1, 0.2, 0.3, 0.4]))
            .unwrap();
        write_entered_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        release_write_tx.send(()).unwrap();
        join.join().unwrap();

        assert!(faulted.load(Ordering::Acquire));
        assert_eq!(captured.load(Ordering::Acquire), 4);
        assert_eq!(committed.load(Ordering::Acquire), 0);
        assert_eq!(overflow.load(Ordering::Acquire), 4);
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        assert!(!reserve.exists());
        assert!(!root.join("metadata/audio-fault.tmp").exists());
        let marker_path = root.join(AUDIO_FAULT_MARKER);
        let marker: Value = serde_json::from_slice(&std::fs::read(&marker_path).unwrap()).unwrap();
        assert_eq!(marker["reserved_audio_fault"].as_bool(), Some(true));
        assert_eq!(marker["committed_frames"].as_u64(), Some(0));
        assert!(marker["reason"].as_str().unwrap().contains("unsafe state"));
        assert!(ensure_no_audio_fault_marker(&root, "继续录制").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn writer_uses_segmented_master_and_exports_across_boundaries() {
        let root = test_root("segmented-writer-integration");
        let path = root.join("audio/segments");
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(16);
        let committed = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = bounded(1);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let writer_committed = Arc::clone(&committed);
        let writer_faulted = Arc::clone(&faulted);
        let join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::SegmentedWav,
                3,
                &writer_storage_dir,
                Arc::new(AtomicU64::new(10)),
                writer_committed,
                Arc::new(AtomicU64::new(0)),
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                test_writer_queue(),
                disconnected_waveform_sender(),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);
        writer_tx
            .send(WriterMessage::Samples(vec![0.1; 8]))
            .unwrap();
        let (checkpoint_tx, checkpoint_rx) = bounded(1);
        writer_tx
            .send(WriterMessage::Checkpoint(checkpoint_tx))
            .unwrap();
        assert_eq!(checkpoint_rx.recv().unwrap().unwrap(), 8);
        assert_eq!(committed.load(Ordering::Acquire), 8);

        let preview = root.join("preview/cross-segment.wav");
        std::fs::create_dir_all(preview.parent().unwrap()).unwrap();
        let (export_tx, export_rx) = bounded(1);
        writer_tx
            .send(WriterMessage::ExportRange {
                destination: preview.clone(),
                start_frame: 2,
                end_frame: 7,
                reply: export_tx,
            })
            .unwrap();
        assert_eq!(export_rx.recv().unwrap().unwrap(), 5);
        assert!(preview.is_file());

        let (failed_export_tx, failed_export_rx) = bounded(1);
        writer_tx
            .send(WriterMessage::ExportRange {
                // An existing directory cannot be atomically replaced by the
                // rendered WAV. This is a derived-output failure, not a master
                // recording failure.
                destination: preview.parent().unwrap().to_path_buf(),
                start_frame: 0,
                end_frame: 1,
                reply: failed_export_tx,
            })
            .unwrap();
        assert!(failed_export_rx.recv().unwrap().is_err());
        assert!(!faulted.load(Ordering::Acquire));

        writer_tx
            .send(WriterMessage::Samples(vec![0.2; 2]))
            .unwrap();
        let (checkpoint_tx, checkpoint_rx) = bounded(1);
        writer_tx
            .send(WriterMessage::Checkpoint(checkpoint_tx))
            .unwrap();
        assert_eq!(checkpoint_rx.recv().unwrap().unwrap(), 10);
        assert_eq!(committed.load(Ordering::Acquire), 10);

        let (stop_tx, stop_rx) = bounded(1);
        writer_tx.send(WriterMessage::Stop(stop_tx)).unwrap();
        assert_eq!(stop_rx.recv().unwrap().unwrap(), 10);
        join.join().unwrap();
        assert!(!faulted.load(Ordering::Acquire));
        assert!(path.join("master-000001.wav").is_file());
        assert!(path.join("master-000002.wav").is_file());
        assert!(path.join("master-000003.wav").is_file());
        assert!(path.join("master-000004.wav").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn blocked_preview_worker_does_not_block_or_reorder_live_audio() {
        let root = test_root("async-preview-pressure");
        let path = root.join("audio/segments");
        let preview = root.join("preview/blocked.wav");
        std::fs::create_dir_all(preview.parent().unwrap()).unwrap();
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(3));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let queued_frames = Arc::new(AtomicU64::new(0));
        let queue = WriterQueueBudget {
            queued_frames: Arc::clone(&queued_frames),
            enqueue_state: Arc::new(AtomicU64::new(0)),
            max_frames: 48_000 * WRITER_QUEUE_AUDIO_BUDGET_SECONDS,
        };
        let (ready_tx, ready_rx) = bounded(1);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_queue = queue.clone();
        let (waveform_tx, _waveform_rx) = bounded(128);
        let join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::SegmentedWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                Some(waveform_tx),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);

        let initial = vec![-0.5, 0.0, 0.5];
        writer_tx
            .send(WriterMessage::Samples(initial.clone()))
            .unwrap();
        let (checkpoint_tx, checkpoint_rx) = bounded(1);
        writer_tx
            .send(WriterMessage::Checkpoint(checkpoint_tx))
            .unwrap();
        assert_eq!(checkpoint_rx.recv().unwrap().unwrap(), 3);

        let (entered_tx, entered_rx) = bounded(1);
        let (release_tx, release_rx) = bounded(1);
        export_worker_test_gates().lock().unwrap().insert(
            preview.clone(),
            ExportWorkerTestGate {
                entered: entered_tx,
                release: release_rx,
            },
        );
        let (export_tx, export_rx) = bounded(1);
        writer_tx
            .send(WriterMessage::ExportRange {
                destination: preview.clone(),
                start_frame: 0,
                end_frame: 3,
                reply: export_tx,
            })
            .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();

        let peak = AtomicU32::new(0f32.to_bits());
        let rms = AtomicU32::new(0f32.to_bits());
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            analysis: SilenceAnalysisPorts::energy(),
        };
        const BLOCK_FRAMES: usize = 480;
        const BLOCK_COUNT: usize = 600;
        for index in 0..BLOCK_COUNT {
            publish_block(
                vec![0.125; BLOCK_FRAMES],
                &writer_tx,
                &captured,
                &overflow,
                &faulted,
                &peak,
                &rms,
                &queue,
                &silence,
            );
            if index.is_multiple_of(16) {
                thread::yield_now();
            }
        }
        let expected_frames = 3 + (BLOCK_FRAMES * BLOCK_COUNT) as u64;
        let (checkpoint_tx, checkpoint_rx) = bounded(1);
        writer_tx
            .send(WriterMessage::Checkpoint(checkpoint_tx))
            .unwrap();
        assert_eq!(
            checkpoint_rx
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap(),
            expected_frames
        );

        release_tx.send(()).unwrap();
        assert_eq!(
            export_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap(),
            3
        );
        let (stop_tx, stop_rx) = bounded(1);
        writer_tx.send(WriterMessage::Stop(stop_tx)).unwrap();
        assert_eq!(stop_rx.recv().unwrap().unwrap(), expected_frames);
        join.join().unwrap();

        assert_eq!(captured.load(Ordering::Acquire), expected_frames);
        assert_eq!(committed.load(Ordering::Acquire), expected_frames);
        assert_eq!(overflow.load(Ordering::Acquire), 0);
        assert!(!faulted.load(Ordering::Acquire));
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        let master = std::fs::read(path.join("master-000001.wav")).unwrap();
        let rendered = std::fs::read(&preview).unwrap();
        let rendered_data_bytes =
            usize::try_from(u32::from_le_bytes(rendered[40..44].try_into().unwrap())).unwrap();
        assert_eq!(rendered_data_bytes, 9);
        assert_eq!(&rendered[44..44 + rendered_data_bytes], &master[44..53]);
        assert_eq!(&rendered[44 + rendered_data_bytes..], &[0]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn empty_callback_block_does_not_enter_the_writer_channel() {
        let (writer, receiver) = unbounded::<WriterMessage>();
        let captured = AtomicU64::new(17);
        let overflow = AtomicU64::new(0);
        let faulted = AtomicBool::new(false);
        let peak = AtomicU32::new(0.25f32.to_bits());
        let rms = AtomicU32::new(0.125f32.to_bits());
        let queue = test_writer_queue();
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(9)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(11)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(7)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            analysis: SilenceAnalysisPorts::energy(),
        };

        publish_block(
            Vec::new(),
            &writer,
            &captured,
            &overflow,
            &faulted,
            &peak,
            &rms,
            &queue,
            &silence,
        );

        assert!(receiver.try_recv().is_err());
        assert_eq!(captured.load(Ordering::Acquire), 17);
        assert_eq!(overflow.load(Ordering::Acquire), 0);
        assert!(!faulted.load(Ordering::Acquire));
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        assert_eq!(queue.enqueue_state.load(Ordering::Acquire), 0);
        assert_eq!(f32::from_bits(peak.load(Ordering::Relaxed)), 0.25);
        assert_eq!(f32::from_bits(rms.load(Ordering::Relaxed)), 0.125);
        assert_eq!(silence.silence_samples.load(Ordering::Acquire), 9);
    }

    #[test]
    fn callback_fault_closes_gate_and_activates_generic_marker_before_waiting() {
        let root = test_root("callback-fault-marker-before-wait");
        ensure_audio_fault_reserve(&root).unwrap();
        let queue = test_writer_queue();
        let older_callback = queue.enter().unwrap();
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let persistence = CaptureFaultPersistence {
            session_dir: root.clone(),
            recovery: CaptureRecoveryTelemetry::default(),
        };
        let (writer, receiver) = unbounded::<WriterMessage>();
        let queue_for_fault = queue.clone();
        let overflow_for_fault = Arc::clone(&overflow);
        let faulted_for_fault = Arc::clone(&faulted);
        let (done_tx, done_rx) = bounded(1);
        let join = thread::spawn(move || {
            let faulting_callback = queue_for_fault.enter().unwrap();
            fail_capture_block(
                "injected callback discontinuity".to_string(),
                64,
                &writer,
                &overflow_for_fault,
                &faulted_for_fault,
                &queue_for_fault,
                faulting_callback,
                Some(&persistence),
            );
            let _ = done_tx.send(());
        });

        let deadline = Instant::now() + Duration::from_secs(2);
        while !audio_fault_marker_present(&root).unwrap() && Instant::now() < deadline {
            thread::yield_now();
        }
        assert!(
            audio_fault_marker_present(&root).unwrap(),
            "known callback discontinuity lacked durable evidence while close_and_wait was blocked"
        );
        assert!(faulted.load(Ordering::Acquire));
        assert_eq!(overflow.load(Ordering::Acquire), 64);
        assert!(
            queue.enter().is_none(),
            "known callback fault left the callback-entry gate open"
        );
        assert!(
            done_rx.try_recv().is_err(),
            "fault path did not wait for the older callback"
        );

        drop(older_callback);
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        join.join().unwrap();
        match receiver.try_recv().unwrap() {
            WriterMessage::FaultAndStop(reason) => {
                assert!(reason.contains("injected callback discontinuity"));
                assert!(reason.contains("dropped_frames=64"));
            }
            _ => panic!("capture fault did not reach the writer"),
        }
        let marker: Value =
            serde_json::from_slice(&std::fs::read(root.join(AUDIO_FAULT_MARKER)).unwrap()).unwrap();
        assert_eq!(marker["reserved_audio_fault"].as_bool(), Some(true));
        assert_eq!(marker["committed_frames"].as_u64(), Some(0));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_capture_blocks_fault_before_samples_or_timeline_updates() {
        let errors = [
            convert_frames(&[1i16, 2, 3], 2, 0, f32::from).unwrap_err(),
            convert_frames(&[f32::NAN], 1, 0, |sample| sample).unwrap_err(),
        ];
        for error in errors {
            let (writer, receiver) = unbounded::<WriterMessage>();
            let captured = AtomicU64::new(23);
            let overflow = AtomicU64::new(0);
            let faulted = AtomicBool::new(false);
            let queue = test_writer_queue();
            let lease = queue.enter().unwrap();

            fail_capture_block(
                error.reason,
                error.dropped_frames,
                &writer,
                &overflow,
                &faulted,
                &queue,
                lease,
                None,
            );

            match receiver.try_recv().unwrap() {
                WriterMessage::FaultAndStop(reason) => {
                    assert!(reason.contains("dropped_frames="));
                }
                _ => panic!("malformed callback enqueued normal audio"),
            }
            assert!(receiver.try_recv().is_err());
            assert_eq!(captured.load(Ordering::Acquire), 23);
            assert_eq!(overflow.load(Ordering::Acquire), error.dropped_frames);
            assert!(faulted.load(Ordering::Acquire));
            assert!(queue.enter().is_none());
            assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        }
    }

    #[test]
    fn capture_timeline_overflow_fails_closed_without_enqueuing_samples() {
        let (writer, receiver) = unbounded::<WriterMessage>();
        let captured = AtomicU64::new(u64::MAX - 1);
        let overflow = AtomicU64::new(0);
        let faulted = AtomicBool::new(false);
        let peak = AtomicU32::new(0.25f32.to_bits());
        let rms = AtomicU32::new(0.125f32.to_bits());
        let queue = test_writer_queue();
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(9)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(80)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(70)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            analysis: SilenceAnalysisPorts::energy(),
        };

        publish_block(
            vec![0.1, 0.2],
            &writer,
            &captured,
            &overflow,
            &faulted,
            &peak,
            &rms,
            &queue,
            &silence,
        );

        match receiver.try_recv().unwrap() {
            WriterMessage::FaultAndStop(reason) => assert!(reason.contains("counter overflow")),
            _ => panic!("counter overflow enqueued normal audio"),
        }
        assert!(receiver.try_recv().is_err());
        assert_eq!(captured.load(Ordering::Acquire), u64::MAX - 1);
        assert_eq!(overflow.load(Ordering::Acquire), 2);
        assert!(faulted.load(Ordering::Acquire));
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        assert_eq!(silence.silence_samples.load(Ordering::Acquire), 9);
        assert_eq!(silence.last_signal_sample.load(Ordering::Acquire), 80);
        assert_eq!(f32::from_bits(peak.load(Ordering::Relaxed)), 0.25);
        assert_eq!(f32::from_bits(rms.load(Ordering::Relaxed)), 0.125);
    }

    #[test]
    fn queue_overflow_fails_closed_without_advancing_the_timeline() {
        let (writer, _receiver) = bounded::<WriterMessage>(0);
        let captured = AtomicU64::new(100);
        let overflow = AtomicU64::new(0);
        let faulted = AtomicBool::new(false);
        let peak = AtomicU32::new(0.25f32.to_bits());
        let rms = AtomicU32::new(0.125f32.to_bits());
        let queue = WriterQueueBudget {
            queued_frames: Arc::new(AtomicU64::new(0)),
            enqueue_state: Arc::new(AtomicU64::new(0)),
            max_frames: 0,
        };
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(9)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(80)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(70)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            analysis: SilenceAnalysisPorts::energy(),
        };
        publish_block(
            vec![0.1, 0.2, 0.3],
            &writer,
            &captured,
            &overflow,
            &faulted,
            &peak,
            &rms,
            &queue,
            &silence,
        );
        assert!(faulted.load(Ordering::Acquire));
        assert_eq!(overflow.load(Ordering::Acquire), 3);
        assert_eq!(captured.load(Ordering::Acquire), 100);
        assert_eq!(silence.silence_samples.load(Ordering::Acquire), 9);
        assert_eq!(silence.last_signal_sample.load(Ordering::Acquire), 80);
        assert_eq!(
            silence.attempt_signal_start_sample.load(Ordering::Acquire),
            70
        );
        publish_block(
            vec![0.4, 0.5],
            &writer,
            &captured,
            &overflow,
            &faulted,
            &peak,
            &rms,
            &queue,
            &silence,
        );
        assert_eq!(overflow.load(Ordering::Acquire), 5);
        assert_eq!(captured.load(Ordering::Acquire), 100);
    }

    #[test]
    fn a_full_twenty_second_queue_budget_stops_without_detaching_the_writer() {
        let root = test_root("queue-budget-stop");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let master_path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(0));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let queue = WriterQueueBudget {
            queued_frames: Arc::new(AtomicU64::new(0)),
            enqueue_state: Arc::new(AtomicU64::new(0)),
            max_frames: 48_000 * WRITER_QUEUE_AUDIO_BUDGET_SECONDS,
        };
        let peak = AtomicU32::new(0f32.to_bits());
        let rms = AtomicU32::new(0f32.to_bits());
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            analysis: SilenceAnalysisPorts::energy(),
        };
        const BLOCK_FRAMES: usize = 4_800;
        let block_count = usize::try_from(queue.max_frames).unwrap() / BLOCK_FRAMES;
        for _ in 0..block_count {
            publish_block(
                vec![0.125; BLOCK_FRAMES],
                &writer_tx,
                &captured,
                &overflow,
                &faulted,
                &peak,
                &rms,
                &queue,
                &silence,
            );
        }
        assert_eq!(captured.load(Ordering::Acquire), queue.max_frames);
        assert_eq!(
            queue.queued_frames.load(Ordering::Acquire),
            queue.max_frames
        );
        assert_eq!(overflow.load(Ordering::Acquire), 0);
        assert!(!faulted.load(Ordering::Acquire));

        let (ready_tx, ready_rx) = bounded(1);
        let writer_path = master_path.clone();
        let writer_storage_dir = root.clone();
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_queue = queue.clone();
        let writer_join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                writer_queue,
                disconnected_waveform_sender(),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);
        let mut session = RecordingSession {
            _session_lock: Some(SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap()),
            session_dir: root.clone(),
            snapshot: test_snapshot(),
            stream: None,
            stream_reaper: test_stream_reaper(),
            writer_tx,
            writer_queue: queue.clone(),
            writer_join: Some(writer_join),
            telemetry_join: None,
            capture_watchdog_join: None,
            telemetry_stop: Arc::new(AtomicBool::new(false)),
            capture_watchdog_armed: Arc::new(AtomicBool::new(false)),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            captured,
            committed,
            overflow,
            capture_recovery: CaptureRecoveryTelemetry::default(),
            faulted,
            peak: Arc::new(AtomicU32::new(0)),
            rms: Arc::new(AtomicU32::new(0)),
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            silence_duration_ms: Arc::new(AtomicU32::new(1_000)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            silence_analysis: SilenceAnalysisPorts::energy(),
            vad_tx: None,
            vad_join: None,
            active_attempt: None,
            metadata_fault: None,
            stop_requested: false,
            capture_stopped: false,
        };

        let result = session
            .stop_with_timeout(WRITER_COMMIT_DEADLINE)
            .expect("a full writer-queue drain must finish within the commit deadline");
        assert!(result["warnings"].as_array().unwrap().is_empty());
        assert!(session.capture_stopped);
        assert!(session.writer_join.is_none());
        assert_eq!(
            session.committed.load(Ordering::Acquire),
            48_000 * WRITER_QUEUE_AUDIO_BUDGET_SECONDS
        );
        assert!(!session.faulted.load(Ordering::Acquire));
        assert_eq!(queue.queued_frames.load(Ordering::Acquire), 0);
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn faulted_shutdown_marks_the_active_attempt_interrupted_at_durable_eof() {
        let root = test_root("faulted-active-shutdown");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let master_path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(4);
        let committed = Arc::new(AtomicU64::new(0));
        let captured = Arc::new(AtomicU64::new(4));
        let overflow = Arc::new(AtomicU64::new(1));
        let faulted = Arc::new(AtomicBool::new(true));
        let (ready_tx, ready_rx) = bounded(1);
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_path = master_path.clone();
        let writer_storage_dir = root.clone();
        let writer_join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                test_writer_queue(),
                disconnected_waveform_sender(),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);
        writer_tx
            .send(WriterMessage::Samples(vec![0.1, 0.2, 0.3, 0.4]))
            .unwrap();
        let attempt_signal_start_sample = Arc::new(AtomicU64::new(2));
        let mut session = RecordingSession {
            _session_lock: Some(SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap()),
            session_dir: root.clone(),
            snapshot: test_snapshot(),
            stream: None,
            stream_reaper: test_stream_reaper(),
            writer_tx,
            writer_queue: test_writer_queue(),
            writer_join: Some(writer_join),
            telemetry_join: None,
            capture_watchdog_join: None,
            telemetry_stop: Arc::new(AtomicBool::new(false)),
            capture_watchdog_armed: Arc::new(AtomicBool::new(false)),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            captured,
            committed,
            overflow,
            capture_recovery: CaptureRecoveryTelemetry::default(),
            faulted,
            peak: Arc::new(AtomicU32::new(0f32.to_bits())),
            rms: Arc::new(AtomicU32::new(0f32.to_bits())),
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample,
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            silence_duration_ms: Arc::new(AtomicU32::new(1_000)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            silence_analysis: SilenceAnalysisPorts::energy(),
            vad_tx: None,
            vad_join: None,
            active_attempt: Some(ActiveAttempt {
                item_id: "001".to_string(),
                attempt_id: "001-a1".to_string(),
                start_sample: 0,
                recording_started_sample: 1,
                input_discontinuity_count_at_start: 0,
            }),
            metadata_fault: None,
            stop_requested: false,
            capture_stopped: false,
        };

        let result = session.stop().unwrap();
        let stopped: SessionSnapshot = serde_json::from_value(result["snapshot"].clone()).unwrap();
        assert_eq!(stopped.status, "faulted");
        assert_eq!(stopped.committed_samples, 4);
        assert_eq!(stopped.items[0].attempts.len(), 1);
        assert_eq!(stopped.items[0].attempts[0].status, "interrupted");
        assert_eq!(stopped.items[0].attempts[0].end_sample, 4);
        assert_eq!(stopped.items[0].status, "pending");
        assert!(session.active_attempt.is_none());
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_accepts_pending_rows_but_rejects_review_and_invalid_selected_attempts() {
        let mut snapshot = test_snapshot();
        snapshot.status = "faulted".to_string();
        let error = validate_snapshot_for_export(&snapshot).unwrap_err();
        assert!(format!("{error:#}").contains("原始母轨"));

        snapshot.status = "stopped".to_string();
        snapshot.overflow_samples = 1;
        assert!(validate_snapshot_for_export(&snapshot).is_err());

        snapshot.overflow_samples = 0;
        assert!(validate_snapshot_for_export(&snapshot).is_ok());

        snapshot.items[0].status = "review".to_string();
        assert!(validate_snapshot_for_export(&snapshot).is_err());

        snapshot.items[0].status = "accepted".to_string();
        assert!(validate_snapshot_for_export(&snapshot).is_err());

        snapshot.committed_samples = 100;
        cover_committed_test_audio(&mut snapshot);
        snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        snapshot.items[0].attempts.push(Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 10,
            recording_started_sample: 20,
            head_silence_armed_sample: 0,
            head_silence_passed_sample: 0,
            required_head_silence_samples: 0,
            content_started_sample: 25,
            end_sample: 90,
            forced_without_tail_silence: false,
            tail_silence_samples: 0,
            required_tail_silence_samples: 0,
            status: "interrupted".to_string(),
            created_at: "2026-08-11T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        });
        assert!(validate_snapshot_for_export(&snapshot).is_err());

        snapshot.items[0].attempts[0].status = "accepted".to_string();
        snapshot.items[0].attempts[0].end_sample = 101;
        assert!(validate_snapshot_for_export(&snapshot).is_err());

        snapshot.items[0].attempts[0].end_sample = 100;
        assert!(validate_attempt_boundaries(&snapshot, snapshot.committed_samples).is_err());
        snapshot.items[0].attempts[0].recording_started_sample = 10;
        assert!(validate_snapshot_for_export(&snapshot).is_ok());

        snapshot.items[0].status = "skipped".to_string();
        assert!(validate_snapshot_for_export(&snapshot).is_err());

        snapshot.items[0].selected_attempt_id = None;
        assert!(validate_snapshot_for_export(&snapshot).is_ok());
    }

    #[test]
    fn sentence_delivery_requires_explicit_provenance_coverage() {
        let mut snapshot = test_snapshot();
        snapshot.status = "stopped".to_string();
        snapshot.captured_samples = 10;
        snapshot.committed_samples = 10;
        select_safe_first_attempt(&mut snapshot, 10);
        snapshot.capture_provenance.clear();

        assert!(!attempt_range_has_provenance(
            &snapshot,
            &snapshot.items[0].attempts[0]
        ));
        assert!(validate_snapshot_for_cut_scope(&snapshot, ExportScope::ConfirmedOnly).is_err());
        assert!(usable_preview_attempt(&snapshot, "001", "001-a1").is_err());

        cover_committed_test_audio(&mut snapshot);
        validate_snapshot_for_cut_scope(&snapshot, ExportScope::ConfirmedOnly).unwrap();
        usable_preview_attempt(&snapshot, "001", "001-a1").unwrap();
    }

    #[test]
    fn offline_preview_enforces_the_complete_head_silence_contract() {
        let mut snapshot = test_snapshot();
        snapshot.status = "stopped".to_string();
        snapshot.captured_samples = 1_000;
        snapshot.committed_samples = 1_000;
        cover_committed_test_audio(&mut snapshot);
        snapshot.items[0].status = "accepted".to_string();
        snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        snapshot.items[0].attempts = vec![Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 100,
            recording_started_sample: 100,
            head_silence_armed_sample: 100,
            head_silence_passed_sample: 200,
            required_head_silence_samples: 1_000,
            content_started_sample: 300,
            end_sample: 800,
            forced_without_tail_silence: false,
            tail_silence_samples: 100,
            required_tail_silence_samples: 100,
            status: "accepted".to_string(),
            created_at: "2026-08-27T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        }];

        assert!(attempt_is_delivery_safe(&snapshot, &snapshot.items[0].attempts[0]).unwrap());
        assert!(usable_preview_attempt(&snapshot, "001", "001-a1").is_err());

        snapshot.items[0].attempts[0].required_head_silence_samples = 100;
        usable_preview_attempt(&snapshot, "001", "001-a1").unwrap();
    }

    #[test]
    fn cuts_block_review_but_allow_an_accepted_previous_version_after_a_bad_retake() {
        let mut snapshot = test_snapshot();
        snapshot.status = "stopped".to_string();
        snapshot.captured_samples = 30;
        snapshot.committed_samples = 30;
        cover_committed_test_audio(&mut snapshot);
        snapshot.items[0].status = "review".to_string();
        snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        snapshot.items[0].attempts = vec![
            test_attempt("001-a1", 0, 10, "accepted"),
            test_attempt("001-a2", 10, 20, "recorded"),
        ];

        assert!(validate_snapshot_for_artifact(&snapshot, Some(ExportArtifact::CutsZip)).is_err());
        validate_snapshot_for_artifact(&snapshot, Some(ExportArtifact::FullTrack)).unwrap();
        validate_snapshot_for_artifact(&snapshot, Some(ExportArtifact::TimestampsJson)).unwrap();

        snapshot.items[0].status = "accepted".to_string();
        snapshot.items[0].attempts[1].status = "needs_rerecord".to_string();
        validate_snapshot_for_artifact(&snapshot, Some(ExportArtifact::CutsZip)).unwrap();
        validate_snapshot_for_export(&snapshot).unwrap();

        snapshot.items[0].status = "review".to_string();
        snapshot.items[0].selected_attempt_id = None;
        snapshot.items[0].attempts = vec![test_attempt("001-a1", 10, 20, "needs_rerecord")];
        assert!(validate_snapshot_for_artifact(&snapshot, Some(ExportArtifact::CutsZip)).is_err());
    }

    #[test]
    fn zero_length_vad_diagnostic_does_not_block_a_safe_selected_old_version() {
        let mut snapshot = test_snapshot();
        snapshot.status = "stopped".to_string();
        snapshot.captured_samples = 10;
        snapshot.committed_samples = 10;
        cover_committed_test_audio(&mut snapshot);
        snapshot.items[0].status = "accepted".to_string();
        snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        let mut diagnostic = test_attempt("001-a2", 10, 10, "needs_rerecord");
        diagnostic.quality_issues = vec![AttemptQualityIssue {
            code: "vad_queue_overflow".to_string(),
            start_sample: Some(10),
            end_sample: Some(10),
            detector_generation: Some(2),
        }];
        snapshot.items[0].attempts = vec![test_attempt("001-a1", 0, 10, "accepted"), diagnostic];

        validate_attempt_boundaries(&snapshot, snapshot.committed_samples).unwrap();
        validate_snapshot_for_cut_scope(&snapshot, ExportScope::ConfirmedOnly).unwrap();
        assert!(usable_preview_attempt(&snapshot, "001", "001-a2").is_err());
        assert!(!attempt_is_delivery_safe(&snapshot, &snapshot.items[0].attempts[1]).unwrap());
    }

    #[test]
    fn validate_attempt_boundaries_accepts_clip_start_after_required_head_silence() {
        let mut snapshot = test_snapshot();
        snapshot.status = "stopped".to_string();
        snapshot.committed_samples = 5_144_640;
        cover_committed_test_audio(&mut snapshot);
        snapshot.items[0].id = "0001".to_string();
        snapshot.items[0].status = "accepted".to_string();
        snapshot.items[0].selected_attempt_id = Some("0001-a1".to_string());
        snapshot.items[0].attempts.push(Attempt {
            attempt_id: "0001-a1".to_string(),
            start_sample: 1_866_240,
            recording_started_sample: 1_178_400,
            head_silence_armed_sample: 1_178_400,
            head_silence_passed_sample: 1_866_240,
            required_head_silence_samples: 48_000,
            content_started_sample: 1_973_760,
            end_sample: 2_294_400,
            forced_without_tail_silence: false,
            tail_silence_samples: 133_440,
            required_tail_silence_samples: 48_000,
            status: "accepted".to_string(),
            created_at: "2026-08-18T06:28:39Z".to_string(),
            quality_issues: Vec::new(),
        });
        snapshot.items.push(ItemState {
            id: "0003".to_string(),
            text: "今天过得怎么样".to_string(),
            label: "疑问句".to_string(),
            status: "accepted".to_string(),
            attempts: vec![Attempt {
                attempt_id: "0003-a1".to_string(),
                start_sample: 4_024_800,
                recording_started_sample: 3_976_800,
                head_silence_armed_sample: 3_976_800,
                head_silence_passed_sample: 4_024_800,
                required_head_silence_samples: 48_000,
                content_started_sample: 4_093_440,
                end_sample: 4_960_800,
                forced_without_tail_silence: false,
                tail_silence_samples: 78_240,
                required_tail_silence_samples: 48_000,
                status: "accepted".to_string(),
                created_at: "2026-08-18T06:29:35Z".to_string(),
                quality_issues: Vec::new(),
            }],
            selected_attempt_id: Some("0003-a1".to_string()),
        });

        validate_attempt_boundaries(&snapshot, snapshot.committed_samples).unwrap();
        validate_snapshot_for_artifact(&snapshot, Some(ExportArtifact::CutsZip)).unwrap();

        snapshot.items[0].attempts[0].start_sample = 1_500_000;
        let error = validate_attempt_boundaries(&snapshot, snapshot.committed_samples).unwrap_err();
        assert!(format!("{error:#}").contains("句子时间戳"));
    }

    #[test]
    fn validate_attempt_boundaries_accepts_vad_trimmed_clip_start() {
        let mut snapshot = test_snapshot();
        snapshot.status = "stopped".to_string();
        snapshot.silence_detector = SilenceDetector::Vad;
        snapshot.committed_samples = 5_144_640;
        cover_committed_test_audio(&mut snapshot);
        snapshot.items[0].id = "0001".to_string();
        snapshot.items[0].status = "accepted".to_string();
        snapshot.items[0].selected_attempt_id = Some("0001-a1".to_string());
        snapshot.items[0].attempts.push(Attempt {
            attempt_id: "0001-a1".to_string(),
            // Click at 1_178_400, first speech at 1_973_760, 1s pad → clip starts
            // at 1_925_760, not at the click or the pending-timer mark.
            start_sample: 1_925_760,
            recording_started_sample: 1_178_400,
            head_silence_armed_sample: 1_178_400,
            head_silence_passed_sample: 1_226_400,
            required_head_silence_samples: 48_000,
            content_started_sample: 1_973_760,
            end_sample: 2_294_400,
            forced_without_tail_silence: false,
            tail_silence_samples: 48_000,
            required_tail_silence_samples: 48_000,
            status: "accepted".to_string(),
            created_at: "2026-08-20T10:50:00Z".to_string(),
            quality_issues: Vec::new(),
        });

        validate_attempt_boundaries(&snapshot, snapshot.committed_samples).unwrap();
        validate_snapshot_for_artifact(&snapshot, Some(ExportArtifact::CutsZip)).unwrap();

        snapshot.items[0].attempts[0].start_sample = 1_500_000;
        let error = validate_attempt_boundaries(&snapshot, snapshot.committed_samples).unwrap_err();
        assert!(format!("{error:#}").contains("句子时间戳"));
    }

    #[test]
    fn create_and_inspect_session_never_activate_capture() {
        let root = test_root("create-inspect-offline");
        // prepare_new_session requires the final task directory not to exist.
        std::fs::remove_dir_all(&root).unwrap();
        let engine = Engine::new(Emitter::new());
        let created = engine
            .create_session(StartSessionPayload {
                session_dir: root.to_string_lossy().into_owned(),
                session_id: "offline-create".to_string(),
                script_name: "script.csv".to_string(),
                device_id: Some("device:remembered".to_string()),
                device_name: Some("Remembered input".to_string()),
                sample_rate: 48_000,
                bit_depth: 24,
                input_sample_format: String::new(),
                input_channel: 1,
                capture_share_mode: CaptureShareMode::Exclusive,
                silence_duration_ms: 1_000,
                noise_threshold_dbfs: Some(-42.0),
                silence_threshold_dbfs: -42.0,
                silence_detector: SilenceDetector::Energy,
                items: vec![ScriptItem {
                    id: "001".to_string(),
                    text: "第一句".to_string(),
                    label: String::new(),
                }],
            })
            .unwrap();

        assert!(engine.session.is_none());
        assert_eq!(created["mode"], "inspect");
        assert_eq!(created["snapshot"]["status"], "stopped");
        assert_eq!(
            created["snapshot"]["capture_share_mode"],
            if cfg!(target_os = "windows") {
                "exclusive"
            } else {
                "shared"
            }
        );
        assert!(!root.join(SEGMENTED_MASTER_AUDIO).exists());

        let inspected = engine
            .inspect_session_expected(&root, "offline-create")
            .unwrap();
        assert!(engine.session.is_none());
        assert_eq!(inspected["mode"], "inspect");
        assert_eq!(inspected["snapshot"]["items"][0]["id"], "001");

        engine
            .export_session_artifact_expected(
                &root,
                "offline-create",
                ExportArtifact::TimestampsJson,
            )
            .unwrap();
        assert!(root.join("export/timestamps.json").is_file());
        let error = engine
            .export_session_artifact_expected(&root, "offline-create", ExportArtifact::CutsZip)
            .unwrap_err();
        assert!(format!("{error:#}").contains("没有可安全导出"));
        assert!(!root.join("export/cuts.zip").exists());
        engine
            .export_session_artifact_expected(&root, "offline-create", ExportArtifact::FullTrack)
            .unwrap();
        assert!(root.join("export/full-track.wav").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reset_session_returns_a_pristine_unused_task() {
        let root = test_root("reset-session-pristine");
        for directory in ["audio/segments", "metadata", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        std::fs::write(root.join("audio/segments/master-000001.wav"), b"AUDIO").unwrap();
        std::fs::write(root.join("export/full-track.wav"), b"EXPORT").unwrap();
        std::fs::write(root.join("preview/001-a1.wav"), b"PREVIEW").unwrap();
        std::fs::write(
            root.join(AUDIO_FAULT_MARKER),
            b"{\"reason\":\"overflow\"}\n",
        )
        .unwrap();
        let mut snapshot = test_snapshot();
        snapshot.status = "faulted".to_string();
        snapshot.journal_seq = 8;
        snapshot.captured_samples = 48_000;
        snapshot.committed_samples = 48_000;
        snapshot.overflow_samples = 12;
        snapshot.noise_check = Some(NoiseCheckResult {
            passed: true,
            threshold_dbfs: -42.0,
            average_dbfs: -50.0,
            maximum_dbfs: -46.0,
            failing_windows: 0,
            samples: vec![-50.0],
            completed_at: "2026-08-10T12:00:00Z".to_string(),
            fail_reason: None,
            bandwidth_ratio_db: None,
        });
        snapshot.items[0].status = "accepted".to_string();
        snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        snapshot.items[0].attempts = vec![Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 0,
            recording_started_sample: 0,
            head_silence_armed_sample: 0,
            head_silence_passed_sample: 0,
            required_head_silence_samples: 0,
            content_started_sample: 0,
            end_sample: 48_000,
            forced_without_tail_silence: false,
            tail_silence_samples: 0,
            required_tail_silence_samples: 0,
            status: "accepted".to_string(),
            created_at: "2026-08-10T12:00:00Z".to_string(),
            quality_issues: Vec::new(),
        }];
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_snapshot_file(&root.join("metadata/items.snapshot.prev"), &snapshot);
        write_journal(&root, &[sequenced_event("attempt_accepted", &snapshot)]);
        std::fs::write(
            root.join("session.json"),
            format!(
                "{}\n",
                serde_json::to_string(&session_summary_value(&snapshot)).unwrap()
            ),
        )
        .unwrap();

        let engine = Engine::new(Emitter::new());
        let identity_error = engine
            .reset_session_expected(&root, "other-session")
            .unwrap_err();
        assert!(
            format!("{identity_error:#}").contains("其他录制")
                || format!("{identity_error:#}").contains("不一致")
                || format!("{identity_error:#}").contains("预期"),
            "{identity_error:#}"
        );
        assert!(root.join("audio/segments/master-000001.wav").is_file());

        let reset = engine.reset_session_expected(&root, "resume-test").unwrap();
        assert!(engine.session.is_none());
        assert_eq!(reset["mode"], "inspect");
        assert_eq!(reset["faulted"], false);
        assert_eq!(reset["snapshot"]["session_id"], "resume-test");
        assert_eq!(reset["snapshot"]["status"], "stopped");
        assert_eq!(reset["snapshot"]["journal_seq"], 0);
        assert_eq!(reset["snapshot"]["captured_samples"], 0);
        assert_eq!(reset["snapshot"]["committed_samples"], 0);
        assert_eq!(reset["snapshot"]["overflow_samples"], 0);
        assert!(reset["snapshot"]["noise_check"].is_null());
        assert_eq!(reset["snapshot"]["items"][0]["id"], "001");
        assert_eq!(reset["snapshot"]["items"][0]["text"], "测试文本");
        assert_eq!(reset["snapshot"]["items"][0]["status"], "pending");
        assert!(
            reset["snapshot"]["items"][0]["attempts"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(reset["snapshot"]["items"][0]["selected_attempt_id"].is_null());
        assert!(!root.join("audio/segments/master-000001.wav").exists());
        assert!(!root.join("export/full-track.wav").exists());
        assert!(!root.join("preview/001-a1.wav").exists());
        assert!(!root.join("metadata/events.jsonl").exists());
        assert!(!root.join(AUDIO_FAULT_MARKER).exists());
        assert!(!root.join("metadata/items.snapshot.prev").exists());
        assert!(root.join("audio").is_dir());
        assert!(root.join("export").is_dir());
        assert!(root.join("preview").is_dir());

        let inspected = engine
            .inspect_session_expected(&root, "resume-test")
            .unwrap();
        assert_eq!(inspected["snapshot"]["status"], "stopped");
        assert_eq!(inspected["snapshot"]["items"][0]["status"], "pending");
        assert_eq!(inspected["data_health"], "normal");
        let persisted: SessionSnapshot = serde_json::from_slice(
            &std::fs::read(root.join("metadata/items.snapshot.json")).unwrap(),
        )
        .unwrap();
        assert!(is_pristine_bootstrap(&persisted));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_render_and_explicit_selection_preserve_attempt_history() {
        let root = test_root("offline-render-select");
        for directory in ["audio", "metadata", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let master = root.join(LEGACY_MASTER_AUDIO);
        let mut writer = RecoverableWav::create(&master, 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.1, 0.2, 0.3, 0.4]).unwrap();
        writer.finalize().unwrap();
        let mut snapshot = test_snapshot();
        snapshot.status = "stopped".to_string();
        snapshot.journal_seq = 1;
        snapshot.captured_samples = 4;
        snapshot.committed_samples = 4;
        cover_committed_test_audio(&mut snapshot);
        snapshot.items[0].status = "review".to_string();
        snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        snapshot.items[0].attempts = vec![
            Attempt {
                attempt_id: "001-a1".to_string(),
                start_sample: 0,
                recording_started_sample: 0,
                head_silence_armed_sample: 0,
                head_silence_passed_sample: 0,
                required_head_silence_samples: 0,
                content_started_sample: 0,
                end_sample: 2,
                forced_without_tail_silence: false,
                tail_silence_samples: 0,
                required_tail_silence_samples: 0,
                status: "accepted".to_string(),
                created_at: "2026-08-11T00:00:00Z".to_string(),
                quality_issues: Vec::new(),
            },
            Attempt {
                attempt_id: "001-a2".to_string(),
                start_sample: 2,
                recording_started_sample: 2,
                head_silence_armed_sample: 0,
                head_silence_passed_sample: 0,
                required_head_silence_samples: 0,
                content_started_sample: 2,
                end_sample: 4,
                forced_without_tail_silence: false,
                tail_silence_samples: 0,
                required_tail_silence_samples: 0,
                status: "recorded".to_string(),
                created_at: "2026-08-11T00:01:00Z".to_string(),
                quality_issues: Vec::new(),
            },
            Attempt {
                attempt_id: "001-a3".to_string(),
                start_sample: 1,
                recording_started_sample: 1,
                head_silence_armed_sample: 0,
                head_silence_passed_sample: 0,
                required_head_silence_samples: 0,
                content_started_sample: 1,
                end_sample: 2,
                forced_without_tail_silence: false,
                tail_silence_samples: 0,
                required_tail_silence_samples: 0,
                status: "needs_rerecord".to_string(),
                created_at: "2026-08-11T00:02:00Z".to_string(),
                quality_issues: Vec::new(),
            },
        ];
        write_journal(&root, &[sequenced_event("session_stopped", &snapshot)]);
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);

        let engine = Engine::new(Emitter::new());
        let rendered = engine
            .render_session_attempt_expected(&root, "resume-test", "001", "001-a2")
            .unwrap();
        assert!(PathBuf::from(rendered["file_path"].as_str().unwrap()).is_file());
        assert!(
            engine
                .render_session_attempt_expected(&root, "resume-test", "001", "001-a3")
                .is_err()
        );
        assert!(
            engine
                .select_session_attempt_expected(&root, "resume-test", "001", "001-a3", 1)
                .is_err()
        );
        let journal_before_stale = std::fs::read(root.join("metadata/events.jsonl")).unwrap();
        let stale = engine
            .select_session_attempt_expected(&root, "resume-test", "001", "001-a2", 0)
            .unwrap_err();
        assert!(format!("{stale:#}").contains("journal_seq"));
        assert_eq!(
            std::fs::read(root.join("metadata/events.jsonl")).unwrap(),
            journal_before_stale
        );
        let selected = engine
            .select_session_attempt_expected(&root, "resume-test", "001", "001-a2", 1)
            .unwrap();
        assert_eq!(
            selected["snapshot"]["items"][0]["selected_attempt_id"],
            "001-a2"
        );
        assert_eq!(
            selected["snapshot"]["items"][0]["attempts"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(selected["snapshot"]["items"][0]["status"], "accepted");
        assert_eq!(
            selected["snapshot"]["items"][0]["attempts"][0]["status"],
            "rejected_by_operator"
        );
        assert_eq!(
            selected["snapshot"]["items"][0]["attempts"][1]["status"],
            "accepted"
        );
        assert_eq!(
            selected["snapshot"]["items"][0]["attempts"][2]["status"],
            "needs_rerecord"
        );
        let journal = read_journal(&root).unwrap();
        assert_eq!(
            journal.entries.last().unwrap()["event"],
            "attempt_selected_offline"
        );
        let journal_before_physical_failure =
            std::fs::read(root.join("metadata/events.jsonl")).unwrap();
        std::fs::write(&master, b"corrupt wav").unwrap();
        let physical_failure = engine
            .select_session_attempt_expected(&root, "resume-test", "001", "001-a1", 2)
            .unwrap_err();
        assert!(
            format!("{physical_failure:#}").contains("物理音频校验失败"),
            "{physical_failure:#}"
        );
        assert_eq!(
            std::fs::read(root.join("metadata/events.jsonl")).unwrap(),
            journal_before_physical_failure,
            "failed physical validation must not change selected state"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn preview_session_waveform_returns_bins_for_a_usable_attempt() {
        let root = test_root("preview-session-waveform");
        for directory in ["audio", "metadata", "script", "preview"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let mut writer =
            RecoverableWav::create(&root.join("audio/master.wav"), 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.1, -0.4, 0.8, -0.2]).unwrap();
        writer.finalize().unwrap();
        let mut snapshot = test_snapshot();
        snapshot.journal_seq = 1;
        snapshot.captured_samples = 4;
        snapshot.committed_samples = 4;
        cover_committed_test_audio(&mut snapshot);
        snapshot.status = "stopped".to_string();
        snapshot.items[0].status = "accepted".to_string();
        snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        snapshot.items[0].attempts = vec![Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 0,
            recording_started_sample: 0,
            head_silence_armed_sample: 0,
            head_silence_passed_sample: 0,
            required_head_silence_samples: 0,
            content_started_sample: 0,
            end_sample: 4,
            forced_without_tail_silence: false,
            tail_silence_samples: 0,
            required_tail_silence_samples: 0,
            status: "accepted".to_string(),
            created_at: "2026-08-11T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        }];
        write_journal(&root, &[sequenced_event("session_stopped", &snapshot)]);
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);

        let engine = Engine::new(Emitter::new());
        let preview = engine
            .preview_session_waveform_expected(&root, "resume-test", "001", "001-a1")
            .unwrap();
        let bins = preview["bins"].as_array().unwrap();
        assert!(!bins.is_empty());
        assert_eq!(preview["start_sample"], 0);
        assert_eq!(preview["end_sample"], 4);
        assert_eq!(preview["sample_rate"], 48_000);
        let error = engine
            .preview_session_waveform_expected(&root, "resume-test", "001", "missing")
            .unwrap_err();
        assert!(error.to_string().contains("不存在"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn artifact_exports_are_independent() {
        let root = test_root("artifact-exports-independent");
        for directory in ["audio", "metadata", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let master = root.join(LEGACY_MASTER_AUDIO);
        let mut writer = RecoverableWav::create(&master, 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.1, 0.2, 0.3, 0.4]).unwrap();
        writer.finalize().unwrap();
        let mut stopped = test_snapshot();
        stopped.journal_seq = 1;
        stopped.status = "stopped".to_string();
        stopped.captured_samples = 4;
        stopped.committed_samples = 4;
        select_safe_first_attempt(&mut stopped, 4);
        stopped.items.push(ItemState {
            id: "002".to_string(),
            text: "明确跳过".to_string(),
            label: String::new(),
            status: "skipped".to_string(),
            attempts: Vec::new(),
            selected_attempt_id: None,
        });
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &stopped);
        let engine = Engine::new(Emitter::new());

        let full_track = engine
            .export_session_artifact_expected(&root, "resume-test", ExportArtifact::FullTrack)
            .unwrap();
        assert_eq!(
            full_track["sha256"],
            sha256_file(&root.join("export/full-track.wav")).unwrap()
        );
        assert!(root.join("export/full-track.wav").is_file());
        assert!(root.join("export/status-full-track.json").is_file());
        assert!(!root.join("export/timestamps.json").exists());
        assert!(!root.join("export/cuts.zip").exists());

        let timestamps = engine
            .export_session_artifact_expected(&root, "resume-test", ExportArtifact::TimestampsJson)
            .unwrap();
        assert_eq!(
            timestamps["sha256"],
            sha256_file(&root.join("export/timestamps.json")).unwrap()
        );
        assert!(root.join("export/timestamps.json").is_file());
        assert!(root.join("export/status-timestamps-json.json").is_file());
        assert!(!root.join("export/cuts.zip").exists());

        let cuts = engine
            .export_session_artifact_with_options_expected(
                &root,
                "resume-test",
                ExportArtifact::CutsZip,
                ExportScope::ConfirmedOnly,
                Some(1),
                &[],
            )
            .unwrap();
        assert_eq!(cuts["scope"], "confirmed_only");
        assert_eq!(
            cuts["sha256"],
            sha256_file(&root.join("export/cuts.zip")).unwrap()
        );
        assert!(root.join("export/cuts-manifest.json").is_file());
        let status: Value = serde_json::from_slice(
            &std::fs::read(root.join("export/status-cuts-zip.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(status["sha256"], cuts["sha256"]);
        assert_eq!(status["export_id"], cuts["export_id"]);
        assert_eq!(status["source"], cuts["source"]);
        assert_eq!(status["manifest_file"], "cuts-manifest.json");
        assert!(
            engine
                .export_session_artifact_with_options_expected(
                    &root,
                    "resume-test",
                    ExportArtifact::CutsZip,
                    ExportScope::CompleteTask,
                    Some(1),
                    &[],
                )
                .is_err()
        );
        assert!(
            engine
                .export_session_artifact_with_options_expected(
                    &root,
                    "resume-test",
                    ExportArtifact::CutsZip,
                    ExportScope::ConfirmedOnly,
                    Some(0),
                    &[],
                )
                .is_err()
        );
        assert!(root.join("export/cuts.zip").is_file());
        assert!(root.join("export/status-cuts-zip.json").is_file());
        assert!(!root.join("export/status.json").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cut_warning_acknowledgements_are_explicit_and_bound_to_journal_sequence() {
        let root = test_root("cut-warning-acknowledgements");
        for directory in ["audio", "metadata", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let master = root.join(LEGACY_MASTER_AUDIO);
        let mut writer = RecoverableWav::create(&master, 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.1; 16]).unwrap();
        writer.finalize().unwrap();

        let mut stopped = test_snapshot();
        stopped.journal_seq = 1;
        stopped.status = "stopped".to_string();
        stopped.captured_samples = 16;
        stopped.committed_samples = 16;
        select_safe_first_attempt(&mut stopped, 16);
        let selected = &mut stopped.items[0].attempts[0];
        selected.head_silence_armed_sample = 0;
        selected.head_silence_passed_sample = 2;
        selected.required_head_silence_samples = 2;
        selected.content_started_sample = 1;
        selected.tail_silence_samples = 1;
        selected.required_tail_silence_samples = 2;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &stopped);
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);
        let engine = Engine::new(Emitter::new());

        let missing = engine
            .export_session_artifact_with_options_expected(
                &root,
                "resume-test",
                ExportArtifact::CutsZip,
                ExportScope::ConfirmedOnly,
                Some(1),
                &[],
            )
            .unwrap_err();
        let missing = format!("{missing:#}");
        assert!(missing.contains("head_silence_short"), "{missing}");
        assert!(missing.contains("tail_silence_short"), "{missing}");

        let acknowledgements = [
            "head_silence_short".to_string(),
            "tail_silence_short".to_string(),
        ];
        engine
            .export_session_artifact_with_options_expected(
                &root,
                "resume-test",
                ExportArtifact::CutsZip,
                ExportScope::ConfirmedOnly,
                Some(1),
                &acknowledgements,
            )
            .unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("export/cuts-manifest.json")).unwrap())
                .unwrap();
        assert_eq!(
            manifest["warnings"],
            json!([
                { "code": "head_silence_short", "item_id": "001" },
                { "code": "tail_silence_short", "item_id": "001" },
            ])
        );
        assert_eq!(
            manifest["acknowledged_warning_codes"],
            json!(acknowledgements)
        );

        stopped.journal_seq = 2;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &stopped);
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);
        let stale = engine
            .export_session_artifact_with_options_expected(
                &root,
                "resume-test",
                ExportArtifact::CutsZip,
                ExportScope::ConfirmedOnly,
                Some(1),
                &acknowledgements,
            )
            .unwrap_err();
        assert!(format!("{stale:#}").contains("journal_seq"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_uses_recovery_candidates_when_final_snapshot_is_corrupt() {
        let root = test_root("export-recovery-candidate");
        for directory in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        std::fs::create_dir_all(root.join("export/sentences")).unwrap();
        std::fs::write(root.join("export/sentences/stale.wav"), b"old export").unwrap();
        let master = root.join("audio/master.wav");
        let mut writer = RecoverableWav::create(&master, 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.1, 0.2, 0.3, 0.4]).unwrap();
        assert_eq!(writer.finalize().unwrap(), 4);

        let mut stopped = test_snapshot();
        stopped.journal_seq = 1;
        stopped.status = "stopped".to_string();
        stopped.captured_samples = 4;
        stopped.committed_samples = 4;
        select_safe_first_attempt(&mut stopped, 4);
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);
        std::fs::write(
            root.join("metadata/items.snapshot.json"),
            b"{\"schema_version\":1,",
        )
        .unwrap();

        let result = Engine::new(Emitter::new()).export_session(&root).unwrap();

        assert!(root.join("export/full-track.wav").is_file());
        assert_eq!(result["master_container"], "riff");
        assert!(root.join("export/timestamps.json").is_file());
        assert!(root.join("export/timestamps.csv").is_file());
        assert!(root.join("export/cuts.zip").is_file());
        let cuts = std::fs::read(root.join("export/cuts.zip")).unwrap();
        assert!(cuts.starts_with(b"PK\x03\x04"));
        assert!(
            cuts.windows("manifest.json".len())
                .any(|entry| entry == b"manifest.json")
        );
        assert!(root.join("export/metadata.csv").is_file());
        assert!(!root.join("export/sentences/stale.wav").exists());
        let status: Value =
            serde_json::from_slice(&std::fs::read(root.join("export/status.json")).unwrap())
                .unwrap();
        assert_eq!(status["status"], "complete");
        assert_eq!(status["schema_version"], 2);
        assert_eq!(status["session_id"], stopped.session_id);
        assert_eq!(status["source"]["journal_seq"], stopped.journal_seq);
        assert_eq!(
            status["source"]["committed_samples"],
            stopped.committed_samples
        );
        assert_eq!(
            status["source"]["selected_attempts"],
            json!([{ "id": "001", "attempt_id": "001-a1" }])
        );
        assert!(
            status["export_id"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
        );
        let metadata: Value =
            serde_json::from_slice(&std::fs::read(root.join("export/metadata.json")).unwrap())
                .unwrap();
        assert_eq!(metadata["full_track_container"], "riff");
        assert!(
            result["recovery_warnings"]
                .as_array()
                .is_some_and(|warnings| !warnings.is_empty())
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_rejects_a_mismatched_expected_identity_before_writing_delivery_files() {
        let root = test_root("export-identity-mismatch");
        for directory in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let master = root.join(LEGACY_MASTER_AUDIO);
        let mut writer = RecoverableWav::create(&master, 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.1, 0.2, 0.3, 0.4]).unwrap();
        writer.finalize().unwrap();

        let mut stopped = test_snapshot();
        stopped.journal_seq = 1;
        stopped.status = "stopped".to_string();
        stopped.captured_samples = 4;
        stopped.committed_samples = 4;
        let snapshot_path = root.join("metadata/items.snapshot.json");
        let journal_path = root.join("metadata/events.jsonl");
        write_snapshot_file(&snapshot_path, &stopped);
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);
        let audio_before = std::fs::read(&master).unwrap();
        let snapshot_before = std::fs::read(&snapshot_path).unwrap();
        let journal_before = std::fs::read(&journal_path).unwrap();

        let error = Engine::new(Emitter::new())
            .export_session_expected(&root, "different-recording")
            .unwrap_err();
        assert!(format!("{error:#}").contains("属于其他录制"));
        assert_eq!(std::fs::read(&master).unwrap(), audio_before);
        assert_eq!(std::fs::read(&snapshot_path).unwrap(), snapshot_before);
        assert_eq!(std::fs::read(&journal_path).unwrap(), journal_before);
        assert!(
            std::fs::read_dir(root.join("export"))
                .unwrap()
                .next()
                .is_none()
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_space_preflight_fails_before_status_or_audio_output_and_preserves_master() {
        let root = test_root("export-space-preflight");
        for directory in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let master = root.join(LEGACY_MASTER_AUDIO);
        let mut writer = RecoverableWav::create(&master, 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.1, 0.2, 0.3, 0.4]).unwrap();
        writer.finalize().unwrap();
        let master_before = std::fs::read(&master).unwrap();
        let mut stopped = test_snapshot();
        stopped.journal_seq = 1;
        stopped.status = "stopped".to_string();
        stopped.captured_samples = 4;
        stopped.committed_samples = 4;
        select_safe_first_attempt(&mut stopped, 4);
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &stopped);
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);

        let error = Engine::new(Emitter::new())
            .export_session_inner(&root, Some(0))
            .unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("导出磁盘空间不足"), "{message}");
        assert!(message.contains("required="), "{message}");
        assert!(message.contains("available=0"), "{message}");
        assert!(message.contains("reserve="), "{message}");
        assert_eq!(std::fs::read(&master).unwrap(), master_before);
        assert!(!root.join("export/status.json").exists());
        assert!(!root.join("export/full-track.wav").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_reexport_does_not_refresh_an_older_complete_marker() {
        let root = test_root("failed-reexport-preserves-old-marker");
        for directory in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let master = root.join(LEGACY_MASTER_AUDIO);
        let mut writer = RecoverableWav::create(&master, 48_000, 1, 24).unwrap();
        writer.write_samples(&[0.1, 0.2, 0.3, 0.4]).unwrap();
        writer.finalize().unwrap();
        let mut stopped = test_snapshot();
        stopped.journal_seq = 2;
        stopped.status = "stopped".to_string();
        stopped.captured_samples = 4;
        stopped.committed_samples = 4;
        select_safe_first_attempt(&mut stopped, 4);
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &stopped);
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);

        let status_path = root.join("export/status.json");
        let old_status = serde_json::to_vec_pretty(&json!({
            "schema_version": 2,
            "status": "complete",
            "export_id": "older-export",
            "session_id": stopped.session_id,
            "source": {
                "journal_seq": 1,
                "committed_samples": 2,
                "selected_attempts": [{ "id": "001", "attempt_id": null }],
            },
        }))
        .unwrap();
        std::fs::write(&status_path, &old_status).unwrap();

        let error = Engine::new(Emitter::new())
            .export_session_inner(&root, Some(0))
            .unwrap_err();
        assert!(format!("{error:#}").contains("导出磁盘空间不足"));
        assert_eq!(std::fs::read(status_path).unwrap(), old_status);
        assert!(!root.join("export/full-track.wav").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn csv_export_atomically_replaces_the_previous_generation() {
        let root = test_root("csv-atomic-replace");
        let destination = root.join("metadata.csv");
        std::fs::write(&destination, b"old generation\n").unwrap();
        let rows = json!([{
            "id": "001",
            "text": "hello, \"world\"",
            "label": "neutral",
            "attempt_id": "001-a1",
            "start_sample": 10,
            "recording_started_sample": 11,
            "head_silence_armed_sample": 11,
            "head_silence_passed_sample": 12,
            "required_head_silence_samples": 1,
            "content_started_sample": 12,
            "content_started_seconds": 0.00025,
            "end_sample": 20,
            "duration_samples": 10,
            "file": "sentences/001.wav",
            "forced_without_tail_silence": true,
            "tail_silence_samples": 120,
            "required_tail_silence_samples": 48_000,
        }]);

        write_csv(&destination, &rows).unwrap();

        let csv = std::fs::read_to_string(&destination).unwrap();
        assert!(!csv.contains("old generation"));
        assert!(csv.contains("\"hello, \"\"world\"\"\""));
        assert!(csv.lines().next().unwrap().contains(
            "head_silence_armed_sample,head_silence_passed_sample,required_head_silence_samples"
        ));
        assert!(csv.contains(",10,11,11,12,1,12,0.000250,"));
        assert!(csv.lines().next().unwrap().ends_with(
            "file,forced_without_tail_silence,tail_silence_samples,required_tail_silence_samples"
        ));
        assert!(csv.contains("\"sentences/001.wav\",true,120,48000"));
        assert!(std::fs::read_dir(&root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".metadata.csv.csv-")
        }));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn export_uses_the_segment_boundary_persisted_in_the_snapshot() {
        let root = test_root("export-persisted-segment-boundary");
        for directory in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let segment_dir = root.join(SEGMENTED_MASTER_AUDIO);
        let mut writer = SegmentedWav::create(&segment_dir, 10, 1, 16, 10).unwrap();
        writer.write_samples(&[0.125; 25]).unwrap();
        assert_eq!(writer.finalize().unwrap(), 25);

        let mut stopped = test_snapshot();
        stopped.journal_seq = 1;
        stopped.status = "stopped".to_string();
        stopped.audio_format.sample_rate = 10;
        stopped.audio_format.bit_depth = 16;
        stopped.master_audio = SEGMENTED_MASTER_AUDIO.to_string();
        // One second is deliberately different from the five-minute default.
        // Export succeeds only if recovery passes this persisted boundary to
        // SegmentedWav instead of recomputing the current default.
        stopped.segment_frames = Some(10);
        stopped.captured_samples = 25;
        stopped.committed_samples = 25;
        cover_committed_test_audio(&mut stopped);
        stopped.items[0].status = "accepted".to_string();
        stopped.items[0].selected_attempt_id = Some("001-a1".to_string());
        stopped.items[0].attempts.push(Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 2,
            recording_started_sample: 2,
            head_silence_armed_sample: 2,
            head_silence_passed_sample: 4,
            required_head_silence_samples: 2,
            content_started_sample: 5,
            end_sample: 25,
            forced_without_tail_silence: true,
            tail_silence_samples: 2,
            required_tail_silence_samples: 10,
            status: "accepted".to_string(),
            created_at: "2026-08-11T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        });
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);

        let result = Engine::new(Emitter::new()).export_session(&root).unwrap();

        assert_eq!(result["exported_count"].as_u64(), Some(1));
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(root.join("export/cuts-manifest.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["scope"], "confirmed_only");
        assert_eq!(manifest["engine_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            manifest["included"][0]["sha256"],
            sha256_file(&root.join("export/sentences/000001-001.wav")).unwrap()
        );
        assert_eq!(
            manifest["included"][0]["file"], "cuts/000001-001.wav",
            "the manifest path must name the actual ZIP entry"
        );
        assert!(root.join("export/full-track.wav").is_file());
        let cuts_archive = std::fs::read(root.join("export/cuts.zip")).unwrap();
        assert!(cuts_archive.starts_with(b"PK\x03\x04"));
        assert!(
            cuts_archive
                .windows(b"cuts/000001-001.wav".len())
                .any(|window| window == b"cuts/000001-001.wav")
        );
        assert!(
            cuts_archive
                .windows(4)
                .any(|window| window == b"PK\x05\x06")
        );
        let metadata: Value =
            serde_json::from_slice(&std::fs::read(root.join("export/metadata.json")).unwrap())
                .unwrap();
        assert_eq!(metadata["exported"][0]["forced_without_tail_silence"], true);
        assert_eq!(metadata["exported"][0]["head_silence_armed_sample"], 2);
        assert_eq!(metadata["exported"][0]["head_silence_passed_sample"], 4);
        assert_eq!(metadata["exported"][0]["required_head_silence_samples"], 2);
        assert_eq!(metadata["exported"][0]["tail_silence_samples"], 2);
        assert_eq!(metadata["exported"][0]["required_tail_silence_samples"], 10);
        let csv = std::fs::read_to_string(root.join("export/metadata.csv")).unwrap();
        assert!(csv.contains(",true,2,10\n"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cuts_zip_export_accepts_silence_enforced_clip_start() {
        let root = test_root("cuts-zip-head-silence-start");
        for directory in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let segment_dir = root.join(SEGMENTED_MASTER_AUDIO);
        let mut writer = SegmentedWav::create(&segment_dir, 10, 1, 16, 10).unwrap();
        writer.write_samples(&[0.125; 25]).unwrap();
        assert_eq!(writer.finalize().unwrap(), 25);

        let mut stopped = test_snapshot();
        stopped.journal_seq = 1;
        stopped.status = "stopped".to_string();
        stopped.audio_format.sample_rate = 10;
        stopped.audio_format.bit_depth = 16;
        stopped.master_audio = SEGMENTED_MASTER_AUDIO.to_string();
        stopped.segment_frames = Some(10);
        stopped.captured_samples = 25;
        stopped.committed_samples = 25;
        cover_committed_test_audio(&mut stopped);
        stopped.items[0].status = "accepted".to_string();
        stopped.items[0].selected_attempt_id = Some("001-a1".to_string());
        stopped.items[0].attempts.push(Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 4,
            recording_started_sample: 2,
            head_silence_armed_sample: 2,
            head_silence_passed_sample: 4,
            required_head_silence_samples: 2,
            content_started_sample: 5,
            end_sample: 25,
            forced_without_tail_silence: false,
            tail_silence_samples: 2,
            required_tail_silence_samples: 10,
            status: "accepted".to_string(),
            created_at: "2026-08-11T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        });
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);

        let result = Engine::new(Emitter::new())
            .export_session_artifact_expected(&root, "resume-test", ExportArtifact::CutsZip)
            .unwrap();
        assert_eq!(result["exported_count"].as_u64(), Some(1));
        assert!(root.join("export/cuts.zip").is_file());
        let cuts_archive = std::fs::read(root.join("export/cuts.zip")).unwrap();
        assert!(cuts_archive.starts_with(b"PK\x03\x04"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cuts_zip_export_accepts_vad_trimmed_clip_start() {
        let root = test_root("cuts-zip-vad-trim-start");
        for directory in ["audio", "script", "preview", "export"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
        }
        let segment_dir = root.join(SEGMENTED_MASTER_AUDIO);
        let mut writer = SegmentedWav::create(&segment_dir, 10, 1, 16, 10).unwrap();
        writer.write_samples(&[0.125; 25]).unwrap();
        assert_eq!(writer.finalize().unwrap(), 25);

        let mut stopped = test_snapshot();
        stopped.journal_seq = 1;
        stopped.status = "stopped".to_string();
        stopped.silence_detector = SilenceDetector::Vad;
        stopped.audio_format.sample_rate = 10;
        stopped.audio_format.bit_depth = 16;
        stopped.master_audio = SEGMENTED_MASTER_AUDIO.to_string();
        stopped.segment_frames = Some(10);
        stopped.captured_samples = 25;
        stopped.committed_samples = 25;
        cover_committed_test_audio(&mut stopped);
        stopped.items[0].status = "accepted".to_string();
        stopped.items[0].selected_attempt_id = Some("001-a1".to_string());
        stopped.items[0].attempts.push(Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 10,
            recording_started_sample: 2,
            head_silence_armed_sample: 2,
            head_silence_passed_sample: 4,
            required_head_silence_samples: 2,
            content_started_sample: 12,
            end_sample: 25,
            forced_without_tail_silence: false,
            tail_silence_samples: 2,
            required_tail_silence_samples: 2,
            status: "accepted".to_string(),
            created_at: "2026-08-20T00:00:00Z".to_string(),
            quality_issues: Vec::new(),
        });
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);

        let result = Engine::new(Emitter::new())
            .export_session_artifact_expected(&root, "resume-test", ExportArtifact::CutsZip)
            .unwrap();
        assert_eq!(result["exported_count"].as_u64(), Some(1));
        assert!(root.join("export/cuts.zip").is_file());
        let cuts_archive = std::fs::read(root.join("export/cuts.zip")).unwrap();
        assert!(cuts_archive.starts_with(b"PK\x03\x04"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_without_journal_sequence_is_backward_compatible() {
        let mut value = serde_json::to_value(test_snapshot()).unwrap();
        value.as_object_mut().unwrap().remove("journal_seq");
        let snapshot: SessionSnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(snapshot.journal_seq, 0);
    }

    #[test]
    fn wants_dev_web_capture_follows_env_only_off_windows() {
        let _guard = DEV_WEB_CAPTURE_ENV_LOCK.lock().expect("env lock");
        let previous = std::env::var_os("DATABAKER_DEV_WEB_CAPTURE");
        // Serialized by the mutex above; required by recent Rust `set_var` safety rules.
        unsafe {
            std::env::remove_var("DATABAKER_DEV_WEB_CAPTURE");
        }
        assert!(!wants_dev_web_capture());
        unsafe {
            std::env::set_var("DATABAKER_DEV_WEB_CAPTURE", "1");
        }
        assert_eq!(wants_dev_web_capture(), cfg!(not(windows)));
        unsafe {
            std::env::set_var("DATABAKER_DEV_WEB_CAPTURE", "0");
        }
        assert!(!wants_dev_web_capture());
        unsafe {
            match previous {
                Some(value) => std::env::set_var("DATABAKER_DEV_WEB_CAPTURE", value),
                None => std::env::remove_var("DATABAKER_DEV_WEB_CAPTURE"),
            }
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn dev_web_feed_publishes_pcm_without_opening_a_device() {
        let root = test_root("dev-web-feed");
        std::fs::remove_dir_all(&root).unwrap();
        let mut engine = Engine::new(Emitter::new());
        let payload = StartSessionPayload {
            session_dir: root.to_string_lossy().into_owned(),
            session_id: "mac-dev-feed".to_string(),
            script_name: "script.csv".to_string(),
            device_id: Some("coreaudio:unused-in-web-feed".to_string()),
            device_name: Some("Built-in Microphone".to_string()),
            sample_rate: 48_000,
            bit_depth: 24,
            input_sample_format: String::new(),
            input_channel: 1,
            capture_share_mode: CaptureShareMode::Shared,
            silence_duration_ms: 1_000,
            noise_threshold_dbfs: Some(-42.0),
            silence_threshold_dbfs: -42.0,
            silence_detector: SilenceDetector::Energy,
            items: vec![ScriptItem {
                id: "001".to_string(),
                text: "第一句".to_string(),
                label: String::new(),
            }],
        };
        let (session_dir, snapshot) = engine.prepare_new_session(payload, None).unwrap();
        engine
            .activate_session(
                session_dir,
                snapshot,
                false,
                "session_started",
                None,
                None,
                CaptureActivation::DevWebFeed,
            )
            .unwrap();
        let fed = engine
            .dev_feed_pcm(vec![0.4; 480])
            .expect("web-feed PCM should be accepted");
        assert_eq!(fed["captured_samples"], 480);
        let peak = f32::from_bits(
            engine
                .session
                .as_ref()
                .expect("active session")
                .peak
                .load(Ordering::Relaxed),
        );
        assert!(peak > 0.2, "peak {peak} should move after a loud block");
        engine.stop_session().unwrap();
    }

    #[test]
    fn start_session_payload_defaults_to_exclusive_capture() {
        let payload: StartSessionPayload = serde_json::from_value(json!({
            "session_dir": "/tmp/session",
            "session_id": "s1",
            "items": [{ "id": "001", "text": "hello" }]
        }))
        .unwrap();
        assert_eq!(payload.capture_share_mode, CaptureShareMode::Exclusive);
        assert_eq!(payload.input_sample_format, "");
    }

    #[test]
    fn requested_input_sample_format_wins_over_bit_depth() {
        let root = test_root("requested-input-format");
        std::fs::remove_dir_all(&root).unwrap();
        let engine = Engine::new(Emitter::new());
        let created = engine
            .create_session(StartSessionPayload {
                session_dir: root.to_string_lossy().into_owned(),
                session_id: "format-wins".to_string(),
                script_name: "script.csv".to_string(),
                device_id: Some("device:remembered".to_string()),
                device_name: Some("Remembered input".to_string()),
                sample_rate: 48_000,
                bit_depth: 16,
                input_sample_format: "I24".to_string(),
                input_channel: 1,
                capture_share_mode: CaptureShareMode::Exclusive,
                silence_duration_ms: 1_000,
                noise_threshold_dbfs: Some(-42.0),
                silence_threshold_dbfs: -42.0,
                silence_detector: SilenceDetector::Energy,
                items: vec![ScriptItem {
                    id: "001".to_string(),
                    text: "第一句".to_string(),
                    label: String::new(),
                }],
            })
            .unwrap();
        assert_eq!(created["snapshot"]["input_sample_format"], "i24");
        assert_eq!(created["snapshot"]["audio_format"]["bit_depth"], 24);
        assert_eq!(created["snapshot"]["audio_format"]["encoding"], "pcm");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn requested_input_sample_format_must_be_supported() {
        assert!(
            parse_requested_input_sample_format("i24")
                .unwrap()
                .is_some()
        );
        assert!(parse_requested_input_sample_format("").unwrap().is_none());
        assert!(parse_requested_input_sample_format("pcm24").is_err());
        assert_eq!(delivery_bit_depth_for_sample_format(SampleFormat::I32), 32);
    }

    #[test]
    fn snapshot_without_capture_share_mode_defaults_to_exclusive() {
        let mut value = serde_json::to_value(test_snapshot()).unwrap();
        value.as_object_mut().unwrap().remove("capture_share_mode");
        let snapshot: SessionSnapshot = serde_json::from_value(value).unwrap();
        assert_eq!(snapshot.capture_share_mode, CaptureShareMode::Exclusive);
    }

    #[test]
    fn attempt_without_head_or_tail_quality_fields_is_backward_compatible() {
        let attempt: Attempt = serde_json::from_value(json!({
            "attempt_id": "001-a1",
            "start_sample": 10,
            "recording_started_sample": 20,
            "content_started_sample": 25,
            "end_sample": 90,
            "status": "accepted",
            "created_at": "2026-08-11T00:00:00Z"
        }))
        .unwrap();

        assert_eq!(attempt.head_silence_armed_sample, 0);
        assert_eq!(attempt.head_silence_passed_sample, 0);
        assert_eq!(attempt.required_head_silence_samples, 0);
        assert!(!attempt.forced_without_tail_silence);
        assert_eq!(attempt.tail_silence_samples, 0);
        assert_eq!(attempt.required_tail_silence_samples, 0);
    }

    #[test]
    fn snapshot_without_storage_layout_fields_keeps_the_v1_five_minute_boundary() {
        let mut value = serde_json::to_value(test_snapshot()).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("storage_layout_version");
        object.remove("segment_frames");

        let snapshot: SessionSnapshot = serde_json::from_value(value).unwrap();

        assert_eq!(snapshot.storage_layout_version, STORAGE_LAYOUT_VERSION);
        assert_eq!(snapshot.segment_frames, None);
        assert_eq!(
            storage_layout_segment_frames(&snapshot).unwrap(),
            48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS
        );
    }

    #[test]
    fn storage_layout_rejects_unknown_zero_and_unreasonable_boundaries() {
        let mut snapshot = test_snapshot();
        snapshot.storage_layout_version = STORAGE_LAYOUT_VERSION + 1;
        assert!(storage_layout_segment_frames(&snapshot).is_err());

        snapshot.storage_layout_version = STORAGE_LAYOUT_VERSION;
        snapshot.segment_frames = Some(0);
        assert!(storage_layout_segment_frames(&snapshot).is_err());

        snapshot.segment_frames = Some(48_000 - 1);
        assert!(storage_layout_segment_frames(&snapshot).is_err());

        snapshot.segment_frames = Some(48_000 * STORAGE_LAYOUT_MAX_SEGMENT_SECONDS + 1);
        assert!(storage_layout_segment_frames(&snapshot).is_err());

        snapshot.segment_frames = Some(48_000 * 60);
        assert_eq!(
            storage_layout_segment_frames(&snapshot).unwrap(),
            48_000 * 60
        );
    }

    #[test]
    fn recovery_uses_full_journal_projection_when_final_snapshot_is_corrupt() {
        let root = test_root("recovery-corrupt-final");
        std::fs::write(
            root.join("metadata/items.snapshot.json"),
            b"{\"schema_version\":1,\"items\":[",
        )
        .unwrap();
        let mut journal_snapshot = test_snapshot();
        journal_snapshot.journal_seq = 9;
        journal_snapshot.items[0].status = "skipped".to_string();
        write_journal(&root, &[sequenced_event("item_skipped", &journal_snapshot)]);

        let mut journal = read_journal(&root).unwrap();
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();

        assert_eq!(recovered.journal_seq, 9);
        assert_eq!(recovered.items[0].status, "skipped");
        assert!(
            journal
                .warnings
                .iter()
                .any(|warning| warning.contains("损坏"))
        );
        assert!(
            journal
                .warnings
                .iter()
                .any(|warning| warning.contains("journal line"))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_does_not_warn_when_final_snapshot_matches_compacted_journal() {
        let root = test_root("recovery-current-final");
        let mut snapshot = test_snapshot();
        snapshot.journal_seq = 13;
        snapshot.status = "stopped".to_string();
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_journal(&root, &[sequenced_event("session_stopped", &snapshot)]);

        let mut journal = read_journal(&root).unwrap();
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();

        assert_eq!(recovered.journal_seq, 13);
        assert_eq!(recovered.status, "stopped");
        assert!(
            journal
                .warnings
                .iter()
                .all(|warning| !warning.contains("最终快照不可用")),
            "{:?}",
            journal.warnings
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_warns_when_final_snapshot_lags_journal() {
        let root = test_root("recovery-stale-final");
        let mut final_snapshot = test_snapshot();
        final_snapshot.journal_seq = 12;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &final_snapshot);
        let mut latest = final_snapshot.clone();
        latest.journal_seq = 13;
        latest.status = "stopped".to_string();
        write_journal(&root, &[sequenced_event("session_stopped", &latest)]);

        let mut journal = read_journal(&root).unwrap();
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();

        assert_eq!(recovered.journal_seq, 13);
        assert_eq!(recovered.status, "stopped");
        assert!(
            journal.warnings.iter().any(|warning| {
                warning.contains("最终快照不可用")
                    && warning.contains("journal line 1")
                    && warning.contains("journal_seq 13")
            }),
            "{:?}",
            journal.warnings
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_selects_highest_valid_temporary_or_backup_generation() {
        let root = test_root("recovery-generations");
        let final_path = root.join("metadata/items.snapshot.json");
        let mut final_snapshot = test_snapshot();
        final_snapshot.journal_seq = 2;
        write_snapshot_file(&final_path, &final_snapshot);

        let mut previous = final_snapshot.clone();
        previous.journal_seq = 4;
        previous.items[0].status = "review".to_string();
        write_snapshot_file(&final_path.with_extension("prev"), &previous);

        let mut temporary = previous.clone();
        temporary.journal_seq = 5;
        temporary.items[0].status = "skipped".to_string();
        write_snapshot_file(&final_path.with_extension("tmp"), &temporary);

        let mut backup = temporary.clone();
        backup.journal_seq = 6;
        backup.items[0].status = "accepted".to_string();
        write_snapshot_file(&final_path.with_extension("backup"), &backup);

        let mut journal = read_journal(&root).unwrap();
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();

        assert_eq!(recovered.journal_seq, 6);
        assert_eq!(recovered.items[0].status, "accepted");
        assert!(
            journal
                .warnings
                .iter()
                .any(|warning| warning.contains("backup snapshot"))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn atomic_snapshot_rotation_retains_previous_good_generation() {
        let root = test_root("snapshot-rotation");
        let path = root.join("metadata/items.snapshot.json");
        let mut first = test_snapshot();
        first.journal_seq = 1;
        atomic_snapshot_json(&path, &first).unwrap();
        let mut second = first.clone();
        second.journal_seq = 2;
        second.items[0].status = "skipped".to_string();
        atomic_snapshot_json(&path, &second).unwrap();

        let final_snapshot: SessionSnapshot =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let previous_snapshot: SessionSnapshot =
            serde_json::from_slice(&std::fs::read(path.with_extension("prev")).unwrap()).unwrap();
        assert_eq!(final_snapshot.journal_seq, 2);
        assert_eq!(previous_snapshot.journal_seq, 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn atomic_json_publishers_close_temporary_handles_before_replacement() {
        let root = test_root("atomic-json-handle-lifetime");
        let json_path = root.join("metadata/value.json");
        let line_path = root.join("metadata/events.jsonl");

        atomic_json(&json_path, &json!({ "generation": 1 })).unwrap();
        atomic_json(&json_path, &json!({ "generation": 2 })).unwrap();
        let value: Value = serde_json::from_slice(&std::fs::read(&json_path).unwrap()).unwrap();
        assert_eq!(value["generation"], 2);
        assert!(!json_path.with_extension("tmp").exists());

        atomic_json_line(&line_path, &json!({ "generation": 1 })).unwrap();
        atomic_json_line(&line_path, &json!({ "generation": 2 })).unwrap();
        let value: Value = serde_json::from_slice(&std::fs::read(&line_path).unwrap()).unwrap();
        assert_eq!(value["generation"], 2);
        assert!(!line_path.with_extension("compact.tmp").exists());

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_json_publishers_do_not_follow_legacy_fixed_temporary_symlinks() {
        use std::os::unix::fs::symlink;

        let root = test_root("atomic-json-temp-symlink");
        let victim = root.join("outside-victim.txt");
        std::fs::write(&victim, b"must remain unchanged").unwrap();

        let json_path = root.join("metadata/value.json");
        let legacy_json_temp = json_path.with_extension("tmp");
        symlink(&victim, &legacy_json_temp).unwrap();
        atomic_json(&json_path, &json!({ "safe": true })).unwrap();

        let line_path = root.join("metadata/events.jsonl");
        let legacy_line_temp = line_path.with_extension("compact.tmp");
        symlink(&victim, &legacy_line_temp).unwrap();
        atomic_json_line(&line_path, &json!({ "safe": true })).unwrap();

        let snapshot_path = root.join("metadata/items.snapshot.json");
        let legacy_snapshot_temp = snapshot_path.with_extension("tmp");
        symlink(&victim, &legacy_snapshot_temp).unwrap();
        atomic_snapshot_json(&snapshot_path, &test_snapshot()).unwrap();

        assert_eq!(std::fs::read(&victim).unwrap(), b"must remain unchanged");
        assert!(
            std::fs::symlink_metadata(&legacy_json_temp)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(
            std::fs::symlink_metadata(&legacy_line_temp)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert!(
            std::fs::symlink_metadata(&legacy_snapshot_temp)
                .unwrap()
                .file_type()
                .is_symlink()
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_uses_last_full_projection_for_duplicate_sequence() {
        let root = test_root("journal-duplicate-sequence");
        let mut first = test_snapshot();
        first.journal_seq = 3;
        first.items[0].status = "review".to_string();
        let mut second = first.clone();
        second.items[0].status = "skipped".to_string();
        write_journal(
            &root,
            &[
                sequenced_event("attempt_stopped", &first),
                sequenced_event("item_skipped", &second),
            ],
        );

        let mut journal = read_journal(&root).unwrap();
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();

        assert_eq!(recovered.journal_seq, 3);
        assert_eq!(recovered.items[0].status, "skipped");
        assert!(
            journal
                .warnings
                .iter()
                .any(|warning| warning.contains("重复序号 3"))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn journal_append_rolls_back_every_write_flush_and_sync_failure() {
        let root = test_root("journal-append-rollback");
        let mut first = test_snapshot();
        first.journal_seq = 1;
        write_journal(&root, &[sequenced_event("session_started", &first)]);
        let path = root.join("metadata/events.jsonl");
        let baseline = std::fs::read(&path).unwrap();
        let mut second = first.clone();
        second.journal_seq = 2;
        let event = sequenced_event("item_skipped", &second);

        for fault in [
            JournalAppendFault::DuringWrite,
            JournalAppendFault::AfterWrite,
            JournalAppendFault::AfterFlush,
            JournalAppendFault::AfterSync,
        ] {
            let failure = append_journal_event(&path, &event, fault).unwrap_err();
            assert!(failure.rollback.is_none(), "{failure:#}");
            assert_eq!(std::fs::read(&path).unwrap(), baseline, "fault={fault:?}");
        }

        append_journal_event(&path, &event, JournalAppendFault::None).unwrap();
        let journal = read_journal(&root).unwrap();
        assert_eq!(journal.entries.len(), 2);
        assert_eq!(journal.entries[1]["journal_seq"], 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn journal_append_size_guard_matches_the_recovery_limit() {
        assert_eq!(
            checked_journal_append_len(JOURNAL_MAX_BYTES - 1, 1),
            Some(JOURNAL_MAX_BYTES)
        );
        assert_eq!(checked_journal_append_len(JOURNAL_MAX_BYTES, 1), None);
        assert_eq!(checked_journal_append_len(u64::MAX, 1), None);
    }

    #[test]
    fn journal_append_refuses_to_cross_the_recovery_size_limit() {
        let root = test_root("journal-size-limit");
        let path = root.join("metadata/events.jsonl");
        let events = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        events.set_len(JOURNAL_MAX_BYTES).unwrap();
        drop(events);

        let failure = append_journal_event(
            &path,
            &sequenced_event("session_started", &test_snapshot()),
            JournalAppendFault::None,
        )
        .unwrap_err();

        assert!(failure.operation.contains("would exceed"), "{failure:#}");
        assert!(failure.rollback.is_none());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), JOURNAL_MAX_BYTES);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn journal_append_separates_a_valid_final_line_without_newline() {
        let root = test_root("journal-valid-tail-without-newline");
        let mut first = test_snapshot();
        first.journal_seq = 1;
        let first_event = sequenced_event("session_started", &first);
        let path = root.join("metadata/events.jsonl");
        std::fs::write(&path, serde_json::to_vec(&first_event).unwrap()).unwrap();
        assert_ne!(std::fs::read(&path).unwrap().last(), Some(&b'\n'));

        let mut second = first.clone();
        second.journal_seq = 2;
        append_journal_event(
            &path,
            &sequenced_event("item_skipped", &second),
            JournalAppendFault::None,
        )
        .unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.ends_with(b"\n"));
        assert!(bytes.windows(2).all(|window| window != b"}{"));
        let journal = read_journal(&root).unwrap();
        assert_eq!(journal.entries.len(), 2);
        assert_eq!(journal.entries[0]["journal_seq"], 1);
        assert_eq!(journal.entries[1]["journal_seq"], 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn any_journal_append_failure_latches_a_start_like_in_memory_mutation() {
        let root = test_root("journal-failure-latches-start");
        let mut first = test_snapshot();
        first.journal_seq = 1;
        write_journal(&root, &[sequenced_event("session_started", &first)]);
        let path = root.join("metadata/events.jsonl");
        let baseline = std::fs::read(&path).unwrap();
        let mut second = first.clone();
        second.journal_seq = 2;
        let failure = append_journal_event(
            &path,
            &sequenced_event("attempt_started", &second),
            JournalAppendFault::DuringWrite,
        )
        .unwrap_err();
        assert!(failure.rollback.is_none());
        assert_eq!(std::fs::read(&path).unwrap(), baseline);

        let mut session = metadata_test_session(&root);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 0,
            recording_started_sample: 0,
            input_discontinuity_count_at_start: 0,
        });
        session.latch_metadata_fault(&failure);

        assert!(session.active_attempt.is_some());
        assert!(session.metadata_fault.is_some());
        assert!(session.faulted.load(Ordering::Acquire));
        assert!(session.ensure_metadata_mutation_allowed().is_err());
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_journal_rollback_latches_metadata_and_blocks_mutations() {
        let root = test_root("journal-rollback-fault-latch");
        let mut first = test_snapshot();
        first.journal_seq = 1;
        write_journal(&root, &[sequenced_event("session_started", &first)]);
        let path = root.join("metadata/events.jsonl");
        let mut second = first.clone();
        second.journal_seq = 2;
        let failure = append_journal_event(
            &path,
            &sequenced_event("item_skipped", &second),
            JournalAppendFault::DuringWriteAndRollback,
        )
        .unwrap_err();
        assert!(failure.rollback.is_some());

        let mut session = metadata_test_session(&root);
        session.latch_metadata_fault(&failure);
        assert!(session.metadata_fault.is_some());
        assert!(session.faulted.load(Ordering::Acquire));
        assert!(session.ensure_metadata_mutation_allowed().is_err());
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn shutdown_reports_a_metadata_fault_instead_of_claiming_safe_sealing() {
        let root = test_root("shutdown-metadata-fault");
        let mut session = metadata_test_session(&root);
        session.metadata_fault = Some("rollback failed".to_string());
        session.faulted.store(true, Ordering::Release);
        let mut engine = Engine::new(Emitter::new());
        engine.session = Some(session);

        let error = engine.shutdown().unwrap_err();

        assert!(error.downcast_ref::<MetadataSealError>().is_some());
        assert!(format!("{error:#}").contains("元数据未能安全封存"));
        assert!(engine.session.is_none());
        let projected: SessionSnapshot = serde_json::from_slice(
            &std::fs::read(root.join("metadata/items.snapshot.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(projected.status, "faulted");
        assert!(root.join(AUDIO_FAULT_MARKER).is_file());
        // The first shutdown physically stopped and removed the session even
        // though sealing metadata failed, so stdin EOF cannot stop it twice.
        engine.shutdown().unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn blocked_vad_shutdown_cannot_starve_master_writer_finalization() {
        let root = test_root("blocked-vad-does-not-starve-writer");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let mut session = metadata_test_session(&root);
        session.captured.store(4, Ordering::Release);

        let writer_finalized = Arc::new(AtomicBool::new(false));
        let writer_finalized_thread = Arc::clone(&writer_finalized);
        let committed = Arc::clone(&session.committed);
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        session.writer_tx = writer_tx;
        session.writer_join = Some(thread::spawn(move || match writer_rx.recv().unwrap() {
            WriterMessage::Stop(reply) => {
                committed.store(4, Ordering::Release);
                writer_finalized_thread.store(true, Ordering::Release);
                reply.send(Ok(4)).unwrap();
            }
            _ => panic!("expected writer Stop before VAD shutdown"),
        }));

        let (vad_tx, vad_rx) = bounded::<VadControlMessage>(8);
        let (vad_entered_tx, vad_entered_rx) = bounded::<()>(1);
        let (vad_release_tx, vad_release_rx) = bounded::<()>(0);
        let writer_finalized_for_vad = Arc::clone(&writer_finalized);
        session.vad_tx = Some(vad_tx);
        session.vad_join = Some(thread::spawn(move || {
            let VadControlMessage::Shutdown { done } = vad_rx.recv().unwrap() else {
                panic!("expected VAD Shutdown");
            };
            assert!(
                writer_finalized_for_vad.load(Ordering::Acquire),
                "master writer must finalize before waiting on advisory VAD"
            );
            vad_entered_tx.send(()).unwrap();
            vad_release_rx.recv().unwrap();
            let _ = done.send(());
        }));

        let first = session.progress_capture_shutdown_with_timeout(Duration::from_millis(100));
        vad_entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(first.committed_samples, 4);
        assert!(writer_finalized.load(Ordering::Acquire));
        assert!(session.writer_join.is_none());
        assert!(session.vad_join.is_some());
        assert!(!session.capture_stopped);

        vad_release_tx.send(()).unwrap();
        assert!(wait_for_thread_until(
            session.vad_join.as_ref().unwrap(),
            Instant::now() + Duration::from_secs(1),
        ));
        let second = session.progress_capture_shutdown_with_timeout(Duration::from_secs(1));
        assert!(second.capture_resources_joined);
        assert!(second.audio_safe);
        assert!(session.capture_stopped);
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stop_timeout_keeps_writer_handle_and_session_lock_until_joined() {
        let root = test_root("stop-timeout-keeps-lock");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let mut session = metadata_test_session(&root);
        let (release_tx, release_rx) = bounded::<()>(0);
        session.writer_join = Some(thread::spawn(move || {
            release_rx.recv().unwrap();
        }));
        // Model a prior Stop message whose reply timed out. Retrying must only
        // observe/join that same writer; it must never infer that dropping a
        // JoinHandle means the writer stopped.
        session.stop_requested = true;
        let timeout = Duration::from_millis(100);

        assert!(session.stop_with_timeout(timeout).is_err());
        assert!(session.writer_join.is_some());
        assert!(!session.capture_stopped);
        assert!(SessionLock::acquire(&root, "2026-08-11T00:00:01Z").is_err());

        assert!(session.stop_with_timeout(timeout).is_err());
        assert!(session.writer_join.is_some());
        assert!(!session.capture_stopped);
        release_tx.send(()).unwrap();

        let stopped = session.stop_with_timeout(timeout).unwrap();
        assert_eq!(stopped["snapshot"]["status"], "stopped");
        assert!(!session.faulted.load(Ordering::Acquire));
        assert!(session.writer_join.is_none());
        assert!(session.capture_stopped);
        assert!(SessionLock::acquire(&root, "2026-08-11T00:00:02Z").is_err());

        drop(session);
        let reopened = SessionLock::acquire(&root, "2026-08-11T00:00:03Z").unwrap();
        drop(reopened);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delayed_activation_writer_retains_session_and_late_watermark_wins_on_retry() {
        let root = test_root("delayed-activation-writer-retry");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let mut session = metadata_test_session(&root);
        session.captured.store(9, Ordering::Release);
        session.committed.store(3, Ordering::Release);
        let timeout = Duration::from_millis(100);
        let committed = Arc::clone(&session.committed);
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let (stop_seen_tx, stop_seen_rx) = bounded::<()>(1);
        let writer_join = thread::spawn(move || match writer_rx.recv().unwrap() {
            WriterMessage::Stop(reply) => {
                stop_seen_tx.send(()).unwrap();
                thread::sleep(timeout + Duration::from_millis(50));
                committed.store(9, Ordering::Release);
                let _ = reply.send(Ok(9));
            }
            _ => panic!("expected Stop as the first writer command"),
        });
        session.writer_tx = writer_tx;
        session.writer_join = Some(writer_join);

        let mut engine = Engine::new(Emitter::new());
        let started = Instant::now();
        let error = engine.finish_activation_failure_with_timeout(
            session,
            "play_input_stream",
            anyhow!("injected delayed writer finalization"),
            timeout,
        );

        assert!(
            started.elapsed() < Duration::from_secs(45),
            "activation cleanup should return without waiting on the blocked writer; elapsed={:?}",
            started.elapsed(),
        );
        assert!(format!("{error:#}").contains("durably committed as stopping"));
        stop_seen_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let pending = engine
            .session
            .as_ref()
            .expect("pending session was dropped");
        assert_eq!(pending.snapshot.status, "stopping");
        assert!(!pending.capture_stopped);
        assert!(pending.writer_join.is_some());
        assert!(!pending.faulted.load(Ordering::Acquire));
        assert!(SessionLock::acquire(&root, "2026-08-11T00:00:01Z").is_err());
        let journal = read_journal(&root).unwrap();
        let event = journal.entries.last().unwrap();
        assert_eq!(event["event"], "session_activation_failed");
        assert_eq!(event["snapshot"]["status"], "stopping");
        assert_eq!(
            event["payload"]["capture_resources_joined"].as_bool(),
            Some(false)
        );

        let stopped = engine.stop_session().unwrap();
        assert_eq!(stopped["snapshot"]["status"], "stopped");
        assert_eq!(stopped["snapshot"]["committed_samples"], 9);
        assert!(engine.session.is_none());
        assert!(ensure_no_audio_fault_marker(&root, "delayed writer retry").is_ok());
        let reopened = SessionLock::acquire(&root, "2026-08-11T00:00:02Z").unwrap();
        drop(reopened);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn activation_cleanup_deadline_retains_gate_and_telemetry_for_stop_retry() {
        let root = test_root("activation-gate-telemetry-retry");
        let mut session = activation_test_session(&root, 0);
        let queue = session.writer_queue.clone();
        let callback_lease = queue.enter().unwrap();
        let (release_tx, release_rx) = bounded::<()>(0);
        session.telemetry_join = Some(thread::spawn(move || {
            release_rx.recv().unwrap();
        }));

        let mut engine = Engine::new(Emitter::new());
        let timeout = Duration::from_millis(100);
        let started = Instant::now();
        let error = engine.finish_activation_failure_with_timeout(
            session,
            "start_telemetry",
            anyhow!("injected blocked shutdown resources"),
            timeout,
        );

        assert!(
            started.elapsed() < Duration::from_secs(45),
            "activation cleanup should return without waiting on blocked gate/telemetry; elapsed={:?}",
            started.elapsed(),
        );
        assert!(format!("{error:#}").contains("cleanup reached its deadline"));
        let pending = engine
            .session
            .as_ref()
            .expect("pending session was dropped");
        assert!(pending.telemetry_join.is_some());
        assert!(pending.writer_join.is_some());
        assert!(!pending.capture_stopped);
        assert!(!pending.faulted.load(Ordering::Acquire));
        drop(callback_lease);
        release_tx.send(()).unwrap();

        let stopped = engine.stop_session().unwrap();
        assert_eq!(stopped["snapshot"]["status"], "stopped");
        assert!(engine.session.is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn activation_failure_is_joined_and_durably_stopped_before_and_after_activation_commit() {
        for activation_committed in [false, true] {
            let root = test_root(if activation_committed {
                "activation-failure-after-commit"
            } else {
                "activation-failure-before-commit"
            });
            let mut session = activation_test_session(&root, 0);
            if activation_committed {
                session
                    .persist("session_resumed", json!({ "existing_samples": 0 }))
                    .unwrap();
            }

            let mut engine = Engine::new(Emitter::new());
            let error = engine.finish_activation_failure(
                session,
                if activation_committed {
                    "play_input_stream"
                } else {
                    "build_input_stream"
                },
                anyhow!("injected device activation failure"),
            );

            assert!(format!("{error:#}").contains("may be resumed"));
            assert!(engine.session.is_none());
            assert!(ensure_no_audio_fault_marker(&root, "test resume").is_ok());

            let mut journal = read_journal(&root).unwrap();
            assert_eq!(
                journal.entries.last().unwrap()["event"].as_str(),
                Some("session_activation_failed")
            );
            assert_eq!(
                journal.entries.last().unwrap()["payload"]["reason"].as_str(),
                Some("injected device activation failure")
            );
            assert_eq!(
                journal.entries.last().unwrap()["payload"]["resumable"].as_bool(),
                Some(true)
            );
            let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();
            assert_eq!(recovered.status, "stopped");
            assert_eq!(recovered.committed_samples, 0);

            let reopened = SessionLock::acquire(&root, "2026-08-11T00:00:02Z").unwrap();
            drop(reopened);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn unsafe_activation_cleanup_is_durably_faulted_instead_of_claiming_resumable() {
        let root = test_root("unsafe-activation-failure");
        let session = activation_test_session(&root, 1);

        let mut engine = Engine::new(Emitter::new());
        let error = engine.finish_activation_failure(
            session,
            "play_input_stream",
            anyhow!("injected activation failure after overflow"),
        );

        assert!(format!("{error:#}").contains("faulted for manual recovery"));
        assert!(engine.session.is_none());
        assert!(audio_fault_marker_present(&root).unwrap());
        let mut journal = read_journal(&root).unwrap();
        let event = journal.entries.last().unwrap();
        assert_eq!(event["event"].as_str(), Some("session_activation_failed"));
        assert_eq!(event["payload"]["audio_safe"].as_bool(), Some(false));
        assert_eq!(event["payload"]["resumable"].as_bool(), Some(false));
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();
        assert_eq!(recovered.status, "faulted");
        assert_eq!(recovered.overflow_samples, 1);

        let reopened = SessionLock::acquire(&root, "2026-08-11T00:00:02Z").unwrap();
        drop(reopened);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn writer_ready_watermark_mismatch_is_never_marked_resumable() {
        let root = test_root("writer-ready-watermark-mismatch");
        let session = activation_test_session(&root, 0);
        session.faulted.store(true, Ordering::Release);

        let mut engine = Engine::new(Emitter::new());
        let error = engine.finish_activation_failure(
            session,
            "initialize_audio_writer",
            anyhow!("master audio changed during writer initialization"),
        );

        assert!(format!("{error:#}").contains("faulted for manual recovery"));
        assert!(engine.session.is_none());
        assert!(audio_fault_marker_present(&root).unwrap());
        let journal = read_journal(&root).unwrap();
        let event = journal.entries.last().unwrap();
        assert_eq!(event["snapshot"]["status"], "faulted");
        assert_eq!(event["payload"]["resumable"].as_bool(), Some(false));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn activation_failure_cleanup_joins_telemetry_and_finalizes_writer() {
        let root = test_root("activation-failure-cleanup");
        std::fs::create_dir_all(root.join("audio")).unwrap();
        let master_path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let captured = Arc::new(AtomicU64::new(1));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = bounded(1);
        let writer_captured = Arc::clone(&captured);
        let writer_committed = Arc::clone(&committed);
        let writer_overflow = Arc::clone(&overflow);
        let writer_faulted = Arc::clone(&faulted);
        let writer_path = master_path.clone();
        let writer_storage_dir = root.clone();
        let writer_join = thread::spawn(move || {
            writer_loop(
                writer_rx,
                &writer_path,
                48_000,
                24,
                false,
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_captured,
                writer_committed,
                writer_overflow,
                writer_faulted,
                Arc::new(AtomicU32::new(0)),
                Arc::new(AtomicU64::new(u64::MAX)),
                test_writer_queue(),
                disconnected_waveform_sender(),
                ready_tx,
            )
        });
        assert_eq!(ready_rx.recv().unwrap().unwrap(), 0);
        writer_tx.send(WriterMessage::Samples(vec![0.25])).unwrap();

        let telemetry_stop = Arc::new(AtomicBool::new(false));
        let telemetry_stop_thread = Arc::clone(&telemetry_stop);
        let telemetry_join = thread::spawn(move || {
            while !telemetry_stop_thread.load(Ordering::Acquire) {
                thread::yield_now();
            }
        });
        let mut session = RecordingSession {
            _session_lock: Some(SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap()),
            session_dir: root.clone(),
            snapshot: test_snapshot(),
            stream: None,
            stream_reaper: test_stream_reaper(),
            writer_tx,
            writer_queue: test_writer_queue(),
            writer_join: Some(writer_join),
            telemetry_join: Some(telemetry_join),
            capture_watchdog_join: None,
            telemetry_stop,
            capture_watchdog_armed: Arc::new(AtomicBool::new(false)),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
            captured,
            committed,
            overflow,
            capture_recovery: CaptureRecoveryTelemetry::default(),
            faulted,
            peak: Arc::new(AtomicU32::new(0)),
            rms: Arc::new(AtomicU32::new(0)),
            silence_samples: Arc::new(AtomicU64::new(0)),
            digital_silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            silence_duration_ms: Arc::new(AtomicU32::new(1_000)),
            head_silence: test_head_silence_monitor(),
            bandwidth: crate::bandwidth::BandwidthProbe::default(),
            silence_analysis: SilenceAnalysisPorts::energy(),
            vad_tx: None,
            vad_join: None,
            active_attempt: None,
            metadata_fault: Some("injected initial persist failure".to_string()),
            stop_requested: false,
            capture_stopped: false,
        };

        let cleanup = session.cleanup_after_activation_failure();

        assert!(cleanup.warnings.is_empty(), "{cleanup:?}");
        assert!(cleanup.capture_resources_joined);
        assert!(cleanup.audio_safe);
        assert_eq!(cleanup.captured_samples, 1);
        assert_eq!(cleanup.committed_samples, 1);
        assert!(session.capture_stopped);
        assert!(session.telemetry_stop.load(Ordering::Acquire));
        assert!(session.telemetry_join.is_none());
        assert!(session.writer_join.is_none());
        assert_eq!(session.committed.load(Ordering::Acquire), 1);
        let bytes = std::fs::read(&master_path).unwrap();
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 39);
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 3);
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn committed_event_succeeds_when_snapshot_projection_replace_fails() {
        let root = test_root("post-commit-projection-failure");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let final_path = root.join("metadata/items.snapshot.json");
        let mut first = test_snapshot();
        first.journal_seq = 1;
        atomic_snapshot_json(&final_path, &first).unwrap();
        write_journal(&root, &[sequenced_event("session_started", &first)]);
        // A directory at the backup target forces the post-journal snapshot
        // rotation to fail without touching the already-durable event.
        std::fs::create_dir(final_path.with_extension("prev")).unwrap();

        let mut session = metadata_test_session(&root);
        session.snapshot = first;
        session.snapshot.items[0].status = "skipped".to_string();
        session
            .persist("item_skipped", json!({ "item_id": "001" }))
            .unwrap();

        assert_eq!(session.snapshot.journal_seq, 2);
        assert_eq!(session.snapshot.items[0].status, "skipped");
        assert!(session.metadata_fault.is_none());
        let mut journal = read_journal(&root).unwrap();
        assert_eq!(journal.entries.len(), 2);
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();
        assert_eq!(recovered.journal_seq, 2);
        assert_eq!(recovered.items[0].status, "skipped");
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_session_identity_file_does_not_hide_a_valid_snapshot() {
        let root = test_root("invalid-session-identity");
        let snapshot = test_snapshot();
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        std::fs::create_dir(root.join("session.json")).unwrap();

        let mut journal = read_journal(&root).unwrap();
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();

        assert_eq!(recovered.session_id, snapshot.session_id);
        assert!(
            journal
                .warnings
                .iter()
                .any(|warning| warning.contains("不是普通文件"))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_accepts_a_compacted_journal_base_sequence() {
        let root = test_root("journal-compacted-base");
        let mut snapshot = test_snapshot();
        snapshot.journal_seq = 40;
        let mut latest = snapshot.clone();
        latest.journal_seq = 41;
        latest.items[0].status = "skipped".to_string();
        write_journal(&root, &[sequenced_event("item_skipped", &latest)]);

        let journal = read_journal(&root).unwrap();
        replay_snapshot_from_journal(&mut snapshot, &journal).unwrap();
        assert_eq!(snapshot.journal_seq, 41);
        assert_eq!(snapshot.items[0].status, "skipped");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn journal_compaction_keeps_one_self_contained_event() {
        let root = test_root("journal-compaction");
        let mut first = test_snapshot();
        first.journal_seq = 7;
        let mut latest = first.clone();
        latest.journal_seq = 8;
        latest.items[0].status = "accepted".to_string();
        write_journal(
            &root,
            &[
                sequenced_event("attempt_stopped", &first),
                sequenced_event("attempt_accepted", &latest),
            ],
        );
        atomic_json_line(
            &root.join("metadata/events.jsonl"),
            &sequenced_event("attempt_accepted", &latest),
        )
        .unwrap();

        let journal = read_journal(&root).unwrap();
        assert_eq!(journal.entries.len(), 1);
        assert_eq!(journal.entries[0]["journal_seq"], 8);
        let source = std::fs::read_to_string(root.join("metadata/events.jsonl")).unwrap();
        assert_eq!(source.lines().count(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn open_attempt_survives_a_later_stopping_checkpoint_until_it_is_closed() {
        let root = test_root("open-attempt-journal-retention");
        std::fs::create_dir_all(root.join("script")).unwrap();
        let mut session = prepare_metadata_test_session(&root);
        session.captured.store(120, Ordering::Release);
        session.committed.store(120, Ordering::Release);
        session.active_attempt = Some(ActiveAttempt {
            item_id: "001".to_string(),
            attempt_id: "001-a1".to_string(),
            start_sample: 10,
            recording_started_sample: 20,
            input_discontinuity_count_at_start: 0,
        });
        session
            .persist(
                "attempt_started",
                json!({
                    "item_id": "001",
                    "attempt_id": "001-a1",
                    "start_sample": 10,
                    "recording_started_sample": 20,
                    "head_silence_armed_sample": 20,
                    "required_head_silence_samples": 48,
                }),
            )
            .unwrap();
        session.snapshot.status = "stopping".to_string();
        session
            .persist("session_stopping", json!({ "reason": "stop_timeout" }))
            .unwrap();

        let journal = read_journal(&root).unwrap();
        assert_eq!(journal.entries.len(), 3);
        assert!(journal.entries.iter().any(|entry| {
            entry["event"] == "attempt_started" && entry["payload"]["attempt_id"] == "001-a1"
        }));
        let mut recovered = session.snapshot.clone();
        let warnings = recover_interrupted_attempts(&journal, &mut recovered, 120).unwrap();
        assert_eq!(recovered.items[0].attempts.len(), 1);
        assert_eq!(recovered.items[0].attempts[0].attempt_id, "001-a1");
        assert_eq!(recovered.items[0].attempts[0].status, "interrupted");
        assert!(!warnings.is_empty());

        session.active_attempt = None;
        session.snapshot.status = "stopped".to_string();
        session.persist("session_stopped", json!({})).unwrap();
        let compacted = read_journal(&root).unwrap();
        assert_eq!(compacted.entries.len(), 1);
        assert_eq!(compacted.entries[0]["event"], "session_stopped");
        drop(session);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_ignores_a_partial_event_before_snapshot_commit() {
        let root = test_root("journal-partial-tail");
        let mut bytes = b"{\"event\":\"attempt_started\",\"payload\":{\"text\":\"".to_vec();
        bytes.extend_from_slice(&[0xe4, 0xb8]);
        std::fs::write(root.join("metadata/events.jsonl"), bytes).unwrap();

        let journal = read_journal(&root).unwrap();
        let mut snapshot = test_snapshot();
        replay_snapshot_from_journal(&mut snapshot, &journal).unwrap();

        assert!(journal.entries.is_empty());
        assert_eq!(journal.warnings.len(), 1);
        assert_eq!(snapshot.journal_seq, 0);
        assert_eq!(snapshot.items[0].status, "pending");

        repair_journal_tail(&root, &journal).unwrap();
        assert_eq!(
            std::fs::metadata(root.join("metadata/events.jsonl"))
                .unwrap()
                .len(),
            0
        );
        let mut continued = test_snapshot();
        continued.journal_seq = 1;
        continued.items[0].status = "skipped".to_string();
        write_journal(&root, &[sequenced_event("item_skipped", &continued)]);
        let repaired = read_journal(&root).unwrap();
        replay_snapshot_from_journal(&mut snapshot, &repaired).unwrap();
        assert_eq!(snapshot.journal_seq, 1);
        assert_eq!(snapshot.items[0].status, "skipped");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_replays_a_durable_event_when_snapshot_lags() {
        let root = test_root("journal-event-ahead");
        let mut durable = test_snapshot();
        durable.journal_seq = 1;
        durable.items[0].status = "skipped".to_string();
        write_journal(&root, &[sequenced_event("item_skipped", &durable)]);
        atomic_json(&root.join("metadata/items.snapshot.json"), &test_snapshot()).unwrap();

        let mut loaded: SessionSnapshot = serde_json::from_slice(
            &std::fs::read(root.join("metadata/items.snapshot.json")).unwrap(),
        )
        .unwrap();
        let journal = read_journal(&root).unwrap();
        replay_snapshot_from_journal(&mut loaded, &journal).unwrap();

        assert_eq!(loaded.journal_seq, 1);
        assert_eq!(loaded.items[0].status, "skipped");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_after_snapshot_commit_is_idempotent() {
        let root = test_root("journal-snapshot-current");
        let mut first = test_snapshot();
        first.journal_seq = 1;
        first.items[0].status = "review".to_string();
        let mut second = first.clone();
        second.journal_seq = 2;
        second.items[0].status = "skipped".to_string();
        write_journal(
            &root,
            &[
                sequenced_event("attempt_stopped", &first),
                sequenced_event("item_skipped", &second),
            ],
        );
        atomic_json(&root.join("metadata/items.snapshot.json"), &second).unwrap();
        let journal = read_journal(&root).unwrap();
        let mut loaded: SessionSnapshot = serde_json::from_slice(
            &std::fs::read(root.join("metadata/items.snapshot.json")).unwrap(),
        )
        .unwrap();

        replay_snapshot_from_journal(&mut loaded, &journal).unwrap();
        let once = serde_json::to_value(&loaded).unwrap();
        replay_snapshot_from_journal(&mut loaded, &journal).unwrap();

        assert_eq!(serde_json::to_value(&loaded).unwrap(), once);
        assert_eq!(loaded.journal_seq, 2);
        assert_eq!(loaded.items[0].status, "skipped");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_warns_and_uses_a_later_full_projection_after_middle_damage() {
        let root = test_root("journal-middle-damage");
        let mut first = test_snapshot();
        first.journal_seq = 1;
        first.items[0].status = "review".to_string();
        let mut second = first.clone();
        second.journal_seq = 2;
        second.items[0].status = "skipped".to_string();
        let first = serde_json::to_string(&sequenced_event("attempt_stopped", &first)).unwrap();
        let second = serde_json::to_string(&sequenced_event("item_skipped", &second)).unwrap();
        std::fs::write(
            root.join("metadata/events.jsonl"),
            format!("{first}\n{{broken\n{second}\n"),
        )
        .unwrap();

        let mut journal = read_journal(&root).unwrap();
        assert_eq!(journal.entries.len(), 2);
        assert!(
            journal
                .warnings
                .iter()
                .any(|warning| warning.contains("第 2 行损坏"))
        );
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();
        assert_eq!(recovered.journal_seq, 2);
        assert_eq!(recovered.items[0].status, "skipped");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovery_marks_an_unmatched_attempt_as_interrupted_once() {
        let root = test_root("interrupted-attempt");
        let event = json!({
            "event": "attempt_started",
            "at": "2026-08-10T12:00:00Z",
            "payload": {
                "item_id": "001",
                "attempt_id": "001-a1",
                "start_sample": 100,
                "recording_started_sample": 110,
                "head_silence_armed_sample": 110,
                // Compatibility with the short-lived pre-release telemetry
                // spelling used before the Attempt/export schema was unified.
                "head_silence_required_samples": 10,
            }
        });
        std::fs::write(
            root.join("metadata/events.jsonl"),
            format!("{}\n", serde_json::to_string(&event).unwrap()),
        )
        .unwrap();
        let mut snapshot = test_snapshot();

        let journal = read_journal(&root).unwrap();
        let warnings = recover_interrupted_attempts(&journal, &mut snapshot, 120).unwrap();
        assert_eq!(warnings.len(), 1);
        assert_eq!(snapshot.items[0].attempts.len(), 1);
        assert_eq!(snapshot.items[0].attempts[0].status, "interrupted");
        assert_eq!(snapshot.items[0].attempts[0].start_sample, 110);
        assert_eq!(snapshot.items[0].attempts[0].head_silence_armed_sample, 110);
        assert_eq!(
            snapshot.items[0].attempts[0].required_head_silence_samples,
            10
        );
        assert_eq!(snapshot.items[0].attempts[0].head_silence_passed_sample, 0);
        assert_eq!(snapshot.items[0].attempts[0].end_sample, 120);

        let warnings = recover_interrupted_attempts(&journal, &mut snapshot, 120).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(snapshot.items[0].attempts.len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_rejects_a_mismatched_expected_identity_before_mutating_audio_or_metadata() {
        let (root, snapshot, _) = offline_seal_fixture("offline-seal-identity-mismatch");
        let master = root.join(LEGACY_MASTER_AUDIO);
        let audio_before = std::fs::read(&master).unwrap();
        let snapshot_path = root.join("metadata/items.snapshot.json");
        let snapshot_before = std::fs::read(&snapshot_path).unwrap();
        let journal_path = root.join("metadata/events.jsonl");
        let journal_before = std::fs::read(&journal_path).unwrap();

        let engine = Engine::new(Emitter::new());
        let error = engine
            .seal_interrupted_session_expected(&root, "different-recording")
            .unwrap_err();
        assert!(format!("{error:#}").contains("属于其他录制"));
        assert_eq!(std::fs::read(&master).unwrap(), audio_before);
        assert_eq!(std::fs::read(&snapshot_path).unwrap(), snapshot_before);
        assert_eq!(std::fs::read(&journal_path).unwrap(), journal_before);
        assert_eq!(snapshot.status, "recording");

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_repairs_wav_recovers_attempt_and_is_metadata_idempotent() {
        let (root, _original, complete_wav) = offline_seal_fixture("offline-seal");
        let master = root.join(LEGACY_MASTER_AUDIO);
        assert_eq!(
            std::fs::metadata(&master).unwrap().len(),
            complete_wav.len() as u64 + 2
        );

        let engine = Engine::new(Emitter::new());
        let result = engine.seal_interrupted_session(&root).unwrap();
        assert_eq!(result["no_op"].as_bool(), Some(false));
        assert_eq!(result["durable_frames"].as_u64(), Some(3));
        assert_eq!(result["recovered_attempts"].as_u64(), Some(1));
        let sealed: SessionSnapshot = serde_json::from_value(result["snapshot"].clone()).unwrap();
        assert_eq!(sealed.status, "stopped");
        assert_eq!(sealed.captured_samples, 3);
        assert_eq!(sealed.committed_samples, 3);
        assert_eq!(sealed.journal_seq, 2);
        assert_eq!(sealed.items[0].attempts.len(), 1);
        let attempt = &sealed.items[0].attempts[0];
        assert_eq!(attempt.status, "interrupted");
        assert_eq!(attempt.start_sample, 2);
        assert_eq!(attempt.recording_started_sample, 2);
        assert_eq!(attempt.head_silence_armed_sample, 2);
        assert_eq!(attempt.head_silence_passed_sample, 0);
        assert_eq!(attempt.required_head_silence_samples, 48_000);
        assert_eq!(attempt.end_sample, 3);

        let repaired = std::fs::read(&master).unwrap();
        assert_eq!(repaired, complete_wav, "offline seal must not append PCM");
        assert_eq!(u32::from_le_bytes(repaired[4..8].try_into().unwrap()), 45);
        assert_eq!(u32::from_le_bytes(repaired[40..44].try_into().unwrap()), 9);
        let journal = read_journal(&root).unwrap();
        assert_eq!(journal.entries.len(), 1);
        assert_eq!(
            journal.entries[0]["event"].as_str(),
            Some("session_interrupted_sealed")
        );
        assert_eq!(journal.entries[0]["journal_seq"].as_u64(), Some(2));
        let summary: Value =
            serde_json::from_slice(&std::fs::read(root.join("session.json")).unwrap()).unwrap();
        assert_eq!(summary["status"].as_str(), Some("stopped"));
        assert_eq!(summary["journal_seq"].as_u64(), Some(2));
        let normalized: Vec<ItemState> =
            serde_json::from_slice(&std::fs::read(root.join("script/normalized.json")).unwrap())
                .unwrap();
        assert_eq!(normalized[0].attempts[0].status, "interrupted");

        let journal_before_retry = std::fs::read(root.join("metadata/events.jsonl")).unwrap();
        let retry = engine.seal_interrupted_session(&root).unwrap();
        assert_eq!(retry["no_op"].as_bool(), Some(true));
        assert_eq!(retry["durable_frames"].as_u64(), Some(3));
        assert_eq!(
            std::fs::read(root.join("metadata/events.jsonl")).unwrap(),
            journal_before_retry
        );
        assert_eq!(std::fs::read(&master).unwrap(), complete_wav);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_repairs_the_active_segment_without_creating_audio() {
        let root = test_root("offline-seal-segmented");
        for name in ["audio", "script"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        let segments = root.join(SEGMENTED_MASTER_AUDIO);
        let segment_frames = 48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS;
        let mut writer = SegmentedWav::create(&segments, 48_000, 1, 24, segment_frames).unwrap();
        writer.write_samples(&[0.125, -0.25, 0.5]).unwrap();
        assert_eq!(writer.finalize().unwrap(), 3);
        let active = segments.join("master-000001.wav");
        let complete_segment = std::fs::read(&active).unwrap();
        let mut file = OpenOptions::new().write(true).open(&active).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();
        file.write_all(b"FAIL").unwrap();
        file.sync_all().unwrap();
        drop(file);

        let mut snapshot = test_snapshot();
        snapshot.journal_seq = 1;
        snapshot.master_audio = SEGMENTED_MASTER_AUDIO.to_string();
        snapshot.segment_frames = Some(segment_frames);
        snapshot.captured_samples = 2;
        snapshot.committed_samples = 2;
        write_open_attempt_metadata(&root, &snapshot);
        let entries_before = std::fs::read_dir(&segments).unwrap().count();

        let result = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap();
        assert_eq!(result["durable_frames"].as_u64(), Some(3));
        assert_eq!(result["recovered_attempts"].as_u64(), Some(1));
        assert!(
            result["warnings"]
                .as_array()
                .is_some_and(|warnings| warnings.iter().any(|warning| warning
                    .as_str()
                    .is_some_and(|warning| warning.contains("WAV 头"))))
        );
        assert_eq!(std::fs::read(&active).unwrap(), complete_segment);
        assert_eq!(
            std::fs::read_dir(&segments).unwrap().count(),
            entries_before
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_preserves_existing_audio_fault_and_overflow() {
        let (root, mut snapshot, _) = offline_seal_fixture("offline-seal-fault");
        snapshot.status = "faulted".to_string();
        snapshot.overflow_samples = 7;
        write_open_attempt_metadata(&root, &snapshot);
        let marker = root.join(AUDIO_FAULT_MARKER);
        atomic_json(
            &marker,
            &json!({
                "reason": "preexisting device xrun",
                "committed_frames": 2,
                "timestamp": "2026-08-10T12:00:00Z",
            }),
        )
        .unwrap();
        let marker_before = std::fs::read(&marker).unwrap();

        let result = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap();
        let sealed: SessionSnapshot = serde_json::from_value(result["snapshot"].clone()).unwrap();
        assert_eq!(sealed.status, "faulted");
        assert_eq!(sealed.overflow_samples, 7);
        assert_eq!(result["fault_preserved"].as_bool(), Some(true));
        assert_eq!(std::fs::read(marker).unwrap(), marker_before);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_never_reports_stopped_snapshot_as_clean_when_marker_exists() {
        let (root, mut snapshot, _) = offline_seal_fixture("offline-seal-stopped-marker");
        snapshot.status = "stopped".to_string();
        snapshot.captured_samples = 3;
        snapshot.committed_samples = 3;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_journal(&root, &[sequenced_event("session_stopped", &snapshot)]);
        let marker = root.join(AUDIO_FAULT_MARKER);
        atomic_json(
            &marker,
            &json!({
                "reason": "preexisting xrun",
                "committed_frames": 3,
                "timestamp": "2026-08-10T12:00:00Z",
            }),
        )
        .unwrap();
        let marker_before = std::fs::read(&marker).unwrap();

        let result = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap();
        assert_eq!(result["no_op"].as_bool(), Some(false));
        assert_eq!(result["fault_preserved"].as_bool(), Some(true));
        let sealed: SessionSnapshot = serde_json::from_value(result["snapshot"].clone()).unwrap();
        assert_eq!(sealed.status, "faulted");
        assert_eq!(std::fs::read(marker).unwrap(), marker_before);

        let retry = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap();
        assert_eq!(retry["no_op"].as_bool(), Some(true));
        assert_eq!(retry["snapshot"]["status"].as_str(), Some("faulted"));
        assert_eq!(retry["fault_preserved"].as_bool(), Some(true));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_never_reports_stopped_snapshot_as_clean_when_overflow_exists() {
        let (root, mut snapshot, _) = offline_seal_fixture("offline-seal-stopped-overflow");
        snapshot.status = "stopped".to_string();
        snapshot.captured_samples = 3;
        snapshot.committed_samples = 3;
        snapshot.overflow_samples = 9;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_journal(&root, &[sequenced_event("session_stopped", &snapshot)]);

        let result = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap();
        assert_eq!(result["no_op"].as_bool(), Some(false));
        assert_eq!(result["fault_preserved"].as_bool(), Some(true));
        let sealed: SessionSnapshot = serde_json::from_value(result["snapshot"].clone()).unwrap();
        assert_eq!(sealed.status, "faulted");
        assert_eq!(sealed.overflow_samples, 9);

        let retry = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap();
        assert_eq!(retry["no_op"].as_bool(), Some(true));
        assert_eq!(retry["snapshot"]["status"].as_str(), Some("faulted"));
        assert_eq!(retry["snapshot"]["overflow_samples"].as_u64(), Some(9));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_rewrites_a_torn_journal_instead_of_no_oping() {
        let (root, mut snapshot, complete_wav) = offline_seal_fixture("offline-seal-torn-journal");
        snapshot.status = "stopped".to_string();
        snapshot.captured_samples = 3;
        snapshot.committed_samples = 3;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_journal(&root, &[sequenced_event("session_stopped", &snapshot)]);
        let journal_path = root.join("metadata/events.jsonl");
        let mut journal_file = OpenOptions::new().append(true).open(&journal_path).unwrap();
        journal_file.write_all(b"{\"event\":\"torn").unwrap();
        journal_file.sync_all().unwrap();
        drop(journal_file);

        let result = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap();
        assert_eq!(result["no_op"].as_bool(), Some(false));
        assert!(
            result["warnings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|warning| {
                    warning
                        .as_str()
                        .is_some_and(|warning| warning.contains("最后一行不完整"))
                })
        );
        let repaired_journal = read_journal(&root).unwrap();
        assert!(repaired_journal.warnings.is_empty());
        assert_eq!(repaired_journal.entries.len(), 1);
        assert_eq!(
            repaired_journal.entries[0]["event"].as_str(),
            Some("session_interrupted_sealed")
        );
        assert_eq!(
            std::fs::read(root.join(LEGACY_MASTER_AUDIO)).unwrap(),
            complete_wav
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_journal_failure_fault_marks_without_advancing_projection() {
        let (root, original, complete_wav) = offline_seal_fixture("offline-seal-journal-fault");
        let journal_path = root.join("metadata/events.jsonl");
        let journal_before = std::fs::read(&journal_path).unwrap();
        let error = Engine::new(Emitter::new())
            .seal_interrupted_session_inner(&root, JournalAppendFault::DuringWrite)
            .unwrap_err();
        assert!(format!("{error:#}").contains("已写入故障标记"), "{error:#}");
        assert_eq!(std::fs::read(&journal_path).unwrap(), journal_before);
        let projected: SessionSnapshot = serde_json::from_slice(
            &std::fs::read(root.join("metadata/items.snapshot.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(projected.journal_seq, original.journal_seq);
        assert_eq!(projected.status, "recording");
        assert!(root.join(AUDIO_FAULT_MARKER).is_file());
        assert_eq!(
            std::fs::read(root.join(LEGACY_MASTER_AUDIO)).unwrap(),
            complete_wav
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_honors_the_session_lock() {
        let (root, _, _) = offline_seal_fixture("offline-seal-lock");
        let lock = SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap();
        let error = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("lock"),
            "unexpected lock failure: {error:#}"
        );
        drop(lock);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_projection_failure_is_only_a_warning_after_journal_commit() {
        let (root, _, _) = offline_seal_fixture("offline-seal-projection-warning");
        std::fs::create_dir(root.join("metadata/items.snapshot.prev")).unwrap();

        let result = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap();
        assert_eq!(result["no_op"].as_bool(), Some(false));
        let warnings = result["warnings"].as_array().unwrap();
        assert!(warnings.iter().any(|warning| {
            warning
                .as_str()
                .is_some_and(|warning| warning.contains("update items snapshot"))
        }));
        let mut journal = read_journal(&root).unwrap();
        let recovered = load_recovery_snapshot(&root, &mut journal).unwrap();
        assert_eq!(recovered.journal_seq, 2);
        assert_eq!(recovered.status, "stopped");
        assert_eq!(recovered.committed_samples, 3);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn offline_seal_does_not_trust_stopped_snapshot_with_wrong_audio_watermark() {
        let (root, mut snapshot, complete_wav) =
            offline_seal_fixture("offline-seal-stopped-mismatch");
        snapshot.status = "stopped".to_string();
        snapshot.captured_samples = 4;
        snapshot.committed_samples = 4;
        write_snapshot_file(&root.join("metadata/items.snapshot.json"), &snapshot);
        write_journal(&root, &[sequenced_event("session_stopped", &snapshot)]);

        let result = Engine::new(Emitter::new())
            .seal_interrupted_session(&root)
            .unwrap();
        assert_eq!(result["no_op"].as_bool(), Some(false));
        assert_eq!(result["durable_frames"].as_u64(), Some(3));
        let sealed: SessionSnapshot = serde_json::from_value(result["snapshot"].clone()).unwrap();
        assert_eq!(sealed.status, "faulted");
        assert_eq!(sealed.captured_samples, 3);
        assert_eq!(sealed.committed_samples, 3);
        assert!(root.join(AUDIO_FAULT_MARKER).is_file());
        assert_eq!(
            std::fs::read(root.join(LEGACY_MASTER_AUDIO)).unwrap(),
            complete_wav
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
