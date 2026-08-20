//! Streaming AI VAD used as a drop-in speech/non-speech classifier.
//!
//! Inference stays off the capture callback. The callback only forwards PCM;
//! this module resamples to 16 kHz, scores 16 ms frames, and publishes the
//! same attempt annotations the energy gate uses.

use crate::attempt::{HeadSilenceMonitor, annotate_attempt_block, begin_analysis_write};
use crossbeam_channel::{Receiver, Sender};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

pub(crate) const VAD_SAMPLE_RATE: u32 = 16_000;
pub(crate) const VAD_FRAME_SAMPLES: usize = 256;
pub(crate) const DETECTOR_ENERGY: u32 = 0;
pub(crate) const DETECTOR_VAD: u32 = 1;

pub(crate) enum VadAnalysisMessage {
    Block {
        samples: Vec<f32>,
        block_start: u64,
        block_end: u64,
        generation: u64,
    },
    Flush {
        generation: u64,
        done: Sender<()>,
    },
    Reset {
        generation: u64,
    },
    Shutdown,
}

pub(crate) struct VadAnnotationSink {
    pub(crate) head_silence: HeadSilenceMonitor,
    pub(crate) silence_samples: Arc<AtomicU64>,
    pub(crate) last_signal_sample: Arc<AtomicU64>,
    pub(crate) attempt_signal_start_sample: Arc<AtomicU64>,
    pub(crate) analyzed_samples: Arc<AtomicU64>,
    pub(crate) analysis_epoch: Arc<AtomicU64>,
    pub(crate) generation: Arc<AtomicU64>,
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
}

impl VadWorker {
    fn new(sample_rate: u32) -> Self {
        Self {
            detector: earshot::Detector::default_boxed(),
            downsampler: Downsampler::new(sample_rate),
            frame: Vec::with_capacity(VAD_FRAME_SAMPLES),
            frame_capture: Vec::with_capacity(VAD_FRAME_SAMPLES),
            last_block_end: 0,
        }
    }

    fn reset(&mut self) {
        self.detector = earshot::Detector::default_boxed();
        self.downsampler.reset();
        self.frame.clear();
        self.frame_capture.clear();
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
        let score = catch_unwind(AssertUnwindSafe(|| self.detector.predict_f32(&self.frame)));
        let is_speech = match score {
            Ok(value) => value > 0.5,
            Err(_) => {
                // Earshot can panic on some frames (internal FFT/slice bounds).
                // Rebuild the detector so one bad frame cannot kill analysis.
                self.detector = earshot::Detector::default_boxed();
                false
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

pub(crate) fn run_vad_analysis_thread(
    rx: Receiver<VadAnalysisMessage>,
    sample_rate: u32,
    sink: VadAnnotationSink,
) {
    let mut worker = VadWorker::new(sample_rate);
    while let Ok(message) = rx.recv() {
        match message {
            VadAnalysisMessage::Shutdown => break,
            VadAnalysisMessage::Reset { generation } => {
                if generation >= sink.generation.load(Ordering::Acquire) {
                    worker.reset();
                }
            }
            VadAnalysisMessage::Flush { generation, done } => {
                if generation >= sink.generation.load(Ordering::Acquire) {
                    worker.flush(&sink);
                }
                let _ = done.send(());
            }
            VadAnalysisMessage::Block {
                samples,
                block_start,
                block_end,
                generation,
            } => {
                if generation != sink.generation.load(Ordering::Acquire) {
                    continue;
                }
                worker.ingest(&samples, block_start, block_end, &sink);
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
    use super::{VAD_FRAME_SAMPLES, trimmed_speech_bounds};

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
