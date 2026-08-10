use crate::protocol::Emitter;
use crate::wav::{RecoverableWav, WavEncoding, slice_wav_mono};
use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    Device, SampleFormat, SampleRate, SizedSample, Stream, StreamConfig, SupportedStreamConfig,
};
use crossbeam_channel::{Receiver, Sender, bounded};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

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
    pub session_id: String,
    #[serde(default)]
    pub script_name: String,
    pub status: String,
    pub device_name: String,
    pub audio_format: AudioFormat,
    pub master_audio: String,
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

enum WriterMessage {
    Samples(Vec<f32>),
    Checkpoint(Sender<Result<u64, String>>),
    Stop(Sender<Result<u64, String>>),
}

pub struct RecordingSession {
    session_dir: PathBuf,
    master_path: PathBuf,
    snapshot: SessionSnapshot,
    stream: Option<Stream>,
    writer_tx: Sender<WriterMessage>,
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
        let default_name = host
            .default_input_device()
            .and_then(|device| device.name().ok());
        let mut devices = Vec::new();
        for device in host.input_devices().context("enumerate input devices")? {
            let name = device
                .name()
                .unwrap_or_else(|_| "Unknown input".to_string());
            let mut rates = Vec::<u32>::new();
            let mut input_channels = Vec::<u16>::new();
            let mut configurations = Vec::<Value>::new();
            if let Ok(configs) = device.supported_input_configs() {
                for config in configs {
                    if !is_supported_input_format(config.sample_format()) {
                        continue;
                    }
                    input_channels.push(config.channels());
                    rates.push(config.min_sample_rate().0);
                    rates.push(config.max_sample_rate().0);
                    configurations.push(json!({
                        "min_sample_rate": config.min_sample_rate().0,
                        "max_sample_rate": config.max_sample_rate().0,
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
            devices.push(json!({
                "name": name,
                "is_default": default_name.as_deref() == Some(name.as_str()),
                "sample_rates": rates,
                "input_channels": input_channels,
                "configurations": configurations,
            }));
        }
        Ok(json!({ "devices": devices, "default_device_name": default_name }))
    }

    pub fn start_session(&mut self, payload: StartSessionPayload) -> Result<Value> {
        if self.session.is_some() {
            bail!("当前已有录制进行中");
        }
        if payload.items.is_empty() {
            bail!("script contains no items");
        }
        let output_encoding = WavEncoding::for_bit_depth(payload.bit_depth)?;
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

        let host = cpal::default_host();
        let device = select_device(&host, payload.device_name.as_deref())?;
        let device_name = device
            .name()
            .unwrap_or_else(|_| "Unknown input".to_string());
        let input_channel_index = usize::from(payload.input_channel - 1);
        let supported = select_config(&device, payload.sample_rate, input_channel_index)?;
        let input_channels = supported.channels();
        let sample_format = supported.sample_format();
        let config = StreamConfig {
            channels: input_channels,
            sample_rate: SampleRate(payload.sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        let master_path = session_dir.join("audio/master.wav");
        let (writer_tx, writer_rx) = bounded::<WriterMessage>(256);
        let captured = Arc::new(AtomicU64::new(0));
        let committed = Arc::new(AtomicU64::new(0));
        let overflow = Arc::new(AtomicU64::new(0));
        let faulted = Arc::new(AtomicBool::new(false));
        let peak_bits = Arc::new(AtomicU32::new(0f32.to_bits()));
        let rms_bits = Arc::new(AtomicU32::new(0f32.to_bits()));
        let silence_samples = Arc::new(AtomicU64::new(0));
        let last_signal_sample = Arc::new(AtomicU64::new(0));
        let attempt_signal_start_sample = Arc::new(AtomicU64::new(0));
        let silence_threshold_bits =
            Arc::new(AtomicU32::new(payload.silence_threshold_dbfs.to_bits()));
        let (waveform_tx, waveform_rx) = bounded::<Vec<[f32; 2]>>(128);
        let telemetry_stop = Arc::new(AtomicBool::new(false));

        let writer_committed = Arc::clone(&committed);
        let writer_path = master_path.clone();
        let sample_rate = payload.sample_rate;
        let bit_depth = payload.bit_depth;
        let (writer_ready_tx, writer_ready_rx) = bounded(1);
        let writer_faulted = Arc::clone(&faulted);
        let writer_join = thread::Builder::new()
            .name("audio-writer".to_string())
            .spawn(move || {
                writer_loop(
                    writer_rx,
                    &writer_path,
                    sample_rate,
                    bit_depth,
                    writer_committed,
                    writer_faulted,
                    writer_ready_tx,
                )
            })?;
        match writer_ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {}
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
            SilenceMonitor {
                silence_samples: Arc::clone(&silence_samples),
                last_signal_sample: Arc::clone(&last_signal_sample),
                attempt_signal_start_sample: Arc::clone(&attempt_signal_start_sample),
                threshold_bits: Arc::clone(&silence_threshold_bits),
            },
            waveform_tx,
        )?;
        stream.play().context("start input stream")?;

        let emitter = self.emitter.clone();
        let telemetry_stop_thread = Arc::clone(&telemetry_stop);
        let captured_thread = Arc::clone(&captured);
        let committed_thread = Arc::clone(&committed);
        let overflow_thread = Arc::clone(&overflow);
        let faulted_thread = Arc::clone(&faulted);
        let peak_thread = Arc::clone(&peak_bits);
        let rms_thread = Arc::clone(&rms_bits);
        let silence_samples_thread = Arc::clone(&silence_samples);
        let last_signal_sample_thread = Arc::clone(&last_signal_sample);
        let silence_threshold_thread = Arc::clone(&silence_threshold_bits);
        let silence_duration_ms = payload.silence_duration_ms;
        let telemetry_join =
            thread::Builder::new()
                .name("telemetry".to_string())
                .spawn(move || {
                    while !telemetry_stop_thread.load(Ordering::Acquire) {
                        let mut waveform = Vec::<[f32; 2]>::new();
                        while let Ok(block) = waveform_rx.try_recv() {
                            waveform.extend(block);
                            if waveform.len() > 2_048 {
                                let discard = waveform.len() - 2_048;
                                waveform.drain(..discard);
                            }
                        }
                        emitter.event(
                            "meter",
                            json!({
                                "captured_samples": captured_thread.load(Ordering::Acquire),
                                "committed_samples": committed_thread.load(Ordering::Acquire),
                                "overflow_samples": overflow_thread.load(Ordering::Acquire),
                                "faulted": faulted_thread.load(Ordering::Acquire),
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

        let now = Utc::now().to_rfc3339();
        let snapshot = SessionSnapshot {
            schema_version: 1,
            session_id: payload.session_id,
            script_name: payload.script_name,
            status: "recording".to_string(),
            device_name: device_name.clone(),
            audio_format: AudioFormat {
                sample_rate: payload.sample_rate,
                bit_depth: payload.bit_depth,
                encoding: output_encoding.name().to_string(),
                channels: 1,
                input_channels,
                input_channel: payload.input_channel,
            },
            master_audio: "audio/master.wav".to_string(),
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

        let mut session = RecordingSession {
            session_dir,
            master_path,
            snapshot,
            stream: Some(stream),
            writer_tx,
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
        };
        session.persist(
            "session_started",
            json!({
                "device_name": device_name,
                "sample_rate": payload.sample_rate,
                "bit_depth": payload.bit_depth,
                "encoding": output_encoding.name(),
                "input_channel": payload.input_channel,
                "silence_duration_ms": payload.silence_duration_ms,
                "silence_threshold_dbfs": payload.silence_threshold_dbfs,
            }),
        )?;
        let result = json!({ "snapshot": session.snapshot, "session_dir": session.session_dir });
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
        let attempt_id = format!("{}-a{}", safe_file_name(item_id), item.attempts.len() + 1);
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
        let active = session
            .active_attempt
            .as_ref()
            .cloned()
            .ok_or_else(|| anyhow!("no attempt is recording"))?;
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
        let item = session
            .snapshot
            .items
            .iter_mut()
            .find(|item| item.id == item_id)
            .ok_or_else(|| anyhow!("unknown item id {item_id}"))?;
        if !item.attempts.iter().any(|a| a.attempt_id == attempt_id) {
            bail!("unknown attempt id {attempt_id}");
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
        session.checkpoint()?;
        let attempt = session
            .snapshot
            .items
            .iter()
            .find(|item| item.id == item_id)
            .and_then(|item| item.attempts.iter().find(|a| a.attempt_id == attempt_id))
            .cloned()
            .ok_or_else(|| anyhow!("attempt not found"))?;
        let destination = session
            .session_dir
            .join("preview")
            .join(format!("{}.wav", safe_file_name(attempt_id)));
        slice_wav_mono(
            &session.master_path,
            &destination,
            session.snapshot.audio_format.sample_rate,
            session.snapshot.audio_format.bit_depth,
            attempt.start_sample,
            attempt.end_sample,
        )?;
        Ok(json!({ "file_path": destination }))
    }

    pub fn get_state(&self) -> Result<Value> {
        let session = self
            .session
            .as_ref()
            .ok_or_else(|| anyhow!("当前没有进行中的录制"))?;
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

    pub fn stop_session(&mut self) -> Result<Value> {
        let session = self
            .session
            .as_mut()
            .ok_or_else(|| anyhow!("当前没有进行中的录制"))?;
        if session.active_attempt.is_some() {
            bail!("请先结束当前句，再结束整次录制");
        }
        let result = session.stop()?;
        self.session.take();
        Ok(result)
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
        let snapshot_path = metadata_dir.join("items.snapshot.json");
        let snapshot_metadata = std::fs::symlink_metadata(&snapshot_path)
            .with_context(|| format!("inspect {}", snapshot_path.display()))?;
        if !snapshot_metadata.is_file() || snapshot_metadata.file_type().is_symlink() {
            bail!("recording snapshot must be a regular file");
        }
        let snapshot: SessionSnapshot = serde_json::from_slice(
            &std::fs::read(&snapshot_path)
                .with_context(|| format!("read {}", snapshot_path.display()))?,
        )?;
        let master_relative = Path::new(&snapshot.master_audio);
        if master_relative != Path::new("audio/master.wav")
            || master_relative.is_absolute()
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
            .with_context(|| format!("inspect source WAV {}", source.display()))?;
        if !source_metadata.is_file() || source_metadata.file_type().is_symlink() {
            bail!("recording source WAV must be a regular file");
        }
        let sentences_dir = export_dir.join("sentences");
        match std::fs::symlink_metadata(&sentences_dir) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => bail!("recording sentence export path must be a real directory"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&sentences_dir)?;
            }
            Err(error) => return Err(error.into()),
        }
        let master_output = export_dir.join("full-track.wav");
        std::fs::copy(&source, &master_output).with_context(|| {
            format!(
                "copy full-track WAV from {} to {}",
                source.display(),
                master_output.display()
            )
        })?;
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
            slice_wav_mono(
                &source,
                &output,
                snapshot.audio_format.sample_rate,
                snapshot.audio_format.bit_depth,
                attempt.start_sample,
                attempt.end_sample,
            )?;
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
        let metadata = json!({
            "schema_version": 1,
            "session_id": snapshot.session_id,
            "script_name": snapshot.script_name,
            "audio_format": snapshot.audio_format,
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
        Ok(json!({
            "export_dir": export_dir,
            "master_file": master_output,
            "sentences_dir": sentences_dir,
            "exported_count": metadata["exported"].as_array().map_or(0, Vec::len),
            "skipped_count": metadata["skipped"].as_array().map_or(0, Vec::len),
        }))
    }

    pub fn shutdown(&mut self) {
        if let Some(mut session) = self.session.take() {
            if session.active_attempt.is_some() {
                session.active_attempt = None;
            }
            let _ = session.stop();
        }
    }

    fn active_session_mut(&mut self) -> Result<&mut RecordingSession> {
        self.session
            .as_mut()
            .ok_or_else(|| anyhow!("当前没有进行中的录制"))
    }
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
            .recv_timeout(Duration::from_secs(5))
            .context("audio writer checkpoint timed out")?
            .map_err(|message| anyhow!(message))?;
        self.committed.store(committed, Ordering::Release);
        Ok(committed)
    }

    fn wait_until_committed(&mut self, target: u64) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(3);
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

    fn persist(&mut self, event: &str, payload: Value) -> Result<()> {
        self.snapshot = self.live_snapshot();
        let event_value = json!({
            "event": event,
            "at": Utc::now().to_rfc3339(),
            "payload": payload,
            "captured_samples": self.snapshot.captured_samples,
            "committed_samples": self.snapshot.committed_samples,
        });
        let event_path = self.session_dir.join("metadata/events.jsonl");
        let mut events = OpenOptions::new()
            .create(true)
            .append(true)
            .open(event_path)?;
        serde_json::to_writer(&mut events, &event_value)?;
        events.write_all(b"\n")?;
        events.flush()?;
        events.sync_data()?;
        atomic_json(
            &self.session_dir.join("metadata/items.snapshot.json"),
            &self.snapshot,
        )?;
        atomic_json(
            &self.session_dir.join("script/normalized.json"),
            &self.snapshot.items,
        )?;
        atomic_json(
            &self.session_dir.join("session.json"),
            &json!({
                "schema_version": self.snapshot.schema_version,
                "session_id": self.snapshot.session_id,
                "script_name": self.snapshot.script_name,
                "status": self.snapshot.status,
                "device_name": self.snapshot.device_name,
                "audio_format": self.snapshot.audio_format,
                "silence_duration_ms": self.snapshot.silence_duration_ms,
                "silence_threshold_dbfs": self.snapshot.silence_threshold_dbfs,
                "started_at": self.snapshot.started_at,
                "updated_at": self.snapshot.updated_at,
            }),
        )?;
        Ok(())
    }

    fn stop(&mut self) -> Result<Value> {
        let mut warnings = Vec::<String>::new();
        if let Some(stream) = self.stream.take() {
            // Some platform backends can still be inside the final callback when
            // the stream handle is dropped. Pause first and wait until the
            // captured counter is stable so WriterMessage::Stop cannot overtake
            // a late audio block from another sender.
            let _ = stream.pause();
            drop(stream);
        }
        self.telemetry_stop.store(true, Ordering::Release);
        if let Some(join) = self.telemetry_join.take() {
            let _ = join.join();
        }
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
        if let Err(error) = self.wait_until_committed(captured) {
            warnings.push(format!("audio checkpoint failed while stopping: {error:#}"));
            self.faulted.store(true, Ordering::Release);
        }
        let mut committed = self.committed.load(Ordering::Acquire);
        let (reply_tx, reply_rx) = bounded(1);
        match self.writer_tx.send(WriterMessage::Stop(reply_tx)) {
            Ok(()) => match reply_rx.recv_timeout(Duration::from_secs(10)) {
                Ok(Ok(value)) => committed = value,
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
        self.committed.store(committed, Ordering::Release);
        if let Some(join) = self.writer_join.take() {
            let join_deadline = Instant::now() + Duration::from_secs(2);
            while !join.is_finished() && Instant::now() < join_deadline {
                thread::sleep(Duration::from_millis(20));
            }
            if join.is_finished() {
                if join.join().is_err() {
                    warnings.push("audio writer panicked".to_string());
                    self.faulted.store(true, Ordering::Release);
                }
            } else {
                warnings.push("audio writer did not exit before the safety timeout".to_string());
                self.faulted.store(true, Ordering::Release);
                // Dropping a JoinHandle detaches the blocked writer so the UI can
                // still close the recording and preserve the last durable snapshot.
                drop(join);
            }
        }
        self.snapshot.status = if self.faulted.load(Ordering::Acquire) {
            "faulted".to_string()
        } else {
            "stopped".to_string()
        };
        self.persist("session_stopped", json!({ "committed_samples": committed }))?;
        Ok(json!({
            "session_dir": self.session_dir,
            "snapshot": self.snapshot,
            "warnings": warnings,
        }))
    }
}

fn writer_loop(
    receiver: Receiver<WriterMessage>,
    path: &Path,
    sample_rate: u32,
    bit_depth: u16,
    committed: Arc<AtomicU64>,
    faulted: Arc<AtomicBool>,
    ready: Sender<Result<(), String>>,
) {
    let mut writer = match RecoverableWav::create(path, sample_rate, 1, bit_depth) {
        Ok(writer) => {
            let _ = ready.send(Ok(()));
            writer
        }
        Err(error) => {
            eprintln!("audio writer initialization failed: {error:#}");
            faulted.store(true, Ordering::Release);
            let _ = ready.send(Err(format!(
                "audio writer initialization failed: {error:#}"
            )));
            return;
        }
    };
    let mut last_checkpoint = Instant::now();
    while let Ok(message) = receiver.recv() {
        match message {
            WriterMessage::Samples(samples) => {
                if let Err(error) = writer.write_samples(&samples) {
                    eprintln!("audio write failed: {error:#}");
                    faulted.store(true, Ordering::Release);
                    let _ = writer.checkpoint();
                    break;
                }
                committed.fetch_add(samples.len() as u64, Ordering::Release);
                if last_checkpoint.elapsed() >= Duration::from_secs(1) {
                    if let Err(error) = writer.checkpoint() {
                        eprintln!("audio checkpoint failed: {error:#}");
                        faulted.store(true, Ordering::Release);
                    }
                    last_checkpoint = Instant::now();
                }
            }
            WriterMessage::Checkpoint(reply) => {
                let result = writer.checkpoint().map_err(|error| format!("{error:#}"));
                if result.is_err() {
                    faulted.store(true, Ordering::Release);
                }
                let _ = reply.send(result);
            }
            WriterMessage::Stop(reply) => {
                let result = writer.finalize().map_err(|error| format!("{error:#}"));
                if result.is_err() {
                    faulted.store(true, Ordering::Release);
                }
                let _ = reply.send(result);
                break;
            }
        }
    }
}

fn select_device(host: &cpal::Host, requested: Option<&str>) -> Result<Device> {
    if let Some(requested) = requested {
        for device in host.input_devices().context("enumerate input devices")? {
            if device.name().ok().as_deref() == Some(requested) {
                return Ok(device);
            }
        }
        bail!("input device not found: {requested}");
    }
    host.default_input_device()
        .ok_or_else(|| anyhow!("no default input device is available"))
}

fn is_supported_input_format(format: SampleFormat) -> bool {
    matches!(
        format,
        SampleFormat::I8
            | SampleFormat::I16
            | SampleFormat::I32
            | SampleFormat::I64
            | SampleFormat::U8
            | SampleFormat::U16
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
        SampleFormat::F32 => 10,
        SampleFormat::I32 => 9,
        SampleFormat::F64 => 8,
        SampleFormat::I64 => 7,
        SampleFormat::I16 => 6,
        SampleFormat::U32 => 5,
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
        compatible_rates.push((range.min_sample_rate().0, range.max_sample_rate().0));
        if sample_rate < range.min_sample_rate().0 || sample_rate > range.max_sample_rate().0 {
            continue;
        }
        let score = input_format_score(range.sample_format());
        let config = range.with_sample_rate(SampleRate(sample_rate));
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
    silence: SilenceMonitor,
    waveform: Sender<Vec<[f32; 2]>>,
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
            silence.clone(),
            waveform,
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
            silence.clone(),
            waveform,
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
            silence.clone(),
            waveform,
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
            silence.clone(),
            waveform,
            |sample| f32::from(sample) / 32_768.0,
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
            silence.clone(),
            waveform,
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
            silence.clone(),
            waveform,
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
            silence.clone(),
            waveform,
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
            silence.clone(),
            waveform,
            |sample| (f32::from(sample) - 32_768.0) / 32_768.0,
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
            silence.clone(),
            waveform,
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
            silence,
            waveform,
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
    silence: SilenceMonitor,
    waveform: Sender<Vec<[f32; 2]>>,
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
    Ok(device.build_input_stream(
        config,
        move |data: &[T], _| {
            let mono = convert_frames(data, channels, input_channel_index, convert);
            publish_block(
                mono, &writer, &captured, &overflow, &faulted, &peak_bits, &rms_bits, &silence,
                &waveform,
            );
        },
        move |error| {
            error_emitter.store(true, Ordering::Release);
            eprintln!("audio stream error: {error}");
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

#[allow(clippy::too_many_arguments)]
fn publish_block(
    mono: Vec<f32>,
    writer: &Sender<WriterMessage>,
    captured: &AtomicU64,
    overflow: &AtomicU64,
    faulted: &AtomicBool,
    peak_bits: &AtomicU32,
    rms_bits: &AtomicU32,
    silence: &SilenceMonitor,
    waveform: &Sender<Vec<[f32; 2]>>,
) {
    let frames = mono.len() as u64;
    let block_start = captured.fetch_add(frames, Ordering::Release);
    let block_end = block_start + frames;
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
    let _ = waveform.try_send(waveform_bins(&mono));
    if writer.try_send(WriterMessage::Samples(mono)).is_err() {
        overflow.fetch_add(frames, Ordering::Release);
        faulted.store(true, Ordering::Release);
    }
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

fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension("tmp");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.flush()?;
    file.sync_all()?;
    std::fs::rename(&temporary, path)?;
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

fn write_csv(path: &Path, exported: &Value) -> Result<()> {
    let mut file = File::create(path)?;
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
    Ok(())
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
