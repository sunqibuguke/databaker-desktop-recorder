use crate::speech_quality::{RecordingPolicy, SpeechMeter};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

pub(crate) struct AnalysisWriteGuard<'a> {
    epoch: &'a AtomicU64,
}

impl Drop for AnalysisWriteGuard<'_> {
    fn drop(&mut self) {
        // Publish an even epoch only after all analysis fields and the analyzed
        // sample watermark have been written.
        self.epoch.fetch_add(1, Ordering::Release);
    }
}

pub(crate) fn begin_analysis_write(epoch: &AtomicU64) -> AnalysisWriteGuard<'_> {
    let mut observed = epoch.load(Ordering::Acquire);
    loop {
        if observed & 1 != 0 {
            std::hint::spin_loop();
            observed = epoch.load(Ordering::Acquire);
            continue;
        }
        match epoch.compare_exchange_weak(
            observed,
            observed.wrapping_add(1),
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return AnalysisWriteGuard { epoch },
            Err(actual) => observed = actual,
        }
    }
}

pub(crate) const HEAD_SILENCE_IDLE: u32 = 0;
pub(crate) const HEAD_SILENCE_WAITING: u32 = 1;
pub(crate) const HEAD_SILENCE_PASSED: u32 = 2;
pub(crate) const HEAD_SILENCE_SPEECH_STARTED: u32 = 3;

#[derive(Clone)]
pub(crate) struct HeadSilenceMonitor {
    pub(crate) auto_end: Arc<AtomicBool>,
    pub(crate) amplitude_enabled: Arc<AtomicBool>,
    pub(crate) end_sample: Arc<AtomicU64>,
    pub(crate) speech_meter: Arc<Mutex<SpeechMeter>>,
    pub(crate) phase: Arc<AtomicU32>,
    pub(crate) armed_sample: Arc<AtomicU64>,
    pub(crate) progress_samples: Arc<AtomicU64>,
    pub(crate) passed_sample: Arc<AtomicU64>,
    pub(crate) required_samples: Arc<AtomicU64>,
    pub(crate) enforce: Arc<AtomicBool>,
}

impl HeadSilenceMonitor {
    pub(crate) fn new(required_samples: u64) -> Self {
        Self {
            auto_end: Arc::new(AtomicBool::new(false)),
            amplitude_enabled: Arc::new(AtomicBool::new(false)),
            end_sample: Arc::new(AtomicU64::new(0)),
            speech_meter: Arc::new(Mutex::new(SpeechMeter::default())),
            phase: Arc::new(AtomicU32::new(HEAD_SILENCE_IDLE)),
            armed_sample: Arc::new(AtomicU64::new(0)),
            progress_samples: Arc::new(AtomicU64::new(0)),
            passed_sample: Arc::new(AtomicU64::new(0)),
            required_samples: Arc::new(AtomicU64::new(required_samples)),
            enforce: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn set_enforce(&self, enforce: bool) {
        self.enforce.store(enforce, Ordering::Release);
    }

    pub(crate) fn required_samples(&self) -> u64 {
        self.required_samples.load(Ordering::Acquire)
    }

    /// Must be called while holding the capture-analysis seqlock.
    pub(crate) fn arm(&self, armed_sample: u64) {
        self.end_sample.store(0, Ordering::Release);
        self.phase.store(HEAD_SILENCE_IDLE, Ordering::Release);
        self.armed_sample.store(armed_sample, Ordering::Release);
        self.progress_samples.store(0, Ordering::Release);
        self.passed_sample.store(0, Ordering::Release);
        self.phase.store(HEAD_SILENCE_WAITING, Ordering::Release);
    }

    /// Must be called while holding the capture-analysis seqlock.
    pub(crate) fn disarm(&self) {
        self.phase.store(HEAD_SILENCE_IDLE, Ordering::Release);
        self.armed_sample.store(0, Ordering::Release);
        self.progress_samples.store(0, Ordering::Release);
        self.passed_sample.store(0, Ordering::Release);
    }

    /// Called under the analysis writer guard before arming the next take.
    pub(crate) fn configure(&self, policy: RecordingPolicy, rate: u32, depth: u16) {
        self.auto_end.store(policy.auto_end, Ordering::Release);
        self.amplitude_enabled
            .store(policy.amplitude_enabled, Ordering::Release);
        *self.speech_meter.lock().unwrap() = SpeechMeter::new(policy, rate, depth);
    }

    pub(crate) fn measure(&self, samples: &[f32], start: u64, speech: bool) {
        if !self.amplitude_enabled.load(Ordering::Acquire)
            || self.phase.load(Ordering::Acquire) == HEAD_SILENCE_IDLE
            || self.end_sample.load(Ordering::Acquire) != 0
        {
            return;
        }
        let mut meter = self.speech_meter.lock().unwrap();
        if !speech {
            meter.silence();
            return;
        }
        let armed = self.armed_sample.load(Ordering::Acquire);
        if self.enforce.load(Ordering::Acquire)
            && self.phase.load(Ordering::Acquire) == HEAD_SILENCE_WAITING
        {
            return;
        }
        for (offset, sample) in samples.iter().enumerate() {
            if start + offset as u64 >= armed {
                meter.push(*sample);
            }
        }
    }
}

pub(crate) fn head_silence_phase_name(phase: u32) -> &'static str {
    match phase {
        HEAD_SILENCE_WAITING => "waiting_for_head_silence",
        HEAD_SILENCE_PASSED => "ready_for_speech",
        HEAD_SILENCE_SPEECH_STARTED => "speech_started",
        _ => "idle",
    }
}

pub(crate) fn energy_is_speech(threshold_bits: &AtomicU32, rms: f32) -> bool {
    let threshold_dbfs = f32::from_bits(threshold_bits.load(Ordering::Relaxed));
    let threshold_linear = 10f32.powf(threshold_dbfs / 20.0);
    rms > threshold_linear
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn annotate_attempt_block(
    head_silence: &HeadSilenceMonitor,
    silence_samples: &AtomicU64,
    last_signal_sample: &AtomicU64,
    attempt_signal_start_sample: &AtomicU64,
    is_speech: bool,
    frames: u64,
    block_start: u64,
    block_end: u64,
) {
    // Freeze the first eligible endpoint even if the command loop or UI is late.
    if head_silence.end_sample.load(Ordering::Acquire) != 0 {
        return;
    }
    let armed_sample = head_silence.armed_sample.load(Ordering::Acquire);
    let mut phase = head_silence.phase.load(Ordering::Acquire);

    let enforce = head_silence.enforce.load(Ordering::Acquire);
    if !is_speech {
        let _ = silence_samples.fetch_add(frames, Ordering::AcqRel);
    } else {
        silence_samples.store(0, Ordering::Release);
        let count_as_content = phase != HEAD_SILENCE_IDLE
            && block_end > armed_sample
            && !(enforce && phase == HEAD_SILENCE_WAITING);
        if count_as_content {
            let candidate = block_start.max(armed_sample).max(1);
            let _ = attempt_signal_start_sample.compare_exchange(
                0,
                candidate,
                Ordering::Release,
                Ordering::Relaxed,
            );
            last_signal_sample.store(block_end, Ordering::Release);
        }
    }

    if phase == HEAD_SILENCE_WAITING && block_end > armed_sample {
        let required_samples = head_silence.required_samples();
        let updated = if enforce {
            if is_speech {
                0
            } else {
                head_silence
                    .progress_samples
                    .load(Ordering::Acquire)
                    .saturating_add(frames)
                    .min(required_samples)
            }
        } else {
            block_end.saturating_sub(armed_sample).min(required_samples)
        };
        head_silence
            .progress_samples
            .store(updated, Ordering::Release);
        if updated >= required_samples {
            let passed_sample = if enforce {
                block_end
            } else {
                armed_sample.saturating_add(required_samples)
            };
            head_silence
                .passed_sample
                .store(passed_sample, Ordering::Release);
            phase = if attempt_signal_start_sample.load(Ordering::Acquire) > 0 {
                HEAD_SILENCE_SPEECH_STARTED
            } else {
                HEAD_SILENCE_PASSED
            };
            head_silence.phase.store(phase, Ordering::Release);
        }
    } else if matches!(phase, HEAD_SILENCE_PASSED) && is_speech && block_end > armed_sample {
        head_silence
            .phase
            .store(HEAD_SILENCE_SPEECH_STARTED, Ordering::Release);
    }
    let last = last_signal_sample.load(Ordering::Acquire);
    let end = last.saturating_add(head_silence.required_samples());
    if head_silence.auto_end.load(Ordering::Acquire)
        && !is_speech
        && phase != HEAD_SILENCE_IDLE
        && last > 0
        && attempt_signal_start_sample.load(Ordering::Acquire) > 0
        && block_end >= end
    {
        head_silence.end_sample.store(end, Ordering::Release);
    }
}

#[cfg(test)]
mod short_take_tests {
    use super::*;
    #[test]
    fn first_eligible_boundary_stays_fixed_despite_more_speech() {
        let h = HeadSilenceMonitor::new(200);
        h.configure(
            RecordingPolicy {
                auto_end: true,
                ..Default::default()
            },
            1_000,
            16,
        );
        h.arm(10);
        let silence = AtomicU64::new(0);
        let last = AtomicU64::new(0);
        let first = AtomicU64::new(0);
        let feed = |speech, start, end| {
            annotate_attempt_block(&h, &silence, &last, &first, speech, end - start, start, end)
        };
        feed(false, 10, 250);
        assert_eq!(h.end_sample.load(Ordering::Acquire), 0); // no voice
        feed(true, 250, 400);
        feed(false, 400, 550);
        assert_eq!(h.end_sample.load(Ordering::Acquire), 0);
        feed(true, 550, 650);
        feed(false, 650, 900);
        assert_eq!(h.end_sample.load(Ordering::Acquire), 850);
        feed(true, 900, 1_500);
        assert_eq!(last.load(Ordering::Acquire), 650);
        assert_eq!(h.end_sample.load(Ordering::Acquire), 850);
        h.disarm();
        h.arm(2_000);
        assert_eq!(h.end_sample.load(Ordering::Acquire), 0);
    }
    #[test]
    fn legacy_manual_mode_keeps_accepting_speech() {
        let h = HeadSilenceMonitor::new(200);
        h.arm(10);
        let silence = AtomicU64::new(0);
        let last = AtomicU64::new(0);
        let first = AtomicU64::new(0);
        annotate_attempt_block(&h, &silence, &last, &first, true, 200, 10, 210);
        annotate_attempt_block(&h, &silence, &last, &first, false, 1_000, 210, 1_210);
        annotate_attempt_block(&h, &silence, &last, &first, true, 100, 1_210, 1_310);
        assert_eq!(h.end_sample.load(Ordering::Acquire), 0);
        assert_eq!(last.load(Ordering::Acquire), 1_310);
    }
}
