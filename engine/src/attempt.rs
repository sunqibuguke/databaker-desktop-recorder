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
    // Measurement runs before annotation under the same analysis writer guard.
    // Keep separate watermarks so each consumer sees every new sample once.
    measured_until_sample: Arc<AtomicU64>,
    annotated_until_sample: Arc<AtomicU64>,
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
            measured_until_sample: Arc::new(AtomicU64::new(0)),
            annotated_until_sample: Arc::new(AtomicU64::new(0)),
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
        self.measured_until_sample
            .store(armed_sample, Ordering::Release);
        self.annotated_until_sample
            .store(armed_sample, Ordering::Release);
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

    /// Must be called under the analysis writer guard, before annotation.
    pub(crate) fn measure(&self, samples: &[f32], start: u64, speech: bool) {
        if !self.amplitude_enabled.load(Ordering::Acquire)
            || self.phase.load(Ordering::Acquire) == HEAD_SILENCE_IDLE
            || self.end_sample.load(Ordering::Acquire) != 0
        {
            return;
        }
        let end = start.saturating_add(samples.len() as u64);
        let effective_start = start
            .max(self.armed_sample.load(Ordering::Acquire))
            .max(self.measured_until_sample.load(Ordering::Acquire));
        if end <= effective_start {
            return;
        }
        self.measured_until_sample.store(end, Ordering::Release);
        let mut meter = self.speech_meter.lock().unwrap();
        if !speech {
            meter.silence();
            return;
        }
        if self.enforce.load(Ordering::Acquire)
            && self.phase.load(Ordering::Acquire) == HEAD_SILENCE_WAITING
        {
            return;
        }
        let offset = (effective_start - start) as usize;
        let end_offset = (end - start) as usize;
        for sample in &samples[offset..end_offset] {
            meter.push(*sample);
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
    let mut phase = head_silence.phase.load(Ordering::Acquire);
    // Freeze the first eligible endpoint even if the command loop or UI is late.
    // Idle room-tone analysis must resume after the take has been disarmed.
    if phase != HEAD_SILENCE_IDLE && head_silence.end_sample.load(Ordering::Acquire) != 0 {
        return;
    }
    let armed_sample = head_silence.armed_sample.load(Ordering::Acquire);
    let block_end = block_end.min(block_start.saturating_add(frames));
    let effective_start = block_start
        .max(head_silence.annotated_until_sample.load(Ordering::Acquire))
        .max(if phase == HEAD_SILENCE_IDLE {
            0
        } else {
            armed_sample
        });
    if block_end <= effective_start {
        return;
    }
    head_silence
        .annotated_until_sample
        .store(block_end, Ordering::Release);
    // A queued block can straddle arm(), and VAD classification intervals can
    // overlap. Count only the new intersection with this take, never full frames
    // that include audio before its start or that have already been analyzed.
    let effective_frames = block_end - effective_start;

    let enforce = head_silence.enforce.load(Ordering::Acquire);
    if !is_speech {
        let previous = silence_samples.load(Ordering::Acquire);
        silence_samples.store(previous.saturating_add(effective_frames), Ordering::Release);
    } else {
        silence_samples.store(0, Ordering::Release);
        let count_as_content = phase != HEAD_SILENCE_IDLE
            && block_end > armed_sample
            && !(enforce && phase == HEAD_SILENCE_WAITING);
        if count_as_content {
            let candidate = effective_start.max(1);
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
                    .saturating_add(effective_frames)
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

    struct Analysis {
        head: HeadSilenceMonitor,
        silence: AtomicU64,
        last: AtomicU64,
        first: AtomicU64,
    }

    impl Analysis {
        fn new(required: u64, armed: u64, enforce: bool, auto_end: bool) -> Self {
            let state = Self {
                head: HeadSilenceMonitor::new(required),
                silence: AtomicU64::new(0),
                last: AtomicU64::new(0),
                first: AtomicU64::new(0),
            };
            state.head.set_enforce(enforce);
            state.arm(armed, auto_end);
            state
        }

        fn arm(&self, armed: u64, auto_end: bool) {
            self.head.configure(
                RecordingPolicy {
                    amplitude_enabled: true,
                    auto_end,
                    ..Default::default()
                },
                48_000,
                16,
            );
            self.first.store(0, Ordering::Release);
            self.last.store(0, Ordering::Release);
            self.silence.store(0, Ordering::Release);
            self.head.arm(armed);
        }

        fn feed(&self, speech: bool, start: u64, end: u64, amplitude: f32) {
            let pcm = vec![amplitude; (end - start) as usize];
            // Match both the callback and VAD worker call order. A shared
            // watermark would accidentally make annotation ignore this block.
            self.head.measure(&pcm, start, speech);
            annotate_attempt_block(
                &self.head,
                &self.silence,
                &self.last,
                &self.first,
                speech,
                end - start,
                start,
                end,
            );
        }
    }

    #[test]
    fn cached_vad_frame_does_not_pass_head_silence_98_samples_early() {
        let analysis = Analysis::new(48_000, 2_486_400, true, false);
        // Real diagnostic boundaries: a 480-sample callback was buffered
        // before arm. At 48 kHz, each VAD interval covers 766 of 768 samples.
        for index in 0..63 {
            let start = 2_485_920 + index * 768;
            analysis.feed(false, start, start + 766, 0.0);
        }
        let former_passed = 2_485_920 + 62 * 768 + 766;
        assert_eq!(former_passed, 2_534_302);
        assert_eq!(former_passed - 2_486_400, 48_000 - 98);
        assert_eq!(
            analysis.head.progress_samples.load(Ordering::Acquire),
            47_778
        );
        assert_eq!(analysis.head.passed_sample.load(Ordering::Acquire), 0);
        let start = 2_485_920 + 63 * 768;
        analysis.feed(false, start, start + 766, 0.0);
        assert_eq!(
            analysis.head.progress_samples.load(Ordering::Acquire),
            48_000
        );
        assert!(analysis.head.passed_sample.load(Ordering::Acquire) >= 2_486_400 + 48_000);
        assert_eq!(
            analysis.head.phase.load(Ordering::Acquire),
            HEAD_SILENCE_PASSED
        );
    }

    #[test]
    fn duplicate_late_and_overlapping_blocks_only_count_new_samples() {
        let analysis = Analysis::new(400, 1_000, true, false);
        analysis.feed(true, 800, 1_000, 1.0); // Entirely before arm.
        analysis.feed(false, 900, 1_100, 0.0); // Only 100 samples belong to this take.
        analysis.feed(true, 900, 1_100, 1.0); // Duplicate classification must not reset silence.
        analysis.feed(false, 1_050, 1_300, 0.0); // Only the new 200 samples count.
        analysis.feed(true, 1_100, 1_200, 1.0); // Late old speech is also irrelevant.
        assert_eq!(analysis.head.progress_samples.load(Ordering::Acquire), 300);
        assert_eq!(analysis.silence.load(Ordering::Acquire), 300);
        assert_eq!(analysis.head.passed_sample.load(Ordering::Acquire), 0);
        analysis.feed(false, 1_300, 1_400, 0.0);
        assert_eq!(analysis.head.passed_sample.load(Ordering::Acquire), 1_400);

        analysis.feed(true, 1_390, 1_450, 0.125);
        analysis.feed(true, 1_400, 1_450, 1.0); // Replayed PCM must not change PEAK/RMS.
        analysis.feed(true, 1_425, 1_500, 0.125);
        let quality = analysis.head.speech_meter.lock().unwrap().result().unwrap();
        assert_eq!(analysis.first.load(Ordering::Acquire), 1_400);
        assert_eq!(analysis.last.load(Ordering::Acquire), 1_500);
        assert_eq!(quality.speech_samples, 100);
        assert!((quality.rms_dbfs.unwrap() - 20.0 * 0.125_f32.log10()).abs() < 0.0001);
        assert!(quality.warnings.is_empty());
    }

    #[test]
    fn speech_during_head_silence_restarts_only_the_current_wait() {
        let analysis = Analysis::new(200, 1_000, true, false);
        analysis.feed(false, 1_000, 1_150, 0.0);
        analysis.feed(true, 1_150, 1_200, 0.125);
        assert_eq!(analysis.head.progress_samples.load(Ordering::Acquire), 0);
        assert_eq!(analysis.first.load(Ordering::Acquire), 0);
        analysis.feed(false, 1_200, 1_390, 0.0);
        assert_eq!(analysis.head.passed_sample.load(Ordering::Acquire), 0);
        analysis.feed(false, 1_390, 1_410, 0.0);
        assert_eq!(analysis.head.passed_sample.load(Ordering::Acquire), 1_410);
        assert_eq!(
            analysis
                .head
                .speech_meter
                .lock()
                .unwrap()
                .result()
                .unwrap()
                .speech_samples,
            0
        );
    }

    #[test]
    fn auto_stop_freezes_results_and_retake_starts_with_clean_statistics() {
        let analysis = Analysis::new(200, 1_000, true, true);
        analysis.feed(false, 1_000, 1_200, 0.0);
        analysis.feed(true, 1_200, 1_250, 0.01);
        analysis.feed(false, 1_250, 1_450, 0.0);
        let frozen = analysis.head.speech_meter.lock().unwrap().result().unwrap();
        assert_eq!(analysis.head.end_sample.load(Ordering::Acquire), 1_450);
        assert_eq!(frozen.speech_samples, 50);
        assert_eq!(frozen.warnings, ["speech_low"]);
        analysis.feed(true, 1_400, 1_500, 1.0); // Overlap the stop boundary.
        analysis.feed(true, 1_500, 2_000, 1.0);
        assert_eq!(
            analysis.head.speech_meter.lock().unwrap().result().unwrap(),
            frozen
        );
        assert_eq!(analysis.last.load(Ordering::Acquire), 1_250);
        assert_eq!(analysis.head.end_sample.load(Ordering::Acquire), 1_450);

        analysis.head.disarm();
        let idle_silence = analysis.silence.load(Ordering::Acquire);
        analysis.feed(false, 2_000, 2_100, 0.0);
        assert_eq!(analysis.silence.load(Ordering::Acquire), idle_silence + 100);
        assert_eq!(
            analysis.head.speech_meter.lock().unwrap().result().unwrap(),
            frozen
        );

        analysis.arm(3_000, true);
        assert_eq!(analysis.head.end_sample.load(Ordering::Acquire), 0);
        assert_eq!(analysis.head.passed_sample.load(Ordering::Acquire), 0);
        assert_eq!(analysis.head.progress_samples.load(Ordering::Acquire), 0);
        analysis.feed(true, 1_500, 2_000, 1.0); // Previous take arrives late.
        analysis.feed(false, 3_000, 3_200, 0.0);
        analysis.feed(true, 3_200, 3_250, 0.125);
        let quality = analysis.head.speech_meter.lock().unwrap().result().unwrap();
        assert_eq!(quality.speech_samples, 50);
        assert!(quality.warnings.is_empty());
        assert!(quality.live_warnings.is_empty());
        assert_eq!(analysis.first.load(Ordering::Acquire), 3_200);
    }

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
