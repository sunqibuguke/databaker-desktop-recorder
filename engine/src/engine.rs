use crate::durable_fs::{durable_replace, sync_directory, sync_parent_directory};
use crate::protocol::Emitter;
use crate::segmented_wav::{PreparedWavExport, SegmentedWav};
use crate::session_lock::SessionLock;
use crate::storage_guard::{StorageReport, StorageStatus, check_storage};
use crate::wav::{RecoverableWav, WavEncoding, slice_wav_mono, validate_standard_wav_size};
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
const WRITER_QUEUE_CLOSED: u64 = 1 << 63;
const WRITER_QUEUE_IN_FLIGHT_MASK: u64 = WRITER_QUEUE_CLOSED - 1;
const WRITER_CHECKPOINT_TIMEOUT: Duration = Duration::from_secs(25);
const WRITER_COMMIT_DEADLINE: Duration = Duration::from_secs(30);
const WRITER_STOP_TIMEOUT: Duration = Duration::from_secs(25);
#[cfg(not(test))]
const WRITER_JOIN_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(test)]
const WRITER_JOIN_TIMEOUT: Duration = Duration::from_millis(100);
// Electron gives normal engine commands 20 seconds. Return control to the
// protocol loop before that deadline so a slow preview worker can never block
// a subsequent safe-stop request until the 90-second process kill budget.
const PREVIEW_RENDER_TIMEOUT: Duration = Duration::from_secs(15);
const AUDIO_FAULT_MARKER: &str = "metadata/audio-fault.json";
static EXPORT_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

    fn close_and_wait(&self) {
        self.enqueue_state
            .fetch_or(WRITER_QUEUE_CLOSED, Ordering::AcqRel);
        let mut spins = 0u32;
        while self.enqueue_state.load(Ordering::Acquire) & WRITER_QUEUE_IN_FLIGHT_MASK != 0 {
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
    telemetry_stop: Arc<AtomicBool>,
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
            std::fs::create_dir_all(parent)?;
        }
        std::fs::create_dir(&session_dir).with_context(|| {
            format!(
                "create a new recording directory {}; the path must not already exist",
                session_dir.display()
            )
        })?;
        std::fs::create_dir_all(session_dir.join("audio"))?;
        std::fs::create_dir_all(session_dir.join("metadata"))?;
        std::fs::create_dir_all(session_dir.join("script"))?;
        std::fs::create_dir_all(session_dir.join("preview"))?;
        std::fs::create_dir_all(session_dir.join("export"))?;

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
        self.activate_session(session_dir, snapshot, false, "session_started", None)
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
        ensure_no_audio_fault_marker(&session_dir, "继续录制")?;
        // No individual projection is authoritative enough to make the whole
        // recording undiscoverable. A power loss can leave the final snapshot,
        // its atomically-written temporary/previous generation, and the full
        // journal projection at different generations. Select the newest valid
        // candidate instead of requiring the final file to parse first.
        let mut journal = read_journal(&session_dir)?;
        let mut snapshot = load_recovery_snapshot(&session_dir, &mut journal)?;
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
        resume_journal: Option<JournalLog>,
    ) -> Result<Value> {
        let max_frames_per_segment = storage_layout_segment_frames(&snapshot)?;
        // Persist the resolved compatibility value on the next projection so
        // a pre-layout snapshot is upgraded without changing its boundaries.
        snapshot.segment_frames = Some(max_frames_per_segment);
        let session_lock = SessionLock::acquire(&session_dir, &Utc::now().to_rfc3339())?;
        if append {
            repair_journal_tail(
                &session_dir,
                resume_journal
                    .as_ref()
                    .context("resume journal was not loaded")?,
            )?;
        }
        let output_encoding = WavEncoding::for_bit_depth(snapshot.audio_format.bit_depth)?;
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

        // A recoverable projection must exist before the audio stream can emit
        // its first frame. If the process dies between stream startup and the
        // first journal event, resume can still discover the physical segments
        // from this sequence-zero bootstrap snapshot.
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

        let writer_committed = Arc::clone(&committed);
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
                    writer_committed,
                    writer_faulted,
                    writer_storage_status,
                    writer_storage_remaining,
                    writer_queue_thread,
                    waveform_tx,
                    writer_ready_tx,
                )
            })?;
        match writer_ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(frames)) if frames == expected_existing_frames => {}
            Ok(Ok(_)) => {
                drop(writer_tx);
                let _ = writer_join.join();
                bail!("母音频在恢复录制前发生了变化");
            }
            Ok(Err(message)) => {
                drop(writer_tx);
                let _ = writer_join.join();
                bail!(message);
            }
            Err(_) => {
                drop(writer_tx);
                let _ = writer_join.join();
                bail!("audio writer initialization timed out");
            }
        }

        let stream = build_stream(
            &device,
            &config,
            sample_format,
            input_channel_index,
            writer_tx.clone(),
            Arc::clone(&captured),
            Arc::clone(&overflow),
            Arc::clone(&faulted),
            Arc::clone(&peak_bits),
            Arc::clone(&rms_bits),
            writer_queue.clone(),
            SilenceMonitor {
                silence_samples: Arc::clone(&silence_samples),
                last_signal_sample: Arc::clone(&last_signal_sample),
                attempt_signal_start_sample: Arc::clone(&attempt_signal_start_sample),
                threshold_bits: Arc::clone(&silence_threshold_bits),
            },
        )?;
        stream.play().context("start input stream")?;

        let emitter = self.emitter.clone();
        let telemetry_stop_thread = Arc::clone(&telemetry_stop);
        let captured_thread = Arc::clone(&captured);
        let committed_thread = Arc::clone(&committed);
        let overflow_thread = Arc::clone(&overflow);
        let faulted_thread = Arc::clone(&faulted);
        let storage_status_thread = Arc::clone(&storage_status);
        let storage_remaining_thread = Arc::clone(&storage_safe_remaining_seconds);
        let peak_thread = Arc::clone(&peak_bits);
        let rms_thread = Arc::clone(&rms_bits);
        let silence_samples_thread = Arc::clone(&silence_samples);
        let last_signal_sample_thread = Arc::clone(&last_signal_sample);
        let silence_threshold_thread = Arc::clone(&silence_threshold_bits);
        let silence_duration_ms = snapshot.silence_duration_ms;
        let telemetry_session_dir = session_dir.clone();
        let telemetry_join = thread::Builder::new()
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
            })?;

        let mut session = RecordingSession {
            _session_lock: session_lock,
            session_dir,
            snapshot,
            stream: Some(stream),
            writer_tx,
            writer_queue,
            writer_join: Some(writer_join),
            telemetry_join: Some(telemetry_join),
            telemetry_stop,
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
            let cleanup_warnings = session.cleanup_after_activation_failure();
            let context = if cleanup_warnings.is_empty() {
                "persist initial recording metadata; capture resources were stopped and joined"
                    .to_string()
            } else {
                format!(
                    "persist initial recording metadata; capture cleanup warnings: {}",
                    cleanup_warnings.join("; ")
                )
            };
            return Err(error.context(context));
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
        let file_stem = safe_file_name(item_id);
        let mut sequence = item.attempts.len() + 1;
        let attempt_id = loop {
            let candidate = format!("{file_stem}-a{sequence}");
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
            .join(format!("{}.wav", safe_file_name(attempt_id)));
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

    pub fn export_session(&self, session_dir: &Path) -> Result<Value> {
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
        // A long segmented master can be perfectly healthy while no longer
        // fitting in one standard RIFF/WAVE. Reject it before copying gigabytes
        // into a temporary full-track file that can never be finalized.
        validate_standard_wav_size(physical_frames, 1, snapshot.audio_format.bit_depth)?;
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
        let export_status_path = export_dir.join("status.json");
        atomic_json(
            &export_status_path,
            &json!({
                "schema_version": 1,
                "status": "in_progress",
                "export_id": export_id,
                "session_id": snapshot.session_id,
                "started_at": export_started_at,
            }),
        )?;
        let master_output = export_dir.join("full-track.wav");
        match segmented_source.as_mut() {
            Some(source) => {
                source.export_whole(&master_output)?;
            }
            None => {
                durable_copy_file(&source, &master_output)?;
            }
        }
        let mut exported = Vec::new();
        let mut skipped = Vec::new();
        let mut used_file_names = std::collections::HashSet::new();
        for (item_index, item) in snapshot.items.iter().enumerate() {
            let Some(selected) = item.selected_attempt_id.as_deref() else {
                skipped.push(json!({ "id": item.id, "reason": item.status }));
                continue;
            };
            let Some(attempt) = item.attempts.iter().find(|a| a.attempt_id == selected) else {
                skipped.push(json!({ "id": item.id, "reason": "selected_attempt_missing" }));
                continue;
            };
            let stem = safe_file_name(&item.id);
            let mut file_name = format!("{stem}.wav");
            if !used_file_names.insert(file_name.to_lowercase()) {
                file_name = format!("{stem}-{}.wav", item_index + 1);
                used_file_names.insert(file_name.to_lowercase());
            }
            let output = sentences_dir.join(&file_name);
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
                "file": format!("sentences/{file_name}"),
            }));
        }
        remove_stale_sentence_wavs(&sentences_dir, &used_file_names)?;
        let metadata = json!({
            "schema_version": 1,
            "session_id": snapshot.session_id,
            "script_name": snapshot.script_name,
            "device_name": snapshot.device_name,
            "device_id": snapshot.device_id,
            "input_sample_format": snapshot.input_sample_format,
            "audio_format": snapshot.audio_format,
            "storage_layout_version": snapshot.storage_layout_version,
            "segment_frames": snapshot.segment_frames,
            "noise_check": snapshot.noise_check,
            "silence_policy": {
                "duration_ms": snapshot.silence_duration_ms,
                "threshold_dbfs": snapshot.silence_threshold_dbfs,
            },
            "full_track": "full-track.wav",
            "exported": exported,
            "skipped": skipped,
        });
        atomic_json(&export_dir.join("metadata.json"), &metadata)?;
        write_csv(&export_dir.join("metadata.csv"), &metadata["exported"])?;
        let exported_count = metadata["exported"].as_array().map_or(0, Vec::len);
        let skipped_count = metadata["skipped"].as_array().map_or(0, Vec::len);
        // This small commit marker is always the last published file. Readers
        // must ignore the bundle while it says `in_progress`, so a crash or a
        // failed re-export cannot be mistaken for a coherent delivery.
        atomic_json(
            &export_status_path,
            &json!({
                "schema_version": 1,
                "status": "complete",
                "export_id": export_id,
                "session_id": snapshot.session_id,
                "started_at": export_started_at,
                "completed_at": Utc::now().to_rfc3339(),
                "exported_count": exported_count,
                "skipped_count": skipped_count,
            }),
        )?;
        Ok(json!({
            "export_dir": export_dir,
            "master_file": master_output,
            "sentences_dir": sentences_dir,
            "exported_count": exported_count,
            "skipped_count": skipped_count,
            "recovery_warnings": recovery_warnings,
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

    fn active_session_mut(&mut self) -> Result<&mut RecordingSession> {
        self.session.as_mut().ok_or_else(no_active_session_error)
    }
}

fn validate_snapshot_for_export(snapshot: &SessionSnapshot) -> Result<()> {
    if snapshot.status == "faulted" || snapshot.overflow_samples > 0 {
        bail!("录制存在写盘故障或音频队列溢出，禁止生成常规交付；仅可保留并检查原始母轨。");
    }
    if snapshot.status != "stopped" {
        bail!("录制尚未安全结束，禁止生成常规交付；请先封存母轨。")
    }
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
        snapshot.committed_samples = self.committed.load(Ordering::Acquire);
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

    fn settle_captured_samples(&self) -> u64 {
        let mut captured = self.captured.load(Ordering::Acquire);
        let mut stable_since = Instant::now();
        let settle_deadline = Instant::now() + Duration::from_millis(500);
        while stable_since.elapsed() < Duration::from_millis(50) && Instant::now() < settle_deadline
        {
            thread::sleep(Duration::from_millis(10));
            let current = self.captured.load(Ordering::Acquire);
            if current != captured {
                captured = current;
                stable_since = Instant::now();
            }
        }
        captured
    }

    /// Tears down every resource that was started before the first journal
    /// event. This path deliberately joins the writer without detaching it:
    /// returning the original persistence error must not leave a hidden stream,
    /// telemetry loop, or unfinalized WAV behind.
    fn cleanup_after_activation_failure(&mut self) -> Vec<String> {
        let mut warnings = Vec::<String>::new();
        if let Some(stream) = self.stream.take() {
            if let Err(error) = stream.pause() {
                warnings.push(format!("pause input stream: {error}"));
            }
            drop(stream);
        }
        self.telemetry_stop.store(true, Ordering::Release);
        if let Some(join) = self.telemetry_join.take()
            && join.join().is_err()
        {
            warnings.push("telemetry thread panicked during activation cleanup".to_string());
        }

        let captured = self.settle_captured_samples();
        if let Err(error) = self.wait_until_committed(captured) {
            warnings.push(format!(
                "checkpoint audio during activation cleanup: {error:#}"
            ));
        }

        let mut committed = self.committed.load(Ordering::Acquire);
        let (reply_tx, reply_rx) = bounded(1);
        match self.writer_tx.send(WriterMessage::Stop(reply_tx)) {
            Ok(()) => match reply_rx.recv_timeout(WRITER_STOP_TIMEOUT) {
                Ok(Ok(value)) => committed = value,
                Ok(Err(message)) => warnings.push(format!(
                    "finalize audio during activation cleanup: {message}"
                )),
                Err(error) => warnings.push(format!(
                    "wait for audio finalization during activation cleanup: {error}"
                )),
            },
            Err(error) => warnings.push(format!(
                "stop audio writer during activation cleanup: {error}"
            )),
        }
        self.committed.store(committed, Ordering::Release);
        if let Some(join) = self.writer_join.take()
            && join.join().is_err()
        {
            warnings.push("audio writer panicked during activation cleanup".to_string());
        }
        self.capture_stopped = true;
        warnings
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
        self.writer_queue.close_and_wait();
        persist_audio_fault_marker(
            &self.session_dir,
            &format!("metadata journal durability failure: {message}"),
            self.committed.load(Ordering::Acquire),
        );
        let _ = self.writer_tx.try_send(WriterMessage::FaultAndStop(format!(
            "metadata journal durability failure: {message}"
        )));
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

    fn stop(&mut self) -> Result<Value> {
        if self.capture_stopped {
            bail!("recording capture resources are already stopped");
        }
        let mut warnings = Vec::<String>::new();
        if !self.stop_requested {
            if let Some(stream) = self.stream.take() {
                // Pause first, then close the callback-entry gate. A callback
                // that entered before pause holds a lease from its first line;
                // close_and_wait therefore waits through conversion and queueing.
                let _ = stream.pause();
                drop(stream);
            }
            self.telemetry_stop.store(true, Ordering::Release);
            if let Some(join) = self.telemetry_join.take() {
                let _ = join.join();
            }
            self.writer_queue.close_and_wait();
            let captured = self.settle_captured_samples();
            if let Err(error) = self.wait_until_committed(captured) {
                warnings.push(format!("audio checkpoint failed while stopping: {error:#}"));
                self.faulted.store(true, Ordering::Release);
            }
            let (reply_tx, reply_rx) = bounded(1);
            self.stop_requested = true;
            match self.writer_tx.send(WriterMessage::Stop(reply_tx)) {
                Ok(()) => match reply_rx.recv_timeout(WRITER_STOP_TIMEOUT) {
                    Ok(Ok(value)) => self.committed.store(value, Ordering::Release),
                    Ok(Err(message)) => {
                        warnings.push(format!("audio writer could not finalize: {message}"));
                        self.faulted.store(true, Ordering::Release);
                    }
                    Err(error) => {
                        warnings.push(format!("audio writer stop timed out: {error}"));
                        self.faulted.store(true, Ordering::Release);
                    }
                },
                Err(error) => {
                    warnings.push(format!("audio writer was already unavailable: {error}"));
                    self.faulted.store(true, Ordering::Release);
                }
            }
        }

        let mut writer_exited = self.writer_join.is_none();
        if let Some(join) = self.writer_join.as_ref() {
            let join_deadline = Instant::now() + WRITER_JOIN_TIMEOUT;
            while !join.is_finished() && Instant::now() < join_deadline {
                thread::sleep(Duration::from_millis(20));
            }
            if join.is_finished() {
                let join = self.writer_join.take().expect("writer handle disappeared");
                if join.join().is_err() {
                    warnings.push("audio writer panicked".to_string());
                    self.faulted.store(true, Ordering::Release);
                }
                writer_exited = true;
            } else {
                let message = "audio writer is still sealing data after the safety timeout";
                warnings.push(message.to_string());
                self.faulted.store(true, Ordering::Release);
                persist_audio_fault_marker(
                    &self.session_dir,
                    message,
                    self.committed.load(Ordering::Acquire),
                );
            }
        }
        self.capture_stopped = writer_exited;
        if !writer_exited {
            bail!(
                "音频仍在安全封存，任务锁和写入线程已保留；请稍后重试“结束录制”，不要强制结束进程。"
            );
        }
        let committed = self.committed.load(Ordering::Acquire);
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
    let marker = session_dir.join(AUDIO_FAULT_MARKER);
    let value = json!({
        "reason": reason,
        "committed_frames": committed_frames,
        "timestamp": Utc::now().to_rfc3339(),
    });
    if let Err(error) = atomic_json(&marker, &value) {
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

fn writer_storage_check_due(storage_directory: &Path, last_checkpoint: Instant) -> bool {
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
    last_checkpoint.elapsed() >= Duration::from_secs(1)
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
    committed: Arc<AtomicU64>,
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
    let mut consecutive_storage_check_failures = 0u8;
    let mut shutdown_after_drain = false;
    let mut pending_stop_reply = None::<Sender<Result<u64, String>>>;
    let mut latched_fault_reason = None::<String>;
    let export_busy = Arc::new(AtomicBool::new(false));
    while let Ok(message) = receiver.recv() {
        match message {
            WriterMessage::Samples(samples) => {
                queue.release(samples.len() as u64);
                if let Err(error) = writer.write_samples(&samples) {
                    let message = format!("audio write failed: {error:#}");
                    eprintln!("{message}");
                    faulted.store(true, Ordering::Release);
                    latch_audio_fault_marker(
                        storage_directory,
                        &mut latched_fault_reason,
                        &message,
                        committed.load(Ordering::Acquire),
                    );
                    if let Ok(frames) = writer.checkpoint() {
                        committed.store(frames, Ordering::Release);
                    }
                    latch_audio_fault_marker(
                        storage_directory,
                        &mut latched_fault_reason,
                        &message,
                        committed.load(Ordering::Acquire),
                    );
                    if let Some(reply) = pending_stop_reply.take() {
                        let _ = reply.send(Err(message));
                    }
                    break;
                }
                let _ = waveform.try_send(waveform_bins(&samples));
                let mut fault_stop_reason = None::<String>;
                if !shutdown_after_drain
                    && writer_storage_check_due(storage_directory, last_checkpoint)
                {
                    match writer.checkpoint() {
                        Ok(frames) => {
                            committed.store(frames, Ordering::Release);
                            match check_writer_storage(storage_directory, sample_rate, 1, bit_depth)
                            {
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
                        }
                        Err(error) => {
                            fault_stop_reason = Some(format!("audio checkpoint failed: {error:#}"));
                        }
                    }
                    last_checkpoint = Instant::now();
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
                    Ok(frames) => committed.store(*frames, Ordering::Release),
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

fn select_config(
    device: &Device,
    sample_rate: u32,
    input_channel_index: usize,
) -> Result<SupportedStreamConfig> {
    let mut selected: Option<(u8, SupportedStreamConfig)> = None;
    let mut compatible_rates = Vec::<(u32, u32)>::new();
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
            // Register the callback before doing any conversion or metering.
            // A clean stop closes this gate and waits for every callback that
            // already entered it, so a callback descheduled during conversion
            // cannot silently lose the device's final buffer.
            let Some(enqueue_lease) = queue.enter() else {
                return;
            };
            let mono = convert_frames(data, channels, input_channel_index, convert);
            publish_leased_block(
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
            );
        },
        move |error| {
            error_queue.close_and_wait();
            error_emitter.store(true, Ordering::Release);
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
) -> Vec<f32> {
    if channels == 0 || input_channel_index >= channels {
        return Vec::new();
    }
    input
        .chunks_exact(channels)
        .map(|frame| convert(frame[input_channel_index]).clamp(-1.0, 1.0))
        .collect()
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
    let Some(enqueue_lease) = queue.enter() else {
        if overflow.load(Ordering::Acquire) > 0 {
            overflow.fetch_add(frames, Ordering::Release);
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
        overflow.fetch_add(frames, Ordering::Release);
        faulted.store(true, Ordering::Release);
        drop(enqueue_lease);
        queue.close_and_wait();
        let _ = writer.try_send(WriterMessage::FaultAndStop(
            "audio writer queue exceeded its 20 second frame budget".to_string(),
        ));
        return;
    }
    if writer.try_send(WriterMessage::Samples(mono)).is_err() {
        queue.release(frames);
        overflow.fetch_add(frames, Ordering::Release);
        faulted.store(true, Ordering::Release);
        drop(enqueue_lease);
        queue.close_and_wait();
        return;
    }
    // The global timeline advances only after the complete block has entered
    // the writer queue. Once enqueueing fails, later callbacks are rejected so
    // physical WAV frames and all sample-based annotations cannot diverge.
    let block_start = captured.fetch_add(frames, Ordering::Release);
    let block_end = block_start + frames;
    let threshold_dbfs = f32::from_bits(silence.threshold_bits.load(Ordering::Relaxed));
    let threshold_linear = 10f32.powf(threshold_dbfs / 20.0);
    if rms <= threshold_linear {
        silence.silence_samples.fetch_add(frames, Ordering::Release);
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
        let rollback = if fault == JournalAppendFault::DuringWriteAndRollback {
            Err(anyhow!("injected journal rollback failure"))
        } else {
            (|| -> Result<()> {
                events.set_len(original_len)?;
                events.sync_all()?;
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
    let temporary = path.with_extension("tmp");
    let previous = path.with_extension("prev");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.flush()?;
    file.sync_all()?;

    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            bail!("snapshot path {} is not a regular file", path.display());
        }
        Ok(_) if snapshot_file_is_valid(path) => {
            // Rotate the last known-good generation without copying it. If the
            // process dies between the two renames, recovery can use `prev` or
            // the already-synced `tmp` generation.
            durable_replace(path, &previous)?;
        }
        Ok(_) => {
            // Do not overwrite a known-good previous generation with a corrupt
            // final file. The synced temporary will replace the bad final.
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    durable_replace(&temporary, path)?;
    Ok(())
}

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension("tmp");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.flush()?;
    file.sync_all()?;
    durable_replace(&temporary, path)?;
    Ok(())
}

fn atomic_json_line(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension("compact.tmp");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.flush()?;
    file.sync_all()?;
    durable_replace(&temporary, path)?;
    Ok(())
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
    let upper = sanitized.to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (upper.len() == 4
            && (upper.starts_with("COM") || upper.starts_with("LPT"))
            && matches!(upper.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        sanitized.insert(0, '_');
    }
    sanitized
}

fn remove_stale_sentence_wavs(
    directory: &Path,
    expected_file_names: &std::collections::HashSet<String>,
) -> Result<()> {
    let mut removed_any = false;
    for entry in std::fs::read_dir(directory)
        .with_context(|| format!("inspect sentence exports {}", directory.display()))?
    {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if !file_name.to_ascii_lowercase().ends_with(".wav")
            || expected_file_names.contains(&file_name.to_ascii_lowercase())
        {
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

fn create_unique_export_temp(path: &Path, operation: &str) -> Result<(PathBuf, File)> {
    let file_name = path
        .file_name()
        .context("export destination has no file name")?;
    let timestamp = Utc::now().timestamp_micros();
    for _ in 0..128 {
        let sequence = EXPORT_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
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
                    .with_context(|| format!("create temporary export {}", temporary.display()));
            }
        }
    }
    bail!("could not allocate a unique temporary export file")
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
    let (temporary, mut file) = create_unique_export_temp(path, "csv")?;
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
    if result.is_err()
        && let Ok(metadata) = std::fs::symlink_metadata(&temporary)
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        let _ = std::fs::remove_file(&temporary);
    }
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
        let writer_committed = Arc::clone(&committed);
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
                writer_committed,
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
            telemetry_stop: Arc::new(AtomicBool::new(false)),
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

    #[test]
    fn file_names_are_safe_and_stable() {
        assert_eq!(safe_file_name("abc-01_x"), "abc-01_x");
        assert_eq!(safe_file_name("中文 / 01"), "中文 _ 01");
        assert_eq!(safe_file_name("///"), "___");
        assert_eq!(safe_file_name("CON"), "_CON");
        assert_eq!(safe_file_name("hello. "), "hello");
    }

    #[test]
    fn frame_conversion_selects_requested_channel() {
        assert_eq!(
            convert_frames(&[1i16, 2, 3, 4], 2, 0, |sample| f32::from(sample) / 4.0),
            vec![0.25, 0.75]
        );
        assert_eq!(
            convert_frames(&[1i16, 2, 3, 4], 2, 1, |sample| f32::from(sample) / 4.0),
            vec![0.5, 1.0]
        );
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
    fn storage_critical_drains_every_preaccepted_sample_and_marks_the_session() {
        assert_storage_fault_drains_backlog(
            "storage-critical-drain",
            vec![WriterStorageCheckOverride::Critical],
            "before exhausting disk space",
        );
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
    fn writer_advances_durable_watermark_only_after_sync() {
        let root = test_root("durable-watermark");
        let path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(4);
        let committed = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
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
                committed_thread,
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
    fn stop_waits_for_a_callback_that_enqueues_samples_after_the_stop_message() {
        let root = test_root("stop-waits-for-late-callback");
        let path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let committed = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let queue = test_writer_queue();
        let (ready_tx, ready_rx) = bounded(1);
        let writer_path = path.clone();
        let writer_storage_dir = root.clone();
        let writer_committed = Arc::clone(&committed);
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
                writer_committed,
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
                MasterStorageKind::LegacySingleWav,
                48_000 * STORAGE_LAYOUT_V1_DEFAULT_SEGMENT_SECONDS,
                &writer_storage_dir,
                writer_committed,
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
        writer_tx
            .send(WriterMessage::FaultAndStop(
                "injected device disconnect".to_string(),
            ))
            .unwrap();
        join.join().unwrap();

        assert!(faulted.load(Ordering::Acquire));
        assert_eq!(committed.load(Ordering::Acquire), 4);
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
                writer_committed,
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
        let committed = Arc::new(AtomicU64::new(0));
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
        let writer_committed = Arc::clone(&committed);
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
                writer_committed,
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

        let captured = AtomicU64::new(3);
        let overflow = AtomicU64::new(0);
        let peak = AtomicU32::new(0f32.to_bits());
        let rms = AtomicU32::new(0f32.to_bits());
        let silence = SilenceMonitor {
            silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            threshold_bits: Arc::new(AtomicU32::new((-42.0f32).to_bits())),
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
        assert_eq!(&rendered[44..], &master[44..53]);
        let _ = std::fs::remove_dir_all(root);
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
        let writer_committed = Arc::clone(&committed);
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
                writer_committed,
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
            telemetry_stop: Arc::new(AtomicBool::new(false)),
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
        let writer_committed = Arc::clone(&committed);
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
                writer_committed,
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
            telemetry_stop: Arc::new(AtomicBool::new(false)),
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
        assert!(root.join("export/metadata.csv").is_file());
        assert!(!root.join("export/sentences/stale.wav").exists());
        let status: Value =
            serde_json::from_slice(&std::fs::read(root.join("export/status.json")).unwrap())
                .unwrap();
        assert_eq!(status["status"], "complete");
        assert!(
            status["export_id"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
        );
        assert!(
            result["recovery_warnings"]
                .as_array()
                .is_some_and(|warnings| !warnings.is_empty())
        );
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

        assert!(session.stop().is_err());
        assert!(session.writer_join.is_some());
        assert!(!session.capture_stopped);
        assert!(SessionLock::acquire(&root, "2026-08-11T00:00:01Z").is_err());

        assert!(session.stop().is_err());
        assert!(session.writer_join.is_some());
        assert!(!session.capture_stopped);
        release_tx.send(()).unwrap();

        let stopped = session.stop().unwrap();
        assert_eq!(stopped["snapshot"]["status"], "faulted");
        assert!(session.writer_join.is_none());
        assert!(session.capture_stopped);
        assert!(SessionLock::acquire(&root, "2026-08-11T00:00:02Z").is_err());

        drop(session);
        let reopened = SessionLock::acquire(&root, "2026-08-11T00:00:03Z").unwrap();
        drop(reopened);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn activation_failure_cleanup_joins_telemetry_and_finalizes_writer() {
        let root = test_root("activation-failure-cleanup");
        std::fs::create_dir_all(root.join("audio")).unwrap();
        let master_path = root.join("audio/master.wav");
        let (writer_tx, writer_rx) = unbounded::<WriterMessage>();
        let committed = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = bounded(1);
        let writer_committed = Arc::clone(&committed);
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
                writer_committed,
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
            telemetry_stop,
            captured: Arc::new(AtomicU64::new(1)),
            committed,
            overflow: Arc::new(AtomicU64::new(0)),
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

        let warnings = session.cleanup_after_activation_failure();

        assert!(warnings.is_empty(), "{warnings:?}");
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
}
