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
use crate::wav::{
    RecoverableWav, WavEncoding, automatic_wav_container_name, automatic_wav_file_size,
    slice_wav_mono, standard_wav_file_size, validate_standard_wav_size,
};
use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    Device, I24, SampleFormat, SizedSample, Stream, StreamConfig, SupportedStreamConfig, U24,
};
use crossbeam_channel::{Receiver, Sender, bounded, unbounded};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
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
const CAPTURE_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
// A healthy real-time input stream produces non-empty buffers far more often
// than this, even with unusually large USB-interface buffers. Some Windows
// drivers can nevertheless leave the stream/process alive after unplug or an
// internal endpoint failure without invoking CPAL's error callback. Fail closed
// before such a silent stall can be mistaken for valid room silence.
const CAPTURE_CALLBACK_STALL_TIMEOUT: Duration = Duration::from_secs(5);
// Electron gives normal engine commands 20 seconds. Return control to the
// protocol loop before that deadline so a slow preview worker can never block
// a subsequent safe-stop request until the 90-second process kill budget.
const PREVIEW_RENDER_TIMEOUT: Duration = Duration::from_secs(15);
const AUDIO_FAULT_MARKER: &str = "metadata/audio-fault.json";
const EXPORT_METADATA_BASE_HEADROOM_BYTES: u64 = 4 * 1024 * 1024;
const EXPORT_FILE_ALLOCATION_HEADROOM_BYTES: u64 = 64 * 1024;
static TEMP_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
    #[serde(default)]
    pub content_started_sample: u64,
    pub end_sample: u64,
    pub status: String,
    pub created_at: String,
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
    pub started_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub noise_check: Option<NoiseCheckResult>,
    #[serde(default = "default_silence_duration_ms")]
    pub silence_duration_ms: u32,
    #[serde(default = "default_noise_threshold_dbfs")]
    pub silence_threshold_dbfs: f32,
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
    #[serde(default = "default_input_channel")]
    pub input_channel: u16,
    #[serde(default = "default_silence_duration_ms")]
    pub silence_duration_ms: u32,
    #[serde(default = "default_noise_threshold_dbfs")]
    pub silence_threshold_dbfs: f32,
    pub items: Vec<ScriptItem>,
}

#[derive(Debug, Deserialize)]
pub struct ResumeSessionPayload {
    pub session_dir: String,
}

#[derive(Debug, Deserialize)]
pub struct NoiseCheckPayload {
    #[serde(default = "default_noise_threshold_dbfs")]
    pub threshold_dbfs: f32,
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

#[derive(Debug, Clone)]
struct ActiveAttempt {
    item_id: String,
    attempt_id: String,
    start_sample: u64,
    recording_started_sample: u64,
}

#[derive(Clone)]
struct SilenceMonitor {
    silence_samples: Arc<AtomicU64>,
    last_signal_sample: Arc<AtomicU64>,
    attempt_signal_start_sample: Arc<AtomicU64>,
    threshold_bits: Arc<AtomicU32>,
    capture_heartbeat: Arc<AtomicU64>,
}

#[derive(Clone)]
struct WriterQueueBudget {
    queued_frames: Arc<AtomicU64>,
    enqueue_state: Arc<AtomicU64>,
    max_frames: u64,
}

struct WriterQueueLease<'a> {
    enqueue_state: &'a AtomicU64,
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
    persist_audio_fault_marker(session_dir, reason, committed.load(Ordering::Acquire));
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
struct CaptureBlockError {
    reason: String,
    dropped_frames: u64,
}

fn saturating_atomic_add(counter: &AtomicU64, value: u64) {
    let _ = counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
        Some(current.saturating_add(value))
    });
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
                    bail!("旧版母轨试听快照超过 256 MiB，请先安全结束录制后再导出");
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
    _session_lock: SessionLock,
    session_dir: PathBuf,
    snapshot: SessionSnapshot,
    stream: Option<Stream>,
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
    faulted: Arc<AtomicBool>,
    peak: Arc<AtomicU32>,
    rms: Arc<AtomicU32>,
    silence_samples: Arc<AtomicU64>,
    attempt_signal_start_sample: Arc<AtomicU64>,
    silence_threshold_bits: Arc<AtomicU32>,
    active_attempt: Option<ActiveAttempt>,
    metadata_fault: Option<String>,
    /// A stop command has already been placed behind every callback that
    /// entered the enqueue gate. Retries wait for the same writer instead of
    /// sending a second Stop message or detaching its JoinHandle.
    stop_requested: bool,
    capture_stopped: bool,
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
        let default_name = default_device.as_ref().map(ToString::to_string);
        let default_device_id = default_device
            .as_ref()
            .and_then(|device| device.id().ok())
            .map(|id| id.to_string());
        let mut devices = Vec::new();
        for device in host.input_devices().context("enumerate input devices")? {
            let name = device.to_string();
            let id = match device.id() {
                Ok(id) => id.to_string(),
                Err(error) => {
                    eprintln!("skip input device without stable id {name}: {error}");
                    continue;
                }
            };
            let mut rates = Vec::<u32>::new();
            let mut input_channels = Vec::<u16>::new();
            let mut configurations = Vec::<Value>::new();
            if let Ok(configs) = device.supported_input_configs() {
                for config in configs {
                    if !is_supported_input_format(config.sample_format()) {
                        continue;
                    }
                    input_channels.push(config.channels());
                    rates.push(config.min_sample_rate());
                    rates.push(config.max_sample_rate());
                    configurations.push(json!({
                        "min_sample_rate": config.min_sample_rate(),
                        "max_sample_rate": config.max_sample_rate(),
                        "channels": config.channels(),
                        "sample_format": config.sample_format().to_string(),
                    }));
                }
            }
            rates.sort_unstable();
            rates.dedup();
            input_channels.sort_unstable();
            input_channels.dedup();
            if configurations.is_empty() {
                continue;
            }
            let is_default = default_device_id.as_deref() == Some(id.as_str());
            devices.push(json!({
                "id": id,
                "name": name,
                "is_default": is_default,
                "sample_rates": rates,
                "input_channels": input_channels,
                "configurations": configurations,
            }));
        }
        Ok(json!({
            "devices": devices,
            "default_device_id": default_device_id,
            "default_device_name": default_name,
        }))
    }

    pub fn start_session(&mut self, payload: StartSessionPayload) -> Result<Value> {
        if self.session.is_some() {
            bail!("当前已有录制进行中");
        }
        if payload.items.is_empty() {
            bail!("script contains no items");
        }
        let output_encoding = WavEncoding::for_bit_depth(payload.bit_depth)?;
        let segment_frames = storage_layout_v1_default_segment_frames(payload.sample_rate)?;
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
            input_sample_format: String::new(),
            capture_provenance: Vec::new(),
            audio_format: AudioFormat {
                sample_rate: payload.sample_rate,
                bit_depth: payload.bit_depth,
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
            started_at: now.clone(),
            updated_at: now,
            noise_check: None,
            silence_duration_ms: payload.silence_duration_ms,
            silence_threshold_dbfs: payload.silence_threshold_dbfs,
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
        self.activate_session(session_dir, snapshot, false, "session_started", None, None)
    }

    pub fn resume_session(&mut self, payload: ResumeSessionPayload) -> Result<Value> {
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
        let (session_lock, journal, mut snapshot) =
            load_locked_recovery_snapshot(&session_dir, "继续录制")?;
        if snapshot.status == "faulted" || snapshot.overflow_samples > 0 {
            bail!(
                "该任务已记录音频采集故障或写盘溢出，为避免污染时间轴，不允许继续向原母轨追加；请先保全原始分段并进行质量检查。"
            );
        }
        if snapshot.items.is_empty() {
            bail!("录制任务没有可恢复的脚本条目");
        }
        if snapshot
            .items
            .iter()
            .all(|item| matches!(item.status.as_str(), "accepted" | "skipped"))
        {
            bail!("该录制任务已经全部处理，无需继续录制");
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
        )?;
        if let Some(object) = result.as_object_mut() {
            object.insert("previous_status".to_string(), json!(previous_status));
        }
        Ok(result)
    }

    fn activate_session(
        &mut self,
        session_dir: PathBuf,
        mut snapshot: SessionSnapshot,
        append: bool,
        event_name: &str,
        preacquired_session_lock: Option<SessionLock>,
        resume_journal: Option<JournalLog>,
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
        let previous_capture_source = capture_span_from_snapshot(&snapshot, 0, 0);
        let host = cpal::default_host();
        let requested_device_id =
            (!snapshot.device_id.is_empty()).then_some(snapshot.device_id.as_str());
        let requested_device_name =
            (!snapshot.device_name.is_empty()).then_some(snapshot.device_name.as_str());
        let device = select_device(&host, requested_device_id, requested_device_name)?;
        let device_id = device
            .id()
            .context("read stable input device id")?
            .to_string();
        let device_name = device.to_string();
        let input_channel_index = usize::from(snapshot.audio_format.input_channel - 1);
        let supported = select_config(
            &device,
            snapshot.audio_format.sample_rate,
            input_channel_index,
            snapshot.audio_format.bit_depth,
        )?;
        let input_channels = supported.channels();
        let sample_format = supported.sample_format();
        let config = StreamConfig {
            channels: input_channels,
            sample_rate: snapshot.audio_format.sample_rate,
            buffer_size: cpal::BufferSize::Default,
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
                    "capture_provenance": snapshot.capture_provenance,
                    "audio_format": snapshot.audio_format,
                    "storage_layout_version": snapshot.storage_layout_version,
                    "segment_frames": snapshot.segment_frames,
                    "silence_duration_ms": snapshot.silence_duration_ms,
                    "silence_threshold_dbfs": snapshot.silence_threshold_dbfs,
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
        let last_signal_sample = Arc::new(AtomicU64::new(0));
        let attempt_signal_start_sample = Arc::new(AtomicU64::new(0));
        let silence_threshold_bits =
            Arc::new(AtomicU32::new(snapshot.silence_threshold_dbfs.to_bits()));
        let (waveform_tx, waveform_rx) = bounded::<Vec<[f32; 2]>>(128);
        let telemetry_stop = Arc::new(AtomicBool::new(false));
        let capture_watchdog_armed = Arc::new(AtomicBool::new(false));
        let capture_heartbeat = Arc::new(AtomicU64::new(0));

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
                    waveform_tx,
                    writer_ready_tx,
                )
            })?;

        // Own the writer and task lock before waiting for its initialization
        // handshake. A slow or wedged WAV open must never make this command
        // release the lock while an unjoined writer still holds the audio.
        let mut session = RecordingSession {
            _session_lock: session_lock,
            session_dir,
            snapshot,
            stream: None,
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
            faulted,
            peak: peak_bits,
            rms: rms_bits,
            silence_samples,
            attempt_signal_start_sample,
            silence_threshold_bits,
            active_attempt: None,
            metadata_fault: None,
            stop_requested: false,
            capture_stopped: false,
        };
        match writer_ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(frames)) if frames == expected_existing_frames => {}
            Ok(Ok(frames)) => {
                session.faulted.store(true, Ordering::Release);
                persist_audio_fault_marker(
                    &session.session_dir,
                    "master audio changed during the writer initialization handshake",
                    session.committed.load(Ordering::Acquire),
                );
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

        let stream = match build_stream(
            &device,
            &config,
            sample_format,
            input_channel_index,
            session.writer_tx.clone(),
            Arc::clone(&session.captured),
            Arc::clone(&session.overflow),
            Arc::clone(&session.faulted),
            Arc::clone(&session.peak),
            Arc::clone(&session.rms),
            session.writer_queue.clone(),
            SilenceMonitor {
                silence_samples: Arc::clone(&session.silence_samples),
                last_signal_sample: Arc::clone(&last_signal_sample),
                attempt_signal_start_sample: Arc::clone(&session.attempt_signal_start_sample),
                threshold_bits: Arc::clone(&session.silence_threshold_bits),
                capture_heartbeat: Arc::clone(&session.capture_heartbeat),
            },
        ) {
            Ok(stream) => stream,
            Err(error) => {
                return Err(self.finish_activation_failure(
                    session,
                    "build_input_stream",
                    error.context("build input stream"),
                ));
            }
        };
        session.stream = Some(stream);

        // Keep the liveness gate independent from protocol telemetry. Stdout
        // can back up if Electron's event loop is temporarily blocked; a
        // production capture watchdog must still trip even when UI events
        // cannot be delivered.
        let watchdog_stop_thread = Arc::clone(&session.telemetry_stop);
        let capture_watchdog_armed_thread = Arc::clone(&session.capture_watchdog_armed);
        let capture_heartbeat_thread = Arc::clone(&session.capture_heartbeat);
        let watchdog_faulted = Arc::clone(&session.faulted);
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
                    if watchdog.observe(
                        Instant::now(),
                        capture_watchdog_armed_thread.load(Ordering::Acquire),
                        capture_heartbeat_thread.load(Ordering::Acquire),
                        already_faulted,
                        CAPTURE_CALLBACK_STALL_TIMEOUT,
                    ) {
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
        let storage_status_thread = Arc::clone(&storage_status);
        let storage_remaining_thread = Arc::clone(&storage_safe_remaining_seconds);
        let peak_thread = Arc::clone(&session.peak);
        let rms_thread = Arc::clone(&session.rms);
        let silence_samples_thread = Arc::clone(&session.silence_samples);
        let last_signal_sample_thread = Arc::clone(&last_signal_sample);
        let silence_threshold_thread = Arc::clone(&session.silence_threshold_bits);
        let silence_duration_ms = session.snapshot.silence_duration_ms;
        let telemetry_session_dir = session.session_dir.clone();
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
                    while let Ok(block) = waveform_rx.try_recv() {
                        waveform.extend(block);
                        if waveform.len() > 2_048 {
                            let discard = waveform.len() - 2_048;
                            waveform.drain(..discard);
                        }
                    }
                    let capture_faulted = faulted_thread.load(Ordering::Acquire);
                    let overflow_samples = overflow_thread.load(Ordering::Acquire);
                    if !fault_marker_observed
                        && (capture_faulted || overflow_samples > 0)
                        && last_fault_marker_attempt.elapsed() >= Duration::from_secs(1)
                    {
                        let marker = telemetry_session_dir.join(AUDIO_FAULT_MARKER);
                        let temporary_marker = marker.with_extension("tmp");
                        fault_marker_observed = marker.exists()
                            || temporary_marker.exists()
                            || persist_audio_fault_marker(
                                &telemetry_session_dir,
                                if overflow_samples > 0 {
                                    "capture callback could not enqueue audio into the writer"
                                } else {
                                    "capture fault observed by the telemetry supervisor"
                                },
                                committed_thread.load(Ordering::Acquire),
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
                            "storage_status": storage_status,
                            "storage_safe_remaining_seconds": storage_remaining_thread.load(Ordering::Acquire),
                            "peak": f32::from_bits(peak_thread.load(Ordering::Relaxed)),
                            "rms": f32::from_bits(rms_thread.load(Ordering::Relaxed)),
                            "silence_samples": silence_samples_thread.load(Ordering::Acquire),
                            "last_signal_sample": last_signal_sample_thread.load(Ordering::Acquire),
                            "silence_threshold_dbfs": f32::from_bits(silence_threshold_thread.load(Ordering::Relaxed)),
                            "silence_duration_ms": silence_duration_ms,
                            "waveform": waveform,
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
                "sample_rate": sample_rate,
                "bit_depth": bit_depth,
                "encoding": output_encoding.name(),
                "input_channel": session.snapshot.audio_format.input_channel,
                "storage_layout_version": session.snapshot.storage_layout_version,
                "segment_frames": session.snapshot.segment_frames,
                "silence_duration_ms": session.snapshot.silence_duration_ms,
                "silence_threshold_dbfs": session.snapshot.silence_threshold_dbfs,
                "existing_samples": expected_existing_frames,
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
        if let Err(error) = session
            .stream
            .as_ref()
            .context("input stream is unavailable after activation metadata commit")
            .and_then(|stream| stream.play().context("start input stream"))
        {
            return Err(self.finish_activation_failure(session, "play_input_stream", error));
        }
        // Arm only after `play` succeeds. Initial metadata fsync happens before
        // this point and may legitimately take longer than the stall timeout on
        // a stressed disk; it must not be confused with a live driver stall.
        session
            .capture_watchdog_armed
            .store(true, Ordering::Release);
        let result = json!({
            "snapshot": session.snapshot,
            "session_dir": session.session_dir,
            "recovery_warnings": recovery_warnings,
            "storage": storage_report,
        });
        self.session = Some(session);
        Ok(result)
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
        let rms = Arc::clone(&session.rms);
        let peak = Arc::clone(&session.peak);
        session
            .silence_threshold_bits
            .store(payload.threshold_dbfs.to_bits(), Ordering::Relaxed);
        session.snapshot.silence_threshold_dbfs = payload.threshold_dbfs;
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
        let (passed, failing_windows) = evaluate_noise(&samples, payload.threshold_dbfs);
        let average_dbfs = samples.iter().sum::<f32>() / samples.len() as f32;
        let maximum_dbfs = samples.iter().copied().fold(-96.0f32, f32::max);
        let result = NoiseCheckResult {
            passed,
            threshold_dbfs: payload.threshold_dbfs,
            average_dbfs,
            maximum_dbfs,
            failing_windows,
            samples,
            completed_at: Utc::now().to_rfc3339(),
        };
        session.snapshot.noise_check = Some(result.clone());
        session.persist("noise_check_completed", json!(&result))?;
        emitter.event("noise_check_completed", json!(&result));
        Ok(json!(result))
    }

    pub fn start_attempt(&mut self, item_id: &str) -> Result<Value> {
        let session = self.active_session_mut()?;
        session.ensure_metadata_mutation_allowed()?;
        if session.faulted.load(Ordering::Acquire) {
            bail!("音频写盘异常，请结束并恢复当前录制");
        }
        if session.active_attempt.is_some() {
            bail!("an attempt is already recording");
        }
        if !session
            .snapshot
            .noise_check
            .as_ref()
            .is_some_and(|result| result.passed)
        {
            bail!("ambient noise check must pass before recording an attempt");
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
        let required_silence_samples = session.required_silence_samples();
        let current_silence_samples = session.silence_samples.load(Ordering::Acquire);
        if current_silence_samples < required_silence_samples {
            bail!(
                "开始录制前需要连续静音 {:.1} 秒；当前 {:.1} 秒",
                session.snapshot.silence_duration_ms as f64 / 1_000.0,
                current_silence_samples as f64
                    / f64::from(session.snapshot.audio_format.sample_rate)
            );
        }
        let recording_started_sample = session.captured.load(Ordering::Acquire);
        session
            .attempt_signal_start_sample
            .store(0, Ordering::Release);
        let start_sample = recording_started_sample.saturating_sub(required_silence_samples);
        session.active_attempt = Some(ActiveAttempt {
            item_id: item_id.to_string(),
            attempt_id: attempt_id.clone(),
            start_sample,
            recording_started_sample,
        });
        session.persist(
            "attempt_started",
            json!({
                "item_id": item_id,
                "attempt_id": attempt_id,
                "start_sample": start_sample,
                "recording_started_sample": recording_started_sample,
                "pre_silence_samples": recording_started_sample - start_sample,
            }),
        )?;
        Ok(json!({
            "attempt_id": attempt_id,
            "start_sample": start_sample,
            "recording_started_sample": recording_started_sample,
        }))
    }

    pub fn stop_attempt(&mut self) -> Result<Value> {
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
            let attempt = mark_active_attempt_interrupted(
                &mut session.snapshot,
                &active,
                durable_end,
                session.attempt_signal_start_sample.load(Ordering::Acquire),
            )?;
            session.active_attempt = None;
            session.persist(
                "attempt_interrupted",
                json!({
                    "item_id": &active.item_id,
                    "attempt": &attempt,
                    "reason": "audio_writer_fault"
                }),
            )?;
            return Ok(json!({
                "item_id": &active.item_id,
                "attempt": attempt,
                "interrupted": true,
            }));
        }
        let content_started_sample = session.attempt_signal_start_sample.load(Ordering::Acquire);
        if content_started_sample == 0 {
            bail!("未检测到本句有效语音，请朗读后再完成");
        }
        let required_silence_samples = session.required_silence_samples();
        let current_silence_samples = session.silence_samples.load(Ordering::Acquire);
        if current_silence_samples < required_silence_samples {
            bail!(
                "完成本句前需要连续静音 {:.1} 秒；当前 {:.1} 秒",
                session.snapshot.silence_duration_ms as f64 / 1_000.0,
                current_silence_samples as f64
                    / f64::from(session.snapshot.audio_format.sample_rate)
            );
        }
        let captured_sample = session.captured.load(Ordering::Acquire);
        let end_sample = match session.wait_until_committed(captured_sample) {
            Ok(_) => captured_sample,
            Err(_) if session.faulted.load(Ordering::Acquire) => session
                .committed
                .load(Ordering::Acquire)
                .min(captured_sample),
            Err(error) => return Err(error),
        };
        if end_sample <= active.start_sample {
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
        let attempt = Attempt {
            attempt_id: active.attempt_id.clone(),
            start_sample: content_started_sample.saturating_sub(required_silence_samples),
            recording_started_sample: active.recording_started_sample,
            content_started_sample,
            end_sample,
            status: "recorded".to_string(),
            created_at: Utc::now().to_rfc3339(),
        };
        let item = session
            .snapshot
            .items
            .iter_mut()
            .find(|item| item.id == active.item_id)
            .ok_or_else(|| anyhow!("item disappeared while recording"))?;
        item.status = "review".to_string();
        item.attempts.push(attempt.clone());
        session.active_attempt = None;
        session.persist(
            "attempt_stopped",
            json!({ "item_id": active.item_id, "attempt": attempt }),
        )?;
        Ok(json!({ "item_id": active.item_id, "attempt": attempt }))
    }

    pub fn accept_attempt(&mut self, item_id: &str, attempt_id: &str) -> Result<Value> {
        let session = self.active_session_mut()?;
        session.ensure_metadata_mutation_allowed()?;
        if session.active_attempt.is_some() {
            bail!("cannot accept an attempt while another attempt is recording");
        }
        let item = session
            .snapshot
            .items
            .iter_mut()
            .find(|item| item.id == item_id)
            .ok_or_else(|| anyhow!("unknown item id {item_id}"))?;
        let selected = item
            .attempts
            .iter()
            .find(|attempt| attempt.attempt_id == attempt_id)
            .ok_or_else(|| anyhow!("unknown attempt id {attempt_id}"))?;
        if selected.status == "interrupted" || selected.end_sample <= selected.start_sample {
            bail!("异常中断的录音版本不能被确认或交付");
        }
        for attempt in &mut item.attempts {
            if attempt.attempt_id == attempt_id {
                attempt.status = "accepted".to_string();
            } else if attempt.status == "accepted" {
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
        session.ensure_metadata_mutation_allowed()?;
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
        let attempt = session
            .snapshot
            .items
            .iter()
            .find(|item| item.id == item_id)
            .and_then(|item| item.attempts.iter().find(|a| a.attempt_id == attempt_id))
            .cloned()
            .ok_or_else(|| anyhow!("attempt not found"))?;
        if attempt.status == "interrupted" || attempt.end_sample <= attempt.start_sample {
            bail!("异常中断的录音版本不能试听或交付");
        }
        let destination = session
            .session_dir
            .join("preview")
            .join(format!("{}.wav", bounded_wav_stem(attempt_id, "")?));
        session.render_range(&destination, attempt.start_sample, attempt.end_sample)?;
        Ok(json!({ "file_path": destination }))
    }

    pub fn get_state(&self) -> Result<Value> {
        let session = self.session.as_ref().ok_or_else(no_active_session_error)?;
        Ok(json!({
            "snapshot": session.live_snapshot(),
            "session_dir": session.session_dir,
            "active_attempt": session.active_attempt.as_ref().map(|attempt| json!({
                "item_id": attempt.item_id,
                "attempt_id": attempt.attempt_id,
                "start_sample": attempt.start_sample,
                "recording_started_sample": attempt.recording_started_sample,
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
            "active_attempt": session.active_attempt.as_ref().map(|attempt| json!({
                "item_id": attempt.item_id,
                "attempt_id": attempt.attempt_id,
                "start_sample": attempt.start_sample,
                "recording_started_sample": attempt.recording_started_sample,
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
    pub fn seal_interrupted_session(&self, session_dir: &Path) -> Result<Value> {
        self.seal_interrupted_session_inner(session_dir, JournalAppendFault::None)
    }

    fn seal_interrupted_session_inner(
        &self,
        session_dir: &Path,
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
        let mut snapshot = load_recovery_snapshot(session_dir, &mut journal)?;
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
            "no_op": false,
            "warnings": warnings,
        }))
    }

    pub fn export_session(&self, session_dir: &Path) -> Result<Value> {
        self.export_session_inner(session_dir, None)
    }

    fn export_session_inner(
        &self,
        session_dir: &Path,
        available_bytes_override: Option<u64>,
    ) -> Result<Value> {
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
        ensure_no_audio_fault_marker(session_dir, "生成常规交付")?;
        let _session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
        let mut journal = read_journal(session_dir)?;
        let snapshot = load_recovery_snapshot(session_dir, &mut journal)?;
        let recovery_warnings = journal.warnings;
        validate_snapshot_for_export(&snapshot)?;
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
        let source_metadata = std::fs::symlink_metadata(&source)
            .with_context(|| format!("inspect source audio {}", source.display()))?;
        let valid_source = match storage_kind {
            MasterStorageKind::LegacySingleWav => source_metadata.is_file(),
            MasterStorageKind::SegmentedWav => source_metadata.is_dir(),
        };
        if !valid_source || source_metadata.file_type().is_symlink() {
            bail!("recording source audio has an invalid type");
        }
        let max_frames_per_segment = storage_layout_segment_frames(&snapshot)?;
        let mut segmented_source = match storage_kind {
            MasterStorageKind::LegacySingleWav => None,
            MasterStorageKind::SegmentedWav => Some(SegmentedWav::resume(
                &source,
                snapshot.audio_format.sample_rate,
                1,
                snapshot.audio_format.bit_depth,
                max_frames_per_segment,
            )?),
        };
        let physical_frames = match segmented_source.as_ref() {
            Some(source) => source.global_frames(),
            None => RecoverableWav::open_append(
                &source,
                snapshot.audio_format.sample_rate,
                1,
                snapshot.audio_format.bit_depth,
            )?
            .frames_written(),
        };
        if physical_frames != snapshot.committed_samples {
            bail!("母轨物理帧数与已提交水位不一致，必须先恢复并安全结束录制后再交付。");
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
        let export_source = json!({
            "journal_seq": snapshot.journal_seq,
            "committed_samples": snapshot.committed_samples,
            "selected_attempts": snapshot.items.iter().map(|item| json!({
                "id": item.id,
                "attempt_id": item.selected_attempt_id,
            })).collect::<Vec<_>>(),
        });
        let in_progress_status = json!({
            "schema_version": 2,
            "status": "in_progress",
            "export_id": export_id,
            "session_id": snapshot.session_id,
            "source": export_source,
            "started_at": export_started_at,
        });
        let mut sentence_plans = Vec::<SentenceExportPlan>::new();
        let mut skipped = Vec::<Value>::new();
        let mut used_file_names = std::collections::HashSet::<String>::new();
        for (item_index, item) in snapshot.items.iter().enumerate() {
            let Some(selected) = item.selected_attempt_id.as_deref() else {
                skipped.push(json!({ "id": item.id, "reason": item.status }));
                continue;
            };
            let attempt_index = item
                .attempts
                .iter()
                .position(|attempt| attempt.attempt_id == selected)
                .with_context(|| format!("条目 {} 选中的录音版本不存在", item.id))?;
            let attempt = &item.attempts[attempt_index];
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

        let master_output = export_dir.join("full-track.wav");
        let export_status_path = export_dir.join("status.json");
        let export_metadata_path = export_dir.join("metadata.json");
        let export_csv_path = export_dir.join("metadata.csv");
        let planned_master_bytes =
            automatic_wav_file_size(physical_frames, 1, snapshot.audio_format.bit_depth)?
                .max(source_metadata.len());
        let mut storage_steps = Vec::<AtomicExportStep>::new();
        storage_steps.push(AtomicExportStep {
            new_bytes: planned_export_allocation(serialized_json_file_size(&in_progress_status)?)?,
            replaced_bytes: existing_export_allocation(existing_export_file_size(
                &export_status_path,
                "已有导出状态",
            )?),
        });
        // Once status.json is in_progress, remove every old sentence WAV as a
        // separate generation before writing any new sentence. This avoids
        // both Unicode filesystem aliases and double-crediting an old file as
        // the replacement target for more than one planned name.
        let existing_sentence_sizes = existing_sentence_wav_sizes(&sentences_dir)?;
        for old_bytes in existing_sentence_sizes {
            storage_steps.push(AtomicExportStep {
                new_bytes: 0,
                replaced_bytes: old_bytes,
            });
        }
        storage_steps.push(AtomicExportStep {
            new_bytes: planned_export_allocation(planned_master_bytes)?,
            replaced_bytes: existing_export_allocation(existing_export_file_size(
                &master_output,
                "已有整轨导出",
            )?),
        });
        for plan in &sentence_plans {
            storage_steps.push(AtomicExportStep {
                new_bytes: planned_export_allocation(plan.file_bytes)?,
                // All prior sentence WAVs are removed before this phase.
                replaced_bytes: 0,
            });
        }
        existing_export_file_size(&export_metadata_path, "已有导出元数据")?;
        existing_export_file_size(&export_csv_path, "已有 CSV 元数据")?;
        storage_steps.push(AtomicExportStep {
            new_bytes: export_metadata_headroom(&snapshot)?,
            replaced_bytes: 0,
        });
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
        remove_all_sentence_wavs(&sentences_dir)?;
        match segmented_source.as_mut() {
            Some(source) => {
                source.export_whole(&master_output)?;
            }
            None => {
                durable_copy_file(&source, &master_output)?;
            }
        }
        let mut exported = Vec::new();
        for plan in &sentence_plans {
            let item = &snapshot.items[plan.item_index];
            let attempt = &item.attempts[plan.attempt_index];
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
            exported.push(json!({
                "id": item.id,
                "text": item.text,
                "label": item.label,
                "attempt_id": attempt.attempt_id,
                "start_sample": attempt.start_sample,
                "recording_started_sample": attempt.recording_started_sample,
                "content_started_sample": attempt.content_started_sample,
                "content_started_seconds": attempt.content_started_sample as f64
                    / f64::from(snapshot.audio_format.sample_rate),
                "end_sample": attempt.end_sample,
                "duration_samples": attempt.end_sample - attempt.start_sample,
                "file": format!("sentences/{}", plan.file_name),
            }));
        }
        let metadata = json!({
            "schema_version": 1,
            "session_id": snapshot.session_id,
            "script_name": snapshot.script_name,
            "device_name": snapshot.device_name,
            "device_id": snapshot.device_id,
            "input_sample_format": snapshot.input_sample_format,
            "capture_provenance": snapshot.capture_provenance,
            "audio_format": snapshot.audio_format,
            "storage_layout_version": snapshot.storage_layout_version,
            "segment_frames": snapshot.segment_frames,
            "noise_check": snapshot.noise_check,
            "silence_policy": {
                "duration_ms": snapshot.silence_duration_ms,
                "threshold_dbfs": snapshot.silence_threshold_dbfs,
            },
            "source": export_source,
            "full_track": "full-track.wav",
            "full_track_container": full_track_container,
            "exported": exported,
            "skipped": skipped,
        });
        atomic_json(&export_metadata_path, &metadata)?;
        write_csv(&export_csv_path, &metadata["exported"])?;
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
                "source": export_source,
                "started_at": export_started_at,
                "completed_at": Utc::now().to_rfc3339(),
                "exported_count": exported_count,
                "skipped_count": skipped_count,
            }),
        )?;
        Ok(json!({
            "export_dir": export_dir,
            "master_file": master_output,
            "master_container": full_track_container,
            "sentences_dir": sentences_dir,
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
) -> Result<(SessionLock, JournalLog, SessionSnapshot)> {
    let session_lock = SessionLock::acquire(session_dir, &Utc::now().to_rfc3339())?;
    ensure_no_audio_fault_marker(session_dir, operation)?;
    let mut journal = read_journal(session_dir)?;
    let snapshot = load_recovery_snapshot(session_dir, &mut journal)?;
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

fn validate_attempt_boundaries(snapshot: &SessionSnapshot, durable_frames: u64) -> Result<()> {
    let invalid = snapshot
        .items
        .iter()
        .flat_map(|item| item.attempts.iter())
        .any(|attempt| {
            attempt.start_sample > durable_frames
                || attempt.recording_started_sample > durable_frames
                || attempt.content_started_sample > durable_frames
                || attempt.end_sample > durable_frames
                || (attempt.status == "interrupted" && attempt.end_sample < attempt.start_sample)
                || (attempt.status != "interrupted" && attempt.end_sample <= attempt.start_sample)
        });
    if invalid {
        bail!("录制任务包含超出母音频范围或长度无效的句子时间戳");
    }
    Ok(())
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
    if require_complete && !snapshot.capture_provenance.is_empty() && cursor != durable_frames {
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
        "capture_provenance": snapshot.capture_provenance,
        "audio_format": snapshot.audio_format,
        "storage_layout_version": snapshot.storage_layout_version,
        "segment_frames": snapshot.segment_frames,
        "silence_duration_ms": snapshot.silence_duration_ms,
        "silence_threshold_dbfs": snapshot.silence_threshold_dbfs,
        "started_at": snapshot.started_at,
        "updated_at": snapshot.updated_at,
    })
}

fn validate_snapshot_for_export(snapshot: &SessionSnapshot) -> Result<()> {
    if snapshot.status == "faulted" || snapshot.overflow_samples > 0 {
        bail!("录制存在写盘故障或音频队列溢出，禁止生成常规交付；仅可保留并检查原始母轨。");
    }
    if snapshot.status != "stopped" {
        bail!("录制尚未安全结束，禁止生成常规交付；请先封存母轨。")
    }
    validate_capture_provenance(snapshot, snapshot.committed_samples, true)?;
    for item in &snapshot.items {
        let Some(selected_id) = item.selected_attempt_id.as_deref() else {
            continue;
        };
        let attempt = item
            .attempts
            .iter()
            .find(|attempt| attempt.attempt_id == selected_id)
            .with_context(|| {
                format!(
                    "条目 {} 选中的录音版本不存在，禁止常规交付；仅可保留原始母轨。",
                    item.id
                )
            })?;
        let outside_durable_audio = attempt.end_sample <= attempt.start_sample
            || attempt.start_sample > snapshot.committed_samples
            || attempt.recording_started_sample > snapshot.committed_samples
            || attempt.content_started_sample > snapshot.committed_samples
            || attempt.end_sample > snapshot.committed_samples;
        if attempt.status == "interrupted" || outside_durable_audio {
            bail!(
                "条目 {} 选中的录音版本异常中断或样本边界越界，禁止常规交付；仅可保留并检查原始母轨。",
                item.id
            );
        }
    }
    Ok(())
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

fn load_recovery_snapshot(session_dir: &Path, journal: &mut JournalLog) -> Result<SessionSnapshot> {
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
    let expected_session_id = read_session_identity(session_dir, &mut journal.warnings)
        .or(journal_identity)
        .or(fallback_identity)
        .context("无法确定录制任务身份")?;

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
    if !selected.source.starts_with("final snapshot") {
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
        let start_sample = active.start_sample.min(durable_frames);
        item.attempts.push(Attempt {
            attempt_id: active.attempt_id.clone(),
            start_sample,
            recording_started_sample: active.recording_started_sample.min(durable_frames),
            content_started_sample: 0,
            end_sample: durable_frames,
            status: "interrupted".to_string(),
            created_at: active.created_at,
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
    let content_started_sample = if content_started_sample == 0 {
        0
    } else {
        content_started_sample.min(durable_end)
    };
    let attempt = Attempt {
        attempt_id: active.attempt_id.clone(),
        start_sample: active.start_sample.min(durable_end),
        recording_started_sample: active.recording_started_sample.min(durable_end),
        content_started_sample,
        end_sample: durable_end,
        status: "interrupted".to_string(),
        created_at: Utc::now().to_rfc3339(),
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
        snapshot.updated_at = Utc::now().to_rfc3339();
        snapshot
    }

    fn ensure_metadata_mutation_allowed(&self) -> Result<()> {
        if let Some(fault) = &self.metadata_fault {
            bail!("录制元数据已进入保护状态，禁止继续修改：{fault}。请结束录制并保留原始母轨。");
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
            if let Err(error) = stream.pause() {
                warnings.push(format!("pause input stream while stopping: {error}"));
            }
            drop(stream);
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
        let capture_resources_joined =
            callback_gate_drained && telemetry_joined && capture_watchdog_joined && writer_joined;
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
            self.faulted.store(true, Ordering::Release);
            persist_audio_fault_marker(
                &self.session_dir,
                &format!("recording activation failed during {stage}: {reason}"),
                cleanup.committed_samples,
            );
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
        // Stop accepting more callback blocks, wait for callbacks already in
        // the enqueue path, then put the fault sentinel behind their sample
        // messages. This gives metadata durability failures the same finite,
        // drain-and-finalize behavior as an audio-device xrun.
        self.faulted.store(true, Ordering::Release);
        self.writer_queue.close();
        persist_audio_fault_marker(
            &self.session_dir,
            &format!("metadata journal durability failure: {message}"),
            self.committed.load(Ordering::Acquire),
        );
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
                "capture_provenance": self.snapshot.capture_provenance,
                "audio_format": self.snapshot.audio_format,
                "storage_layout_version": self.snapshot.storage_layout_version,
                "segment_frames": self.snapshot.segment_frames,
                "silence_duration_ms": self.snapshot.silence_duration_ms,
                "silence_threshold_dbfs": self.snapshot.silence_threshold_dbfs,
                "started_at": self.snapshot.started_at,
                "updated_at": self.snapshot.updated_at,
            }),
        ) {
            projection_failures.push(format!("update session summary: {error:#}"));
        }
        // Once the replaceable projections are durable, only the latest full
        // journal projection is needed. Atomic compaction keeps the log bounded
        // to one or two entries even for scripts with thousands of sentences:
        // a crash before replacement leaves the old+new pair, while a crash
        // after replacement leaves the latest self-contained event.
        if projection_failures.is_empty()
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
                self.attempt_signal_start_sample.load(Ordering::Acquire),
            )
        {
            warnings.push(format!("mark active attempt interrupted: {error:#}"));
        }
        self.snapshot = self.live_snapshot();
        self.snapshot.status = "faulted".to_string();
        persist_audio_fault_marker(
            &self.session_dir,
            &format!("metadata journal durability failure: {metadata_fault}"),
            committed,
        );

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
                "capture_provenance": self.snapshot.capture_provenance,
                "audio_format": self.snapshot.audio_format,
                "storage_layout_version": self.snapshot.storage_layout_version,
                "segment_frames": self.snapshot.segment_frames,
                "silence_duration_ms": self.snapshot.silence_duration_ms,
                "silence_threshold_dbfs": self.snapshot.silence_threshold_dbfs,
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
        if !cleanup.audio_safe {
            self.faulted.store(true, Ordering::Release);
            persist_audio_fault_marker(
                &self.session_dir,
                &format!(
                    "capture resources stopped without a complete durable timeline: captured={}, committed={committed}",
                    cleanup.captured_samples
                ),
                committed,
            );
        }
        if self.metadata_fault.is_some() {
            return Err(self.metadata_seal_error(committed, warnings));
        }
        if let Some(active) = self.active_attempt.take() {
            let attempt = mark_active_attempt_interrupted(
                &mut self.snapshot,
                &active,
                committed,
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
        bail!("单次实时试听最长支持 10 分钟，请缩短录音版本后重试");
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
    persist_audio_fault_marker_inner(session_dir, reason, committed_frames, false)
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
) {
    let reason = latched_reason.get_or_insert_with(|| reason.into());
    persist_audio_fault_marker(session_dir, reason, committed_frames);
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
        bail!("injected audio write failure");
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
    waveform: Sender<Vec<[f32; 2]>>,
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
            faulted.store(true, Ordering::Release);
            persist_audio_fault_marker(
                storage_directory,
                &reason,
                committed.load(Ordering::Acquire),
            );
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
                    faulted.store(true, Ordering::Release);
                    // Reject new callbacks and wait through every callback that
                    // already entered before measuring accepted audio. The
                    // remaining channel backlog cannot be written safely after
                    // a storage error, so it is accounted as lost explicitly.
                    queue.close_and_wait();
                    persist_audio_fault_marker(
                        storage_directory,
                        &base_reason,
                        committed.load(Ordering::Acquire),
                    );
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
                    persist_audio_fault_marker(storage_directory, &message, durable_frames);
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
                let _ = waveform.try_send(waveform_bins(&samples));
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
                    faulted.store(true, Ordering::Release);
                    latch_audio_fault_marker(
                        storage_directory,
                        &mut latched_fault_reason,
                        &reason,
                        committed.load(Ordering::Acquire),
                    );
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
                        faulted.store(true, Ordering::Release);
                        latch_audio_fault_marker(
                            storage_directory,
                            &mut latched_fault_reason,
                            format!("audio checkpoint failed: {message}"),
                            committed.load(Ordering::Acquire),
                        );
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
                                    faulted.store(true, Ordering::Release);
                                    latch_audio_fault_marker(
                                        storage_directory,
                                        &mut latched_fault_reason,
                                        &reason,
                                        committed.load(Ordering::Acquire),
                                    );
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
            WriterMessage::FaultAndStop(reason) => {
                eprintln!("audio writer stopping after capture fault: {reason}");
                faulted.store(true, Ordering::Release);
                latch_audio_fault_marker(
                    storage_directory,
                    &mut latched_fault_reason,
                    &reason,
                    committed.load(Ordering::Acquire),
                );
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
            let result = writer.finalize().map_err(|error| format!("{error:#}"));
            match &result {
                Ok(frames) => committed.store(*frames, Ordering::Release),
                Err(message) => {
                    eprintln!("audio writer final checkpoint failed: {message}");
                    faulted.store(true, Ordering::Release);
                    latch_audio_fault_marker(
                        storage_directory,
                        &mut latched_fault_reason,
                        format!("audio writer final checkpoint failed: {message}"),
                        committed.load(Ordering::Acquire),
                    );
                }
            }
            if let Some(reason) = latched_fault_reason.as_deref() {
                persist_audio_fault_marker(
                    storage_directory,
                    reason,
                    committed.load(Ordering::Acquire),
                );
            }
            if let Some(reply) = pending_stop_reply.take() {
                let _ = reply.send(result);
            }
            queue.queued_frames.store(0, Ordering::Release);
            break;
        }
    }
}

fn select_device(
    host: &cpal::Host,
    requested_id: Option<&str>,
    legacy_requested_name: Option<&str>,
) -> Result<Device> {
    if let Some(requested_id) = requested_id {
        let parsed = requested_id
            .parse::<cpal::DeviceId>()
            .with_context(|| format!("invalid stable input device id: {requested_id}"))?;
        let device = host.device_by_id(&parsed).ok_or_else(|| {
            anyhow!(
                "指定的录音设备已断开或设备 ID 已变化：{requested_id}；为避免录错输入，软件不会自动切换到同名设备"
            )
        })?;
        if !device.supports_input() {
            bail!("指定的设备不再提供录音输入：{requested_id}");
        }
        return Ok(device);
    }
    if let Some(requested_name) = legacy_requested_name {
        let mut matches = host
            .input_devices()
            .context("enumerate legacy input devices")?
            .filter(|device| device.to_string() == requested_name);
        let first = matches
            .next()
            .ok_or_else(|| anyhow!("input device not found: {requested_name}"))?;
        if matches.next().is_some() {
            bail!(
                "旧录制任务只保存了设备名称“{requested_name}”，当前存在多个同名输入；为避免录错声卡，无法自动恢复，请明确重新绑定设备"
            );
        }
        return Ok(first);
    }
    host.default_input_device()
        .ok_or_else(|| anyhow!("no default input device is available"))
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

fn select_config(
    device: &Device,
    sample_rate: u32,
    input_channel_index: usize,
    output_bit_depth: u16,
) -> Result<SupportedStreamConfig> {
    let minimum_representation_bits = minimum_input_representation_bits(output_bit_depth)?;
    let mut selected: Option<(u8, SupportedStreamConfig)> = None;
    let mut compatible_rates = Vec::<(u32, u32)>::new();
    let mut formats_at_requested_rate = Vec::<(String, u16)>::new();
    let requested_channel = input_channel_index + 1;
    for range in device
        .supported_input_configs()
        .context("query supported input formats")?
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
        if representation_bits < minimum_representation_bits {
            continue;
        }
        let score = input_format_score(range.sample_format());
        let config = range.with_sample_rate(sample_rate);
        if selected
            .as_ref()
            .is_none_or(|(current_score, _)| score > *current_score)
        {
            selected = Some((score, config));
        }
    }
    if let Some((_, config)) = selected {
        return Ok(config);
    }
    if compatible_rates.is_empty() {
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
    peak_bits: Arc<AtomicU32>,
    rms_bits: Arc<AtomicU32>,
    queue: WriterQueueBudget,
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue.clone(),
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
            peak_bits,
            rms_bits,
            queue,
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
    peak_bits: Arc<AtomicU32>,
    rms_bits: Arc<AtomicU32>,
    queue: WriterQueueBudget,
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
    let error_writer = writer.clone();
    let error_queue = queue.clone();
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
                Ok(mono) => publish_leased_block(
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
                ),
                Err(error) => fail_capture_block(
                    error.reason,
                    error.dropped_frames,
                    &writer,
                    &overflow,
                    &faulted,
                    &queue,
                    enqueue_lease,
                ),
            }
        },
        move |error| {
            error_emitter.store(true, Ordering::Release);
            error_queue.close_and_wait();
            eprintln!("audio stream error: {error}");
            let _ = error_writer.try_send(WriterMessage::FaultAndStop(format!(
                "audio input stream failed: {error}"
            )));
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
) {
    faulted.store(true, Ordering::Release);
    saturating_atomic_add(overflow, dropped_frames);
    // Drop this callback's lease before waiting. Once every older callback has
    // left its enqueue path, the fault sentinel is guaranteed to sit behind
    // every Samples message that was accepted before the bad block.
    drop(enqueue_lease);
    queue.close_and_wait();
    let _ = writer.try_send(WriterMessage::FaultAndStop(format!(
        "{reason}; dropped_frames={dropped_frames}"
    )));
}

#[cfg(test)]
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
        );
        return;
    }
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
    if !queue.reserve(frames) {
        fail_capture_block(
            "audio writer queue exceeded its 20 second frame budget".to_string(),
            frames,
            writer,
            overflow,
            faulted,
            queue,
            enqueue_lease,
        );
        return;
    }
    let Some((block_start, block_end)) = reserve_counter_range(captured, frames) else {
        queue.release(frames);
        fail_capture_block(
            "audio capture timeline counter overflow".to_string(),
            frames,
            writer,
            overflow,
            faulted,
            queue,
            enqueue_lease,
        );
        return;
    };
    if writer.try_send(WriterMessage::Samples(mono)).is_err() {
        queue.release(frames);
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
        );
        return;
    }
    // The checked timeline reservation is retained only after the complete
    // finite block has entered the writer queue. Once enqueueing fails, later
    // callbacks are rejected so WAV frames and sample annotations cannot drift.
    let threshold_dbfs = f32::from_bits(silence.threshold_bits.load(Ordering::Relaxed));
    let threshold_linear = 10f32.powf(threshold_dbfs / 20.0);
    if rms <= threshold_linear {
        saturating_atomic_add(&silence.silence_samples, frames);
    } else {
        silence.silence_samples.store(0, Ordering::Release);
        let _ = silence.attempt_signal_start_sample.compare_exchange(
            0,
            block_start.max(1),
            Ordering::Release,
            Ordering::Relaxed,
        );
        silence
            .last_signal_sample
            .store(block_end, Ordering::Release);
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
}

fn waveform_bins(samples: &[f32]) -> Vec<[f32; 2]> {
    const BIN_SAMPLES: usize = 64;
    samples
        .chunks(BIN_SAMPLES)
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
            "id,text,label,attempt_id,start_sample,recording_started_sample,content_started_sample,content_started_seconds,end_sample,duration_samples,file"
        )?;
        if let Some(rows) = exported.as_array() {
            for row in rows {
                writeln!(
                    file,
                    "{},{},{},{},{},{},{},{:.6},{},{},{}",
                    csv_cell(row["id"].as_str().unwrap_or_default()),
                    csv_cell(row["text"].as_str().unwrap_or_default()),
                    csv_cell(row["label"].as_str().unwrap_or_default()),
                    csv_cell(row["attempt_id"].as_str().unwrap_or_default()),
                    row["start_sample"].as_u64().unwrap_or_default(),
                    row["recording_started_sample"].as_u64().unwrap_or_default(),
                    row["content_started_sample"].as_u64().unwrap_or_default(),
                    row["content_started_seconds"].as_f64().unwrap_or_default(),
                    row["end_sample"].as_u64().unwrap_or_default(),
                    row["duration_samples"].as_u64().unwrap_or_default(),
                    csv_cell(row["file"].as_str().unwrap_or_default()),
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

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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

    fn disconnected_waveform_sender() -> Sender<Vec<[f32; 2]>> {
        bounded::<Vec<[f32; 2]>>(1).0
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
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
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
            started_at: "2026-08-10T11:00:00Z".to_string(),
            updated_at: "2026-08-10T12:00:00Z".to_string(),
            noise_check: None,
            silence_duration_ms: 1_000,
            silence_threshold_dbfs: -42.0,
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
            _session_lock: SessionLock::acquire(root, "2026-08-11T00:00:00Z").unwrap(),
            session_dir: root.to_path_buf(),
            snapshot: test_snapshot(),
            stream: None,
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
            faulted: Arc::new(AtomicBool::new(false)),
            peak: Arc::new(AtomicU32::new(0)),
            rms: Arc::new(AtomicU32::new(0)),
            silence_samples: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            active_attempt: None,
            metadata_fault: None,
            stop_requested: false,
            capture_stopped: false,
        }
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
            _session_lock: SessionLock::acquire(root, "2026-08-11T00:00:00Z").unwrap(),
            session_dir: root.to_path_buf(),
            snapshot: test_snapshot(),
            stream: None,
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
            faulted,
            peak: Arc::new(AtomicU32::new(0)),
            rms: Arc::new(AtomicU32::new(0)),
            silence_samples: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
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
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(1)),
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
        let error = load_locked_recovery_snapshot(&root, "继续录制")
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
            load_locked_recovery_snapshot(&root, "继续录制").unwrap();
        assert_eq!(recovered.journal_seq, 7);
        assert_eq!(journal.entries.len(), 1);
        assert!(SessionLock::acquire(&root, "2026-08-11T00:00:01Z").is_err());
        drop(recovery_lock);

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
            })
            .unwrap_err();
        assert!(format!("{resume_error:#}").contains("禁止继续录制"));

        let export_error = engine.export_session(&root).unwrap_err();
        assert!(format!("{export_error:#}").contains("禁止生成常规交付"));
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
            })
            .unwrap_err();
        assert!(format!("{resume_error:#}").contains("禁止继续录制"));
        let export_error = engine.export_session(&root).unwrap_err();
        assert!(format!("{export_error:#}").contains("禁止生成常规交付"));

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
                waveform_tx,
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
                waveform_tx,
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
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
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
                waveform_tx,
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
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
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
            last_signal_sample: Arc::new(AtomicU64::new(11)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(7)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
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
            last_signal_sample: Arc::new(AtomicU64::new(80)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(70)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
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
            last_signal_sample: Arc::new(AtomicU64::new(80)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(70)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
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
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            capture_heartbeat: Arc::new(AtomicU64::new(0)),
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
            _session_lock: SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap(),
            session_dir: root.clone(),
            snapshot: test_snapshot(),
            stream: None,
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
            faulted,
            peak: Arc::new(AtomicU32::new(0)),
            rms: Arc::new(AtomicU32::new(0)),
            silence_samples: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            active_attempt: None,
            metadata_fault: None,
            stop_requested: false,
            capture_stopped: false,
        };

        let result = session.stop().unwrap();
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
            _session_lock: SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap(),
            session_dir: root.clone(),
            snapshot: test_snapshot(),
            stream: None,
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
            faulted,
            peak: Arc::new(AtomicU32::new(0f32.to_bits())),
            rms: Arc::new(AtomicU32::new(0f32.to_bits())),
            silence_samples: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample,
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
            active_attempt: Some(ActiveAttempt {
                item_id: "001".to_string(),
                attempt_id: "001-a1".to_string(),
                start_sample: 0,
                recording_started_sample: 1,
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
    fn export_rejects_faults_overflow_and_invalid_selected_attempts() {
        let mut snapshot = test_snapshot();
        snapshot.status = "faulted".to_string();
        let error = validate_snapshot_for_export(&snapshot).unwrap_err();
        assert!(format!("{error:#}").contains("原始母轨"));

        snapshot.status = "stopped".to_string();
        snapshot.overflow_samples = 1;
        assert!(validate_snapshot_for_export(&snapshot).is_err());

        snapshot.overflow_samples = 0;
        snapshot.committed_samples = 100;
        snapshot.items[0].selected_attempt_id = Some("001-a1".to_string());
        snapshot.items[0].attempts.push(Attempt {
            attempt_id: "001-a1".to_string(),
            start_sample: 10,
            recording_started_sample: 20,
            content_started_sample: 25,
            end_sample: 90,
            status: "interrupted".to_string(),
            created_at: "2026-08-11T00:00:00Z".to_string(),
        });
        assert!(validate_snapshot_for_export(&snapshot).is_err());

        snapshot.items[0].attempts[0].status = "accepted".to_string();
        snapshot.items[0].attempts[0].end_sample = 101;
        assert!(validate_snapshot_for_export(&snapshot).is_err());

        snapshot.items[0].attempts[0].end_sample = 100;
        assert!(validate_snapshot_for_export(&snapshot).is_ok());
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
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);
        std::fs::write(
            root.join("metadata/items.snapshot.json"),
            b"{\"schema_version\":1,",
        )
        .unwrap();

        let result = Engine::new(Emitter::new()).export_session(&root).unwrap();

        assert!(root.join("export/full-track.wav").is_file());
        assert_eq!(result["master_container"], "riff");
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
            json!([{ "id": "001", "attempt_id": null }])
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
            "content_started_sample": 12,
            "content_started_seconds": 0.00025,
            "end_sample": 20,
            "duration_samples": 10,
            "file": "sentences/001.wav",
        }]);

        write_csv(&destination, &rows).unwrap();

        let csv = std::fs::read_to_string(&destination).unwrap();
        assert!(!csv.contains("old generation"));
        assert!(csv.contains("\"hello, \"\"world\"\"\""));
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
        write_journal(&root, &[sequenced_event("session_stopped", &stopped)]);

        let result = Engine::new(Emitter::new()).export_session(&root).unwrap();

        assert_eq!(result["exported_count"].as_u64(), Some(0));
        assert!(root.join("export/full-track.wav").is_file());
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

        assert!(started.elapsed() < Duration::from_secs(2));
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

        assert!(started.elapsed() < Duration::from_secs(2));
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
            _session_lock: SessionLock::acquire(&root, "2026-08-11T00:00:00Z").unwrap(),
            session_dir: root.clone(),
            snapshot: test_snapshot(),
            stream: None,
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
            faulted,
            peak: Arc::new(AtomicU32::new(0)),
            rms: Arc::new(AtomicU32::new(0)),
            silence_samples: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            silence_threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
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
        assert_eq!(snapshot.items[0].attempts[0].start_sample, 100);
        assert_eq!(snapshot.items[0].attempts[0].end_sample, 120);

        let warnings = recover_interrupted_attempts(&journal, &mut snapshot, 120).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(snapshot.items[0].attempts.len(), 1);
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
        assert_eq!(attempt.start_sample, 1);
        assert_eq!(attempt.recording_started_sample, 2);
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
