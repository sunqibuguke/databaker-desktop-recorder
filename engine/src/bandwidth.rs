//! Cheap capture-side bandwidth probe used by the room-noise check.
//!
//! A 16 kHz chain upsampled to 48 kHz has a brick wall at 8 kHz. Real 48 kHz
//! capture still has energy (speech, hiss, room) above that.

use std::sync::{Arc, Mutex};

const RING_CAPACITY: usize = 16_384;
const FFT_SIZE: usize = 2_048;
const MIN_MID_DBFS: f32 = -70.0;
const BRICKWALL_RATIO_DB: f32 = -30.0;

#[derive(Debug, Clone)]
pub struct BandwidthVerdict {
    pub conclusive: bool,
    pub passed: bool,
    pub ratio_db: Option<f32>,
}

#[derive(Debug)]
struct BandwidthRing {
    samples: Vec<f32>,
    write: usize,
    filled: usize,
}

impl BandwidthRing {
    fn new() -> Self {
        Self {
            samples: vec![0.0; RING_CAPACITY],
            write: 0,
            filled: 0,
        }
    }

    fn push(&mut self, samples: &[f32]) {
        for &sample in samples {
            if !sample.is_finite() {
                continue;
            }
            self.samples[self.write] = sample.clamp(-1.0, 1.0);
            self.write += 1;
            if self.write == RING_CAPACITY {
                self.write = 0;
            }
            self.filled = (self.filled + 1).min(RING_CAPACITY);
        }
    }

    fn snapshot(&self) -> Vec<f32> {
        if self.filled == 0 {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(self.filled);
        let start = if self.filled == RING_CAPACITY {
            self.write
        } else {
            0
        };
        for index in 0..self.filled {
            out.push(self.samples[(start + index) % RING_CAPACITY]);
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct BandwidthProbe {
    sample_rate: Arc<std::sync::atomic::AtomicU32>,
    ring: Arc<Mutex<BandwidthRing>>,
}

impl Default for BandwidthProbe {
    fn default() -> Self {
        Self::new(0)
    }
}

impl BandwidthProbe {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate: Arc::new(std::sync::atomic::AtomicU32::new(sample_rate)),
            ring: Arc::new(Mutex::new(BandwidthRing::new())),
        }
    }

    pub fn push(&self, samples: &[f32]) {
        let Ok(mut ring) = self.ring.try_lock() else {
            return;
        };
        ring.push(samples);
    }

    pub fn evaluate(&self) -> BandwidthVerdict {
        let sample_rate = self.sample_rate.load(std::sync::atomic::Ordering::Relaxed);
        let Ok(ring) = self.ring.lock() else {
            return BandwidthVerdict {
                conclusive: false,
                passed: true,
                ratio_db: None,
            };
        };
        evaluate_bandwidth(&ring.snapshot(), sample_rate)
    }
}

pub fn evaluate_bandwidth(samples: &[f32], sample_rate: u32) -> BandwidthVerdict {
    if sample_rate < 44_100 || samples.len() < FFT_SIZE {
        return BandwidthVerdict {
            conclusive: false,
            passed: true,
            ratio_db: None,
        };
    }
    let nyquist = sample_rate as f32 / 2.0;
    if nyquist <= 12_000.0 {
        return BandwidthVerdict {
            conclusive: false,
            passed: true,
            ratio_db: None,
        };
    }

    let mut mid = 0.0f64;
    let mut high = 0.0f64;
    let mut windows = 0usize;
    let hop = FFT_SIZE / 2;
    let mut offset = 0;
    while offset + FFT_SIZE <= samples.len() {
        let (window_mid, window_high) =
            band_power(&samples[offset..offset + FFT_SIZE], sample_rate);
        mid += window_mid;
        high += window_high;
        windows += 1;
        offset += hop;
    }
    if windows == 0 {
        return BandwidthVerdict {
            conclusive: false,
            passed: true,
            ratio_db: None,
        };
    }
    mid /= windows as f64;
    high /= windows as f64;
    let mid_dbfs = linear_power_to_dbfs(mid);
    if mid_dbfs < MIN_MID_DBFS {
        return BandwidthVerdict {
            conclusive: false,
            passed: true,
            ratio_db: None,
        };
    }
    let ratio_db = if mid <= 0.0 || high <= 0.0 {
        -96.0
    } else {
        (10.0 * (high / mid).log10()) as f32
    };
    BandwidthVerdict {
        conclusive: true,
        passed: ratio_db > BRICKWALL_RATIO_DB,
        ratio_db: Some(ratio_db),
    }
}

fn band_power(frame: &[f32], sample_rate: u32) -> (f64, f64) {
    let mut spectrum = [0.0f32; FFT_SIZE];
    for (index, sample) in frame.iter().take(FFT_SIZE).enumerate() {
        let window =
            0.5 - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / (FFT_SIZE as f32 - 1.0)).cos();
        spectrum[index] = sample * window;
    }
    real_fft_inplace(&mut spectrum);

    let bin_hz = sample_rate as f32 / FFT_SIZE as f32;
    let mut mid = 0.0f64;
    let mut high = 0.0f64;
    for bin in 1..(FFT_SIZE / 2) {
        let hz = bin as f32 * bin_hz;
        let real = spectrum[bin];
        let imag = if bin == 0 || bin == FFT_SIZE / 2 {
            0.0
        } else {
            spectrum[FFT_SIZE - bin]
        };
        let power = f64::from(real * real + imag * imag);
        if (2_000.0..6_000.0).contains(&hz) {
            mid += power;
        } else if (8_000.0..16_000.0).contains(&hz) {
            high += power;
        }
    }
    (mid, high)
}

fn real_fft_inplace(data: &mut [f32]) {
    let n = data.len();
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            data.swap(i, j);
        }
    }
    // Complex FFT packed as [re0, re1, ..., re_n/2, im_n/2-1, ..., im1] is messy.
    // Use an explicit complex buffer instead.
    let mut complex = vec![(0.0f32, 0.0f32); n];
    for (index, sample) in data.iter().enumerate() {
        complex[index].0 = *sample;
    }
    let mut length = 2usize;
    while length <= n {
        let angle = -2.0 * std::f32::consts::PI / length as f32;
        let (w_re, w_im) = (angle.cos(), angle.sin());
        for start in (0..n).step_by(length) {
            let mut wr = 1.0f32;
            let mut wi = 0.0f32;
            let half = length / 2;
            for offset in 0..half {
                let even = complex[start + offset];
                let odd = complex[start + offset + half];
                let t_re = wr * odd.0 - wi * odd.1;
                let t_im = wr * odd.1 + wi * odd.0;
                complex[start + offset] = (even.0 + t_re, even.1 + t_im);
                complex[start + offset + half] = (even.0 - t_re, even.1 - t_im);
                let next_wr = wr * w_re - wi * w_im;
                wi = wr * w_im + wi * w_re;
                wr = next_wr;
            }
        }
        length <<= 1;
    }
    for (index, (re, im)) in complex.iter().enumerate() {
        if index <= n / 2 {
            data[index] = *re;
        } else {
            data[index] = *im;
        }
    }
    // Store imaginary parts of bins 1..n/2-1 at the mirrored slots.
    for bin in 1..n / 2 {
        data[n - bin] = complex[bin].1;
    }
}

fn linear_power_to_dbfs(power: f64) -> f32 {
    if power <= 1e-12 {
        -96.0
    } else {
        ((10.0 * power.log10()) as f32).max(-96.0)
    }
}

#[cfg(test)]
mod tests {
    use super::{FFT_SIZE, evaluate_bandwidth};

    fn tone(sample_rate: u32, hz: f32, seconds: f32) -> Vec<f32> {
        let count = (sample_rate as f32 * seconds) as usize;
        (0..count)
            .map(|index| {
                (2.0 * std::f32::consts::PI * hz * index as f32 / sample_rate as f32).sin() * 0.2
            })
            .collect()
    }

    #[test]
    fn real_48k_with_high_band_energy_passes() {
        let sample_rate = 48_000;
        let mut samples = tone(sample_rate, 3_000.0, 0.12);
        let high = tone(sample_rate, 10_000.0, 0.12);
        for (index, sample) in samples.iter_mut().enumerate() {
            *sample += high[index] * 0.5;
        }
        let verdict = evaluate_bandwidth(&samples, sample_rate);
        assert!(verdict.conclusive, "{verdict:?}");
        assert!(verdict.passed, "{verdict:?}");
    }

    #[test]
    fn sixteen_khz_brickwall_fails() {
        let sample_rate = 48_000;
        // Band-limited 3 kHz tone: no energy above 8 kHz.
        let samples = tone(sample_rate, 3_000.0, 0.12);
        assert!(samples.len() >= FFT_SIZE);
        let verdict = evaluate_bandwidth(&samples, sample_rate);
        assert!(verdict.conclusive, "{verdict:?}");
        assert!(!verdict.passed, "{verdict:?}");
        assert!(verdict.ratio_db.unwrap() <= -30.0, "{verdict:?}");
    }

    #[test]
    fn too_quiet_or_too_short_is_inconclusive() {
        let quiet = vec![1e-6f32; 4_096];
        let verdict = evaluate_bandwidth(&quiet, 48_000);
        assert!(!verdict.conclusive);
        assert!(verdict.passed);

        let short = vec![0.2f32; 128];
        let verdict = evaluate_bandwidth(&short, 48_000);
        assert!(!verdict.conclusive);
    }
}
