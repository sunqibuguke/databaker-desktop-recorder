//! Streaming AI VAD used as a drop-in speech/non-speech classifier.
//!
//! Inference stays off the capture callback. The callback only forwards PCM;
//! this module resamples to 16 kHz, scores 16 ms frames, and publishes the
//! same attempt annotations the energy gate uses.

use crate::attempt::{HeadSilenceMonitor, annotate_attempt_block, begin_analysis_write};
use crossbeam_channel::{Receiver, Sender, TryRecvError, select_biased};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Instant;

pub(crate) const VAD_SAMPLE_RATE: u32 = 16_000;
pub(crate) const VAD_FRAME_SAMPLES: usize = 256;
pub(crate) const DETECTOR_ENERGY: u32 = 0;
pub(crate) const DETECTOR_VAD: u32 = 1;

pub(crate) const VAD_QUEUE_AUDIO_MILLIS: u64 = 1_000;
pub(crate) const VAD_QUEUE_MAX_BLOCKS: u64 = 1_024;
pub(crate) const VAD_QUEUE_LAGGING_MILLIS: u64 = 500;

pub(crate) const VAD_HEALTH_HEALTHY: u32 = 0;
pub(crate) const VAD_HEALTH_DEGRADED: u32 = 2;
pub(crate) const VAD_HEALTH_UNAVAILABLE: u32 = 3;

pub(crate) const VAD_ISSUE_NONE: u32 = 0;
pub(crate) const VAD_ISSUE_QUEUE_OVERFLOW: u32 = 1;
pub(crate) const VAD_ISSUE_CLASSIFIER_FAILURE: u32 = 2;
pub(crate) const VAD_ISSUE_FLUSH_TIMEOUT: u32 = 3;
pub(crate) const VAD_ISSUE_WORKER_DISCONNECTED: u32 = 4;

pub(crate) struct VadAnalysisBlock {
    pub(crate) samples: Vec<f32>,
    pub(crate) block_start: u64,
    pub(crate) block_end: u64,
    pub(crate) generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VadFlushOutcome {
    Complete,
    Degraded(u32),
    Timeout,
}

pub(crate) enum VadControlMessage {
    Flush {
        generation: u64,
        target_sample: u64,
        deadline: Instant,
        done: Sender<VadFlushOutcome>,
    },
    Reset {
        generation: u64,
        boundary: u64,
        done: Sender<Result<(), String>>,
    },
    Shutdown {
        done: Sender<()>,
    },
}

#[derive(Clone)]
pub(crate) struct VadQueueBudget {
    queued_samples: Arc<AtomicU64>,
    queued_blocks: Arc<AtomicU64>,
    high_water_samples: Arc<AtomicU64>,
    max_samples: u64,
    max_blocks: u64,
}

impl VadQueueBudget {
    pub(crate) fn new(sample_rate: u32) -> Self {
        Self {
            queued_samples: Arc::new(AtomicU64::new(0)),
            queued_blocks: Arc::new(AtomicU64::new(0)),
            high_water_samples: Arc::new(AtomicU64::new(0)),
            max_samples: u64::from(sample_rate).saturating_mul(VAD_QUEUE_AUDIO_MILLIS) / 1_000,
            max_blocks: VAD_QUEUE_MAX_BLOCKS,
        }
    }

    pub(crate) fn try_reserve(&self, samples: u64) -> bool {
        if samples == 0 || samples > self.max_samples {
            return false;
        }
        let mut blocks = self.queued_blocks.load(Ordering::Acquire);
        loop {
            if blocks >= self.max_blocks {
                return false;
            }
            match self.queued_blocks.compare_exchange_weak(
                blocks,
                blocks + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(actual) => blocks = actual,
            }
        }
        let mut queued = self.queued_samples.load(Ordering::Acquire);
        loop {
            let Some(next) = queued.checked_add(samples) else {
                self.queued_blocks.fetch_sub(1, Ordering::AcqRel);
                return false;
            };
            if next > self.max_samples {
                self.queued_blocks.fetch_sub(1, Ordering::AcqRel);
                return false;
            }
            match self.queued_samples.compare_exchange_weak(
                queued,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.high_water_samples.fetch_max(next, Ordering::AcqRel);
                    return true;
                }
                Err(actual) => queued = actual,
            }
        }
    }

    pub(crate) fn release(&self, samples: u64) {
        let _ = self
            .queued_samples
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |queued| {
                Some(queued.saturating_sub(samples))
            });
        let _ = self
            .queued_blocks
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |blocks| {
                Some(blocks.saturating_sub(1))
            });
    }

    pub(crate) fn queued_samples(&self) -> u64 {
        self.queued_samples.load(Ordering::Acquire)
    }

    pub(crate) fn queued_blocks(&self) -> u64 {
        self.queued_blocks.load(Ordering::Acquire)
    }

    pub(crate) fn high_water_samples(&self) -> u64 {
        self.high_water_samples.load(Ordering::Acquire)
    }

    pub(crate) fn restore_high_water_samples(&self, samples: u64) {
        self.high_water_samples.fetch_max(samples, Ordering::AcqRel);
    }

    pub(crate) fn max_samples(&self) -> u64 {
        self.max_samples
    }

    pub(crate) fn max_blocks(&self) -> u64 {
        self.max_blocks
    }
}

#[derive(Clone, Default)]
pub(crate) struct VadTelemetry {
    pub(crate) health: Arc<AtomicU32>,
    pub(crate) degraded_generation: Arc<AtomicU64>,
    pub(crate) issue_code: Arc<AtomicU32>,
    pub(crate) gap_start_sample: Arc<AtomicU64>,
    pub(crate) gap_end_sample: Arc<AtomicU64>,
    pub(crate) overflow_count: Arc<AtomicU64>,
    pub(crate) dropped_samples: Arc<AtomicU64>,
    pub(crate) classifier_failure_count: Arc<AtomicU64>,
    pub(crate) flush_timeout_count: Arc<AtomicU64>,
    pub(crate) worker_disconnect_count: Arc<AtomicU64>,
}

impl VadTelemetry {
    pub(crate) fn latch_issue(
        &self,
        generation: u64,
        issue_code: u32,
        start_sample: u64,
        end_sample: u64,
    ) {
        let previous = self.degraded_generation.compare_exchange(
            0,
            generation,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        if previous.is_ok() || previous == Err(generation) {
            if previous.is_ok() {
                self.issue_code.store(issue_code, Ordering::Release);
                self.gap_start_sample.store(start_sample, Ordering::Release);
            }
            self.gap_end_sample.fetch_max(end_sample, Ordering::AcqRel);
        }
        self.health.store(
            if issue_code == VAD_ISSUE_WORKER_DISCONNECTED {
                VAD_HEALTH_UNAVAILABLE
            } else {
                VAD_HEALTH_DEGRADED
            },
            Ordering::Release,
        );
        match issue_code {
            VAD_ISSUE_QUEUE_OVERFLOW => {
                self.overflow_count.fetch_add(1, Ordering::Relaxed);
                self.dropped_samples
                    .fetch_add(end_sample.saturating_sub(start_sample), Ordering::Relaxed);
            }
            VAD_ISSUE_CLASSIFIER_FAILURE => {
                self.classifier_failure_count
                    .fetch_add(1, Ordering::Relaxed);
            }
            VAD_ISSUE_FLUSH_TIMEOUT => {
                self.flush_timeout_count.fetch_add(1, Ordering::Relaxed);
            }
            VAD_ISSUE_WORKER_DISCONNECTED => {
                self.worker_disconnect_count.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }

    pub(crate) fn clear_generation(&self, generation: u64) {
        self.degraded_generation.store(0, Ordering::Release);
        self.issue_code.store(VAD_ISSUE_NONE, Ordering::Release);
        self.gap_start_sample.store(0, Ordering::Release);
        self.gap_end_sample.store(0, Ordering::Release);
        self.health.store(VAD_HEALTH_HEALTHY, Ordering::Release);
        // Store the generation only in the authoritative analysis sink. The
        // telemetry latch remains zero until this generation actually fails.
        let _ = generation;
    }

    pub(crate) fn issue_for_generation(&self, generation: u64) -> Option<(u32, u64, u64)> {
        let degraded = self.degraded_generation.load(Ordering::Acquire);
        (degraded != 0 && degraded == generation).then(|| {
            (
                self.issue_code.load(Ordering::Acquire),
                self.gap_start_sample.load(Ordering::Acquire),
                self.gap_end_sample.load(Ordering::Acquire),
            )
        })
    }
}

pub(crate) struct VadAnnotationSink {
    pub(crate) head_silence: HeadSilenceMonitor,
    pub(crate) silence_samples: Arc<AtomicU64>,
    pub(crate) last_signal_sample: Arc<AtomicU64>,
    pub(crate) attempt_signal_start_sample: Arc<AtomicU64>,
    pub(crate) analyzed_samples: Arc<AtomicU64>,
    pub(crate) analysis_epoch: Arc<AtomicU64>,
    pub(crate) generation: Arc<AtomicU64>,
    pub(crate) telemetry: VadTelemetry,
}

pub(crate) struct Downsampler {
    in_rate: u32,
    /// Fractional source position of the next 16 kHz sample, relative to the
    /// first sample of `pending`.
    pos: f64,
    pending: Vec<f32>,
    pending_origin: u64,
}

impl Downsampler {
    fn new(in_rate: u32) -> Self {
        Self {
            in_rate: in_rate.max(1),
            pos: 0.0,
            pending: Vec::new(),
            pending_origin: 0,
        }
    }

    fn reset(&mut self) {
        self.pos = 0.0;
        self.pending.clear();
        self.pending_origin = 0;
    }

    fn push(&mut self, samples: &[f32], block_start: u64) -> Vec<(f32, u64)> {
        if samples.is_empty() {
            return Vec::new();
        }
        if self.pending.is_empty() {
            self.pending_origin = block_start;
            self.pos = 0.0;
        }
        self.pending.extend_from_slice(samples);
        if self.in_rate == VAD_SAMPLE_RATE {
            let mut out = Vec::with_capacity(self.pending.len());
            for (index, sample) in self.pending.iter().copied().enumerate() {
                out.push((sample, self.pending_origin.saturating_add(index as u64)));
            }
            self.pending_origin = self
                .pending_origin
                .saturating_add(self.pending.len() as u64);
            self.pending.clear();
            self.pos = 0.0;
            return out;
        }
        let step = f64::from(self.in_rate) / f64::from(VAD_SAMPLE_RATE);
        let mut out = Vec::new();
        while self.pos + 1.0 < self.pending.len() as f64 {
            let index = self.pos.floor() as usize;
            let frac = (self.pos - index as f64) as f32;
            let a = self.pending[index];
            let b = self.pending[index + 1];
            let sample = a + (b - a) * frac;
            let capture = self.pending_origin.saturating_add(self.pos.round() as u64);
            out.push((sample, capture));
            self.pos += step;
        }
        // `pos` can advance past the last produced interpolant (step may be > 1).
        // Never consume the final sample; the next block still needs it as the
        // left point of the next linear interpolant.
        let consumed = (self.pos.floor() as usize).min(self.pending.len().saturating_sub(1));
        if consumed > 0 {
            self.pending.copy_within(consumed.., 0);
            self.pending.truncate(self.pending.len() - consumed);
            self.pending_origin = self.pending_origin.saturating_add(consumed as u64);
            self.pos -= consumed as f64;
        }
        out
    }

    fn flush_partial(&mut self, last_block_end: u64) -> Option<(Vec<f32>, u64, u64)> {
        if self.pending.is_empty() && self.pos < 1.0 {
            return None;
        }
        let start = self.pending_origin;
        let mut frame = vec![0.0; VAD_FRAME_SAMPLES];
        let available = self.pending.len().min(VAD_FRAME_SAMPLES);
        frame[..available].copy_from_slice(&self.pending[..available]);
        self.reset();
        Some((frame, start, last_block_end.max(start.saturating_add(1))))
    }
}

pub(crate) struct VadWorker {
    detector: Box<earshot::Detector>,
    downsampler: Downsampler,
    frame: Vec<f32>,
    frame_capture: Vec<u64>,
    last_block_end: u64,
    #[cfg(test)]
    fail_next_prediction: bool,
}

impl VadWorker {
    fn new(sample_rate: u32) -> Self {
        Self {
            detector: earshot::Detector::default_boxed(),
            downsampler: Downsampler::new(sample_rate),
            frame: Vec::with_capacity(VAD_FRAME_SAMPLES),
            frame_capture: Vec::with_capacity(VAD_FRAME_SAMPLES),
            last_block_end: 0,
            #[cfg(test)]
            fail_next_prediction: false,
        }
    }

    fn reset(&mut self) {
        self.detector = earshot::Detector::default_boxed();
        self.downsampler.reset();
        self.frame.clear();
        self.frame_capture.clear();
        #[cfg(test)]
        {
            self.fail_next_prediction = false;
        }
    }

    fn ingest(
        &mut self,
        samples: &[f32],
        block_start: u64,
        block_end: u64,
        sink: &VadAnnotationSink,
    ) {
        self.last_block_end = block_end;
        for (sample, capture) in self.downsampler.push(samples, block_start) {
            self.frame.push(sample);
            self.frame_capture.push(capture);
            if self.frame.len() == VAD_FRAME_SAMPLES {
                self.publish_frame(sink, None);
            }
        }
        // Partial 16 ms frames wait for more audio. stop_attempt flushes them.
    }

    fn publish_frame(&mut self, sink: &VadAnnotationSink, end_override: Option<u64>) {
        if self.frame.len() != VAD_FRAME_SAMPLES || self.frame_capture.is_empty() {
            self.frame.clear();
            self.frame_capture.clear();
            return;
        }
        let score = self.predict_frame();
        let is_speech = match score {
            Ok(value) => value > 0.5,
            Err(_) => {
                let start = self.frame_capture.first().copied().unwrap_or(0);
                let end = end_override.unwrap_or_else(|| {
                    self.frame_capture
                        .last()
                        .copied()
                        .unwrap_or(start)
                        .saturating_add(1)
                });
                sink.telemetry.latch_issue(
                    sink.generation.load(Ordering::Acquire),
                    VAD_ISSUE_CLASSIFIER_FAILURE,
                    start,
                    end,
                );
                // Rebuild the detector, but never classify the failed range as
                // silence. The enclosing take is explicitly non-deliverable.
                self.detector = earshot::Detector::default_boxed();
                self.frame.clear();
                self.frame_capture.clear();
                return;
            }
        };
        let start = self.frame_capture[0];
        let end = end_override.unwrap_or_else(|| {
            self.frame_capture
                .last()
                .copied()
                .unwrap_or(start)
                .saturating_add(1)
                .max(start.saturating_add(1))
        });
        publish_classified_range(sink, is_speech, start, end);
        self.frame.clear();
        self.frame_capture.clear();
    }

    fn predict_frame(&mut self) -> std::thread::Result<f32> {
        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_prediction) {
            return Err(Box::new("injected classifier failure"));
        }
        catch_unwind(AssertUnwindSafe(|| self.detector.predict_f32(&self.frame)))
    }

    fn flush(&mut self, sink: &VadAnnotationSink) {
        if self.frame.is_empty() {
            if let Some((mut padded, start, end)) =
                self.downsampler.flush_partial(self.last_block_end)
            {
                padded.truncate(VAD_FRAME_SAMPLES);
                if padded.len() < VAD_FRAME_SAMPLES {
                    padded.resize(VAD_FRAME_SAMPLES, 0.0);
                }
                self.frame = padded;
                self.frame_capture = vec![start; VAD_FRAME_SAMPLES];
                self.publish_frame(sink, Some(end));
            }
        } else {
            let start = self.frame_capture.first().copied().unwrap_or(0);
            let end = self.last_block_end.max(start.saturating_add(1));
            self.frame.resize(VAD_FRAME_SAMPLES, 0.0);
            self.frame_capture.resize(VAD_FRAME_SAMPLES, start);
            self.publish_frame(sink, Some(end));
            self.downsampler.reset();
        }
        if self.last_block_end > 0 {
            let analysis_write = begin_analysis_write(&sink.analysis_epoch);
            sink.analyzed_samples
                .fetch_max(self.last_block_end, Ordering::Release);
            drop(analysis_write);
        }
    }
}

fn publish_classified_range(sink: &VadAnnotationSink, is_speech: bool, start: u64, end: u64) {
    if end <= start {
        return;
    }
    let frames = end - start;
    let analysis_write = begin_analysis_write(&sink.analysis_epoch);
    annotate_attempt_block(
        &sink.head_silence,
        &sink.silence_samples,
        &sink.last_signal_sample,
        &sink.attempt_signal_start_sample,
        is_speech,
        frames,
        start,
        end,
    );
    sink.analyzed_samples.fetch_max(end, Ordering::Release);
    drop(analysis_write);
}

fn process_block(
    block: VadAnalysisBlock,
    worker: &mut VadWorker,
    sink: &VadAnnotationSink,
    budget: &VadQueueBudget,
) {
    budget.release(block.block_end.saturating_sub(block.block_start));
    if block.generation != sink.generation.load(Ordering::Acquire)
        || sink
            .telemetry
            .issue_for_generation(block.generation)
            .is_some()
    {
        return;
    }
    worker.ingest(&block.samples, block.block_start, block.block_end, sink);
}

fn drain_data_queue(rx: &Receiver<VadAnalysisBlock>, budget: &VadQueueBudget) {
    while let Ok(block) = rx.try_recv() {
        budget.release(block.block_end.saturating_sub(block.block_start));
    }
}

pub(crate) fn run_vad_analysis_thread(
    data_rx: Receiver<VadAnalysisBlock>,
    control_rx: Receiver<VadControlMessage>,
    sample_rate: u32,
    sink: VadAnnotationSink,
    budget: VadQueueBudget,
) {
    let mut worker = VadWorker::new(sample_rate);
    loop {
        select_biased! {
            recv(control_rx) -> message => match message {
                Ok(VadControlMessage::Shutdown { done }) => {
                    drain_data_queue(&data_rx, &budget);
                    let _ = done.send(());
                    break;
                }
                Ok(VadControlMessage::Reset { generation, boundary, done }) => {
                    drain_data_queue(&data_rx, &budget);
                    worker.reset();
                    sink.generation.store(generation, Ordering::Release);
                    sink.telemetry.clear_generation(generation);
                    sink.analyzed_samples.fetch_max(boundary, Ordering::Release);
                    let _ = done.send(Ok(()));
                }
                Ok(VadControlMessage::Flush { generation, target_sample, deadline, done }) => {
                    let outcome = loop {
                        if let Some((code, _, _)) = sink.telemetry.issue_for_generation(generation) {
                            break VadFlushOutcome::Degraded(code);
                        }
                        if sink.analyzed_samples.load(Ordering::Acquire) >= target_sample
                            || worker.last_block_end >= target_sample
                        {
                            worker.flush(&sink);
                            if sink.analyzed_samples.load(Ordering::Acquire) >= target_sample {
                                break VadFlushOutcome::Complete;
                            }
                        }
                        if Instant::now() >= deadline {
                            break VadFlushOutcome::Timeout;
                        }
                        match data_rx.try_recv() {
                            Ok(block) => process_block(block, &mut worker, &sink, &budget),
                            Err(TryRecvError::Empty) => std::thread::yield_now(),
                            Err(TryRecvError::Disconnected) => {
                                sink.telemetry.latch_issue(
                                    generation,
                                    VAD_ISSUE_WORKER_DISCONNECTED,
                                    sink.analyzed_samples.load(Ordering::Acquire),
                                    target_sample,
                                );
                                break VadFlushOutcome::Degraded(VAD_ISSUE_WORKER_DISCONNECTED);
                            }
                        }
                    };
                    let _ = done.send(outcome);
                }
                Err(_) => {
                    let generation = sink.generation.load(Ordering::Acquire);
                    let analyzed = sink.analyzed_samples.load(Ordering::Acquire);
                    sink.telemetry.latch_issue(
                        generation,
                        VAD_ISSUE_WORKER_DISCONNECTED,
                        analyzed,
                        analyzed,
                    );
                    drain_data_queue(&data_rx, &budget);
                    break;
                }
            },
            recv(data_rx) -> block => match block {
                Ok(block) => process_block(block, &mut worker, &sink, &budget),
                Err(_) => {
                    let generation = sink.generation.load(Ordering::Acquire);
                    let analyzed = sink.analyzed_samples.load(Ordering::Acquire);
                    sink.telemetry.latch_issue(
                        generation,
                        VAD_ISSUE_WORKER_DISCONNECTED,
                        analyzed,
                        analyzed,
                    );
                    break;
                }
            }
        }
    }
}

/// Keep `pad` samples of non-speech on each side of the first/last speech.
/// Clamped to the operator click and the frozen stop boundary.
pub(crate) fn trimmed_speech_bounds(
    recording_started: u64,
    captured_boundary: u64,
    first_speech: u64,
    last_speech: u64,
    pad_samples: u64,
) -> (u64, u64) {
    if first_speech == 0 || captured_boundary <= recording_started {
        return (recording_started, captured_boundary);
    }
    let first = first_speech.max(recording_started);
    let last = last_speech.max(first).min(captured_boundary);
    let start = first.saturating_sub(pad_samples).max(recording_started);
    let end = last
        .saturating_add(pad_samples)
        .min(captured_boundary)
        .max(start.saturating_add(1));
    (start, end)
}

#[cfg(test)]
mod tests {
    use super::{
        VAD_FRAME_SAMPLES, VAD_HEALTH_UNAVAILABLE, VAD_ISSUE_CLASSIFIER_FAILURE,
        VAD_ISSUE_WORKER_DISCONNECTED, VadAnalysisBlock, VadAnnotationSink, VadControlMessage,
        VadFlushOutcome, VadQueueBudget, VadTelemetry, VadWorker, run_vad_analysis_thread,
        trimmed_speech_bounds,
    };
    use crate::attempt::HeadSilenceMonitor;
    use crossbeam_channel::bounded;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{Duration, Instant};

    fn test_sink(sample_rate: u32) -> VadAnnotationSink {
        VadAnnotationSink {
            head_silence: HeadSilenceMonitor::new(u64::from(sample_rate)),
            silence_samples: Arc::new(AtomicU64::new(0)),
            last_signal_sample: Arc::new(AtomicU64::new(0)),
            attempt_signal_start_sample: Arc::new(AtomicU64::new(0)),
            analyzed_samples: Arc::new(AtomicU64::new(0)),
            analysis_epoch: Arc::new(AtomicU64::new(0)),
            generation: Arc::new(AtomicU64::new(1)),
            telemetry: VadTelemetry::default(),
        }
    }

    #[test]
    fn trim_keeps_pad_inside_the_take() {
        assert_eq!(trimmed_speech_bounds(10, 200, 80, 120, 20), (60, 140));
    }

    #[test]
    fn trim_clamps_to_click_and_stop() {
        assert_eq!(trimmed_speech_bounds(70, 130, 80, 120, 20), (70, 130));
    }

    #[test]
    fn trim_without_speech_keeps_the_raw_window() {
        assert_eq!(trimmed_speech_bounds(10, 50, 0, 0, 20), (10, 50));
    }

    #[test]
    fn queue_budget_enforces_audio_and_block_limits_without_leaking() {
        let budget = VadQueueBudget::new(48_000);
        assert!(budget.try_reserve(48_000));
        assert!(!budget.try_reserve(1));
        assert_eq!(budget.queued_samples(), 48_000);
        budget.release(48_000);
        assert_eq!(budget.queued_samples(), 0);
        assert_eq!(budget.queued_blocks(), 0);

        for _ in 0..1_024 {
            assert!(budget.try_reserve(1));
        }
        assert!(!budget.try_reserve(1));
        for _ in 0..1_024 {
            budget.release(1);
        }
        assert_eq!(budget.queued_samples(), 0);
        assert_eq!(budget.queued_blocks(), 0);

        budget.restore_high_water_samples(96_000);
        assert_eq!(
            budget.high_water_samples(),
            96_000,
            "resume must retain the historical maximum even if it exceeds the current capacity"
        );
    }

    #[test]
    fn flush_acknowledges_only_after_the_target_is_analyzed() {
        let sink = test_sink(16_000);
        let observed = Arc::clone(&sink.analyzed_samples);
        let budget = VadQueueBudget::new(16_000);
        let (data_tx, data_rx) = bounded(1_024);
        let (control_tx, control_rx) = bounded(8);
        for (start, end) in [(0, 256), (256, 512)] {
            assert!(budget.try_reserve(end - start));
            data_tx
                .send(VadAnalysisBlock {
                    samples: vec![0.1; (end - start) as usize],
                    block_start: start,
                    block_end: end,
                    generation: 1,
                })
                .unwrap();
        }
        let (done_tx, done_rx) = bounded(1);
        control_tx
            .send(VadControlMessage::Flush {
                generation: 1,
                target_sample: 512,
                deadline: Instant::now() + Duration::from_secs(1),
                done: done_tx,
            })
            .unwrap();
        let worker_sink = sink;
        let worker_budget = budget.clone();
        let join = thread::spawn(move || {
            run_vad_analysis_thread(data_rx, control_rx, 16_000, worker_sink, worker_budget)
        });
        assert_eq!(
            done_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            VadFlushOutcome::Complete
        );
        assert!(observed.load(Ordering::Acquire) >= 512);
        assert_eq!(budget.queued_samples(), 0);
        let (shutdown_tx, shutdown_rx) = bounded(1);
        control_tx
            .send(VadControlMessage::Shutdown { done: shutdown_tx })
            .unwrap();
        shutdown_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        join.join().unwrap();
    }

    #[test]
    fn expired_flush_deadline_returns_timeout_without_false_completion() {
        let sink = test_sink(16_000);
        let budget = VadQueueBudget::new(16_000);
        let (data_tx, data_rx) = bounded(1_024);
        let (control_tx, control_rx) = bounded(8);
        let (done_tx, done_rx) = bounded(1);
        control_tx
            .send(VadControlMessage::Flush {
                generation: 1,
                target_sample: 256,
                deadline: Instant::now(),
                done: done_tx,
            })
            .unwrap();
        let join = thread::spawn(move || {
            run_vad_analysis_thread(data_rx, control_rx, 16_000, sink, budget)
        });
        assert_eq!(
            done_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            VadFlushOutcome::Timeout
        );
        let (shutdown_tx, shutdown_rx) = bounded(1);
        control_tx
            .send(VadControlMessage::Shutdown { done: shutdown_tx })
            .unwrap();
        shutdown_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(data_tx);
        join.join().unwrap();
    }

    #[test]
    fn reset_control_is_prioritized_and_discards_the_previous_generation() {
        let sink = test_sink(16_000);
        let generation = Arc::clone(&sink.generation);
        let analyzed = Arc::clone(&sink.analyzed_samples);
        let budget = VadQueueBudget::new(16_000);
        let (data_tx, data_rx) = bounded(1_024);
        let (control_tx, control_rx) = bounded(8);
        assert!(budget.try_reserve(256));
        data_tx
            .send(VadAnalysisBlock {
                samples: vec![0.5; 256],
                block_start: 0,
                block_end: 256,
                generation: 1,
            })
            .unwrap();
        let (reset_tx, reset_rx) = bounded(1);
        control_tx
            .send(VadControlMessage::Reset {
                generation: 2,
                boundary: 256,
                done: reset_tx,
            })
            .unwrap();
        let worker_budget = budget.clone();
        let join = thread::spawn(move || {
            run_vad_analysis_thread(data_rx, control_rx, 16_000, sink, worker_budget)
        });
        reset_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .unwrap();
        assert_eq!(generation.load(Ordering::Acquire), 2);
        assert_eq!(analyzed.load(Ordering::Acquire), 256);
        assert_eq!(budget.queued_samples(), 0);
        let (shutdown_tx, shutdown_rx) = bounded(1);
        control_tx
            .send(VadControlMessage::Shutdown { done: shutdown_tx })
            .unwrap();
        shutdown_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        drop(data_tx);
        join.join().unwrap();
    }

    #[test]
    fn data_channel_disconnect_marks_the_worker_unavailable() {
        let sink = test_sink(16_000);
        let telemetry = sink.telemetry.clone();
        let budget = VadQueueBudget::new(16_000);
        let (data_tx, data_rx) = bounded(1_024);
        let (_control_tx, control_rx) = bounded(8);
        drop(data_tx);
        let join = thread::spawn(move || {
            run_vad_analysis_thread(data_rx, control_rx, 16_000, sink, budget)
        });
        join.join().unwrap();
        assert_eq!(
            telemetry.health.load(Ordering::Acquire),
            VAD_HEALTH_UNAVAILABLE
        );
        assert_eq!(telemetry.worker_disconnect_count.load(Ordering::Acquire), 1);
        assert_eq!(
            telemetry.issue_for_generation(1).unwrap().0,
            VAD_ISSUE_WORKER_DISCONNECTED
        );
    }

    #[test]
    fn injected_classifier_failure_latches_the_generation_as_degraded() {
        let sink = test_sink(16_000);
        sink.generation.store(9, Ordering::Release);
        let telemetry = sink.telemetry.clone();
        let mut worker = VadWorker::new(16_000);
        worker.fail_next_prediction = true;
        worker.ingest(&vec![0.1; VAD_FRAME_SAMPLES], 400, 656, &sink);
        assert_eq!(
            telemetry.issue_for_generation(9),
            Some((VAD_ISSUE_CLASSIFIER_FAILURE, 400, 656))
        );
        assert_eq!(
            telemetry.classifier_failure_count.load(Ordering::Acquire),
            1
        );
        assert_eq!(sink.analyzed_samples.load(Ordering::Acquire), 0);
    }

    /// Explicit performance gate, invoked by `npm run test:vad-throughput`.
    /// It stays ignored in the ordinary Rust unit-test pass so the milestone
    /// command is visible as a separate acceptance result rather than buried
    /// among functional tests.
    #[test]
    #[ignore = "run explicitly through npm test:vad-throughput"]
    fn vad_throughput_gate_reports_48_96_and_192_khz() {
        const AUDIO_SECONDS: u64 = 10;
        for sample_rate in [48_000u32, 96_000, 192_000] {
            let sink = test_sink(sample_rate);
            let mut worker = VadWorker::new(sample_rate);
            let total = u64::from(sample_rate) * AUDIO_SECONDS;
            let started = Instant::now();
            let mut cursor = 0u64;
            while cursor < total {
                let frames = (total - cursor).min(512) as usize;
                let samples = (0..frames)
                    .map(|index| (((cursor as usize + index) % 97) as f32 / 97.0 - 0.5) * 0.2)
                    .collect::<Vec<_>>();
                worker.ingest(&samples, cursor, cursor + frames as u64, &sink);
                cursor += frames as u64;
            }
            worker.flush(&sink);
            let elapsed = started.elapsed().as_secs_f64().max(f64::EPSILON);
            let realtime_factor = AUDIO_SECONDS as f64 / elapsed;
            eprintln!(
                "VAD throughput: sample_rate={sample_rate} realtime_factor={realtime_factor:.2}x elapsed={elapsed:.3}s"
            );
            assert!(
                realtime_factor >= 4.0,
                "VAD must process {sample_rate} Hz at least 4x realtime; measured {realtime_factor:.2}x"
            );
            assert_eq!(
                sink.analyzed_samples.load(Ordering::Acquire),
                total,
                "manual throughput run must analyze the complete input"
            );
        }
    }

    #[test]
    fn earshot_scores_silent_and_noisy_frames_without_panicking() {
        let mut detector = earshot::Detector::default_boxed();
        let silence = vec![0.0; VAD_FRAME_SAMPLES];
        let noise: Vec<f32> = (0..VAD_FRAME_SAMPLES)
            .map(|index| (index as f32 * 0.37).sin() * 0.2)
            .collect();
        for _ in 0..64 {
            let silent = detector.predict_f32(&silence);
            let noisy = detector.predict_f32(&noise);
            assert!(silent.is_finite(), "silent score={silent}");
            assert!(noisy.is_finite(), "noisy score={noisy}");
        }
    }

    #[test]
    fn downsampled_system_test_noise_does_not_panic_earshot() {
        let mut worker = super::VadWorker::new(48_000);
        let mut detector = earshot::Detector::default_boxed();
        let mut downsampler = super::Downsampler::new(48_000);
        let seed = 0x5a17u64;
        let mut produced = 0usize;
        for block in 0..2_000u64 {
            let mut samples = Vec::with_capacity(256);
            for offset in 0..256u64 {
                let index = block * 256 + offset;
                let word = seed
                    .wrapping_add(index.wrapping_mul(6_364_136_223_846_793_005))
                    .rotate_left(17);
                samples.push(((word >> 40) as f32 / 16_777_215.0) * 0.5 - 0.25);
            }
            for (sample, _) in downsampler.push(&samples, block * 256) {
                worker.frame.push(sample);
                if worker.frame.len() == VAD_FRAME_SAMPLES {
                    let score = detector.predict_f32(&worker.frame);
                    assert!(score.is_finite(), "score={score} frame={produced}");
                    worker.frame.clear();
                    produced += 1;
                }
            }
        }
        assert!(produced > 10, "produced {produced} vad frames");
    }
}
