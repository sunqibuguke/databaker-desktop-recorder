//! Take-local measurements in the delivery PCM domain. Never use meter smoothing.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RecordingPolicy {
    pub amplitude_enabled: bool,
    pub auto_end: bool,
    pub rms_min_dbfs: f32,
    pub peak_max_dbfs: f32,
}

impl Default for RecordingPolicy {
    fn default() -> Self {
        Self {
            amplitude_enabled: false,
            auto_end: false,
            rms_min_dbfs: -30.0,
            peak_max_dbfs: -3.0,
        }
    }
}

impl RecordingPolicy {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.rms_min_dbfs.is_finite()
                && self.peak_max_dbfs.is_finite()
                && (-96.0..=0.0).contains(&self.rms_min_dbfs)
                && (-96.0..=0.0).contains(&self.peak_max_dbfs)
                && self.rms_min_dbfs < self.peak_max_dbfs,
            "人声 RMS 下限和 PEAK 上限须为 -96～0 dBFS，且下限小于上限"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpeechQuality {
    pub policy: RecordingPolicy,
    pub speech_samples: u64,
    pub rms_dbfs: Option<f32>,
    pub peak_dbfs: Option<f32>,
    pub warnings: Vec<String>,
    pub live_warnings: Vec<String>,
    pub retained_by_operator_at: Option<String>,
}

impl SpeechQuality {
    pub fn has_warning(&self) -> bool {
        !self.warnings.is_empty() || !self.live_warnings.is_empty()
    }
}

pub(crate) struct SpeechMeter {
    pub policy: RecordingPolicy,
    rate: u32,
    depth: u16,
    rms_min_square: f64,
    peak_max_linear: f32,
    count: u64,
    sum: f64,
    peak: f32,
    window: VecDeque<f64>,
    window_sum: f64,
    low_samples: u64,
    low_seen: bool,
    high_seen: bool,
}

impl Default for SpeechMeter {
    fn default() -> Self {
        Self::new(RecordingPolicy::default(), 48_000, 16)
    }
}

// Mirrors RecoverableWav::write_samples and decode_encoded_mono_samples, including PCM rounding.
pub(crate) fn delivery_sample(value: f32, depth: u16) -> f32 {
    match depth {
        8 => {
            ((value.clamp(-1.0, 1.0) * 128.0 + 128.0)
                .round()
                .clamp(0.0, 255.0)
                - 128.0)
                / 128.0
        }
        16 => {
            (value.clamp(-1.0, 1.0) * 32_768.0)
                .round()
                .clamp(-32_768.0, 32_767.0)
                / 32_768.0
        }
        24 => {
            (value.clamp(-1.0, 1.0) * 8_388_608.0)
                .round()
                .clamp(-8_388_608.0, 8_388_607.0)
                / 8_388_608.0
        }
        _ => value,
    }
}

fn db(value: f64) -> f32 {
    (20.0 * value.max(1e-12).log10()) as f32
}

impl SpeechMeter {
    pub fn new(policy: RecordingPolicy, rate: u32, depth: u16) -> Self {
        let rms_min_square = 10f64.powf(f64::from(policy.rms_min_dbfs) / 10.0);
        let peak_max_linear = 10f32.powf(policy.peak_max_dbfs / 20.0);
        Self {
            rms_min_square,
            peak_max_linear,
            policy,
            rate,
            depth,
            count: 0,
            sum: 0.0,
            peak: 0.0,
            window: VecDeque::with_capacity(rate as usize / 5 + 1),
            window_sum: 0.0,
            low_samples: 0,
            low_seen: false,
            high_seen: false,
        }
    }
    pub fn silence(&mut self) {
        self.window.clear();
        self.window_sum = 0.0;
        self.low_samples = 0;
    }
    pub fn push(&mut self, value: f32) {
        if !self.policy.amplitude_enabled {
            return;
        }
        let sample = delivery_sample(value, self.depth);
        let square = f64::from(sample).powi(2);
        self.count += 1;
        self.sum += square;
        self.peak = self.peak.max(sample.abs());
        self.high_seen |= sample.abs() > self.peak_max_linear;
        self.window.push_back(square);
        self.window_sum += square;
        let window_len = (self.rate as usize / 5).max(1);
        if self.window.len() > window_len {
            self.window_sum -= self.window.pop_front().unwrap();
        }
        if self.window.len() == window_len {
            if self.window_sum.max(0.0) < self.rms_min_square * window_len as f64 {
                self.low_samples += 1;
                self.low_seen |= self.low_samples > u64::from(self.rate) * 300 / 1_000;
            } else {
                self.low_samples = 0;
            }
        }
    }
    pub fn result(&self) -> Option<SpeechQuality> {
        if !self.policy.amplitude_enabled {
            return None;
        }
        let rms = (self.count > 0).then(|| db((self.sum / self.count as f64).sqrt()));
        let peak = (self.count > 0).then(|| db(f64::from(self.peak)));
        let mut warnings = Vec::new();
        if rms.is_some_and(|v| v < self.policy.rms_min_dbfs) {
            warnings.push("speech_low".into());
        }
        if peak.is_some_and(|v| v > self.policy.peak_max_dbfs) {
            warnings.push("speech_high".into());
        }
        let mut live_warnings = Vec::new();
        if self.low_seen {
            live_warnings.push("speech_low".into());
        }
        if self.high_seen {
            live_warnings.push("speech_high".into());
        }
        Some(SpeechQuality {
            policy: self.policy.clone(),
            speech_samples: self.count,
            rms_dbfs: rms,
            peak_dbfs: peak,
            warnings,
            live_warnings,
            retained_by_operator_at: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn meter() -> SpeechMeter {
        SpeechMeter::new(
            RecordingPolicy {
                amplitude_enabled: true,
                ..Default::default()
            },
            1_000,
            32,
        )
    }
    #[test]
    fn metrics_match_the_written_pcm_for_every_delivery_depth() {
        let root = std::env::temp_dir().join(format!(
            "speech-pcm-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let samples = [-1.1, -0.99, -0.001, 0.0, 0.001, 0.42, 0.99, 1.1];
        for depth in [8, 16, 24, 32] {
            let path = root.join(format!("{depth}.wav"));
            let mut writer = crate::wav::RecoverableWav::create(&path, 48_000, 1, depth).unwrap();
            writer.write_samples(&samples).unwrap();
            writer.finalize().unwrap();
            let bytes = std::fs::read(&path).unwrap();
            let data_len = samples.len() * usize::from(depth / 8);
            let decoded =
                crate::wav::decode_encoded_mono_samples(&bytes[bytes.len() - data_len..], depth)
                    .unwrap();
            let peak = decoded.iter().copied().map(f32::abs).fold(0.0f32, f32::max);
            let rms = (decoded
                .iter()
                .map(|sample| f64::from(*sample).powi(2))
                .sum::<f64>()
                / decoded.len() as f64)
                .sqrt();
            let mut meter = SpeechMeter::new(
                RecordingPolicy {
                    amplitude_enabled: true,
                    ..Default::default()
                },
                48_000,
                depth,
            );
            for sample in samples {
                meter.push(sample);
            }
            let result = meter.result().unwrap();
            assert!((result.rms_dbfs.unwrap() - db(rms)).abs() < 0.00001);
            assert!((result.peak_dbfs.unwrap() - db(f64::from(peak))).abs() < 0.00001);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn short_voice_and_silence_do_not_dilute_levels() {
        let mut m = meter();
        for _ in 0..50 {
            m.push(0.01);
        }
        m.silence();
        let q = m.result().unwrap();
        assert_eq!(q.speech_samples, 50);
        assert!((q.rms_dbfs.unwrap() + 40.0).abs() < 0.001);
        assert_eq!(q.warnings, ["speech_low"]);
        assert!(q.live_warnings.is_empty());
    }
    #[test]
    fn sustained_low_and_peak_are_remembered_after_recovery() {
        let mut m = meter();
        for _ in 0..499 {
            m.push(0.01);
        }
        assert!(m.result().unwrap().live_warnings.is_empty());
        m.push(0.01);
        assert!(
            m.result()
                .unwrap()
                .live_warnings
                .contains(&"speech_low".into())
        );
        m.silence();
        for _ in 0..1_000 {
            m.push(0.2);
        }
        m.push(0.9);
        let q = m.result().unwrap();
        assert!(q.live_warnings.contains(&"speech_low".into()));
        assert!(q.warnings.contains(&"speech_high".into()));
    }
    #[test]
    fn equality_is_allowed_and_gaps_reset_low_timer() {
        let mut m = SpeechMeter::new(
            RecordingPolicy {
                amplitude_enabled: true,
                rms_min_dbfs: db(0.125),
                peak_max_dbfs: db(0.5),
                ..Default::default()
            },
            1_000,
            32,
        );
        for _ in 0..600 {
            m.push(0.125);
        }
        m.push(0.5);
        assert!(m.result().unwrap().warnings.is_empty());
        assert!(m.result().unwrap().live_warnings.is_empty());
        let mut m = meter();
        for _ in 0..3 {
            for _ in 0..400 {
                m.push(0.01);
            }
            m.silence();
        }
        assert!(m.result().unwrap().live_warnings.is_empty());
    }
}
