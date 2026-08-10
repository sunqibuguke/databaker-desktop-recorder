use anyhow::{Context, Result, bail};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

const PCM_HEADER_LEN: u64 = 44;
const FLOAT_HEADER_LEN: u64 = 56;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WavEncoding {
    Pcm,
    Float,
}

impl WavEncoding {
    pub fn for_bit_depth(bit_depth: u16) -> Result<Self> {
        match bit_depth {
            16 | 24 => Ok(Self::Pcm),
            32 => Ok(Self::Float),
            _ => bail!("bit depth must be one of 16-bit PCM, 24-bit PCM, or 32-bit Float"),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Pcm => "pcm",
            Self::Float => "float",
        }
    }

    fn format_code(self) -> u16 {
        match self {
            Self::Pcm => 1,
            Self::Float => 3,
        }
    }

    fn header_len(self) -> u64 {
        match self {
            Self::Pcm => PCM_HEADER_LEN,
            Self::Float => FLOAT_HEADER_LEN,
        }
    }
}

fn bytes_per_sample(bit_depth: u16) -> Result<u16> {
    WavEncoding::for_bit_depth(bit_depth)?;
    Ok(bit_depth / 8)
}

pub struct RecoverableWav {
    file: File,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    encoding: WavEncoding,
    samples_written: u64,
}

impl RecoverableWav {
    pub fn create(path: &Path, sample_rate: u32, channels: u16, bit_depth: u16) -> Result<Self> {
        if sample_rate == 0 {
            bail!("sample rate must be greater than zero");
        }
        if channels == 0 {
            bail!("channels must be greater than zero");
        }
        let encoding = WavEncoding::for_bit_depth(bit_depth)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create audio directory {}", parent.display()))?;
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .read(true)
            .write(true)
            .open(path)
            .with_context(|| format!("create WAV {}", path.display()))?;
        let mut wav = Self {
            file,
            sample_rate,
            channels,
            bit_depth,
            encoding,
            samples_written: 0,
        };
        wav.write_header()?;
        wav.file.seek(SeekFrom::Start(encoding.header_len()))?;
        Ok(wav)
    }

    pub fn write_samples(&mut self, samples: &[f32]) -> Result<()> {
        let bytes_per_sample = usize::from(bytes_per_sample(self.bit_depth)?);
        let mut encoded = Vec::with_capacity(samples.len() * bytes_per_sample);
        for sample in samples {
            let sample = sample.clamp(-1.0, 1.0);
            match (self.encoding, self.bit_depth) {
                (WavEncoding::Pcm, 16) => {
                    let value = if sample <= -1.0 {
                        i16::MIN
                    } else {
                        (sample * f32::from(i16::MAX)).round() as i16
                    };
                    encoded.extend_from_slice(&value.to_le_bytes());
                }
                (WavEncoding::Pcm, 24) => {
                    let value = if sample <= -1.0 {
                        -8_388_608i32
                    } else {
                        (sample * 8_388_607.0).round() as i32
                    };
                    encoded.extend_from_slice(&value.to_le_bytes()[..3]);
                }
                (WavEncoding::Float, 32) => {
                    encoded.extend_from_slice(&sample.to_le_bytes());
                }
                _ => unreachable!("validated WAV output format"),
            }
        }
        self.write_encoded_samples(&encoded)
    }

    fn write_encoded_samples(&mut self, bytes: &[u8]) -> Result<()> {
        let sample_bytes = u64::from(bytes_per_sample(self.bit_depth)?);
        if !(bytes.len() as u64).is_multiple_of(sample_bytes) {
            bail!("encoded audio is not aligned to the selected bit depth");
        }
        let sample_count = bytes.len() as u64 / sample_bytes;
        if !sample_count.is_multiple_of(u64::from(self.channels)) {
            bail!("encoded audio does not contain complete channel frames");
        }
        let next_samples = self
            .samples_written
            .checked_add(sample_count)
            .context("WAV sample counter overflow")?;
        let next_data_bytes = next_samples
            .checked_mul(sample_bytes)
            .context("WAV data size overflow")?;
        let next_riff_size = self
            .encoding
            .header_len()
            .checked_sub(8)
            .and_then(|header| header.checked_add(next_data_bytes))
            .context("WAV RIFF size overflow")?;
        if next_riff_size > u64::from(u32::MAX) {
            bail!("WAV file reached the 4 GiB RIFF limit; finish this recording before continuing");
        }
        self.file.write_all(bytes)?;
        self.samples_written = next_samples;
        Ok(())
    }

    pub fn checkpoint(&mut self) -> Result<u64> {
        let end = self.file.stream_position()?;
        self.write_header()?;
        self.file.seek(SeekFrom::Start(end))?;
        self.file.flush()?;
        self.file.sync_data()?;
        Ok(self.frames_written())
    }

    pub fn finalize(mut self) -> Result<u64> {
        self.checkpoint()
    }

    fn frames_written(&self) -> u64 {
        self.samples_written / u64::from(self.channels)
    }

    fn write_header(&mut self) -> Result<()> {
        let sample_bytes = u64::from(bytes_per_sample(self.bit_depth)?);
        let data_bytes = self
            .samples_written
            .checked_mul(sample_bytes)
            .context("WAV data size overflow")?;
        let riff_size = self
            .encoding
            .header_len()
            .checked_sub(8)
            .and_then(|header| header.checked_add(data_bytes))
            .context("WAV RIFF size overflow")?;
        if riff_size > u64::from(u32::MAX) {
            bail!("WAV file reached the 4 GiB RIFF limit; finish this recording before continuing");
        }
        let data_size = u32::try_from(data_bytes)?;
        let byte_rate = self
            .sample_rate
            .checked_mul(u32::from(self.channels))
            .and_then(|value| value.checked_mul(u32::try_from(sample_bytes).ok()?))
            .context("WAV byte rate overflow")?;
        let block_align = self
            .channels
            .checked_mul(u16::try_from(sample_bytes)?)
            .context("WAV block alignment overflow")?;

        self.file.seek(SeekFrom::Start(0))?;
        self.file.write_all(b"RIFF")?;
        self.file.write_all(&(riff_size as u32).to_le_bytes())?;
        self.file.write_all(b"WAVE")?;
        self.file.write_all(b"fmt ")?;
        self.file.write_all(&16u32.to_le_bytes())?;
        self.file
            .write_all(&self.encoding.format_code().to_le_bytes())?;
        self.file.write_all(&self.channels.to_le_bytes())?;
        self.file.write_all(&self.sample_rate.to_le_bytes())?;
        self.file.write_all(&byte_rate.to_le_bytes())?;
        self.file.write_all(&block_align.to_le_bytes())?;
        self.file.write_all(&self.bit_depth.to_le_bytes())?;
        if self.encoding == WavEncoding::Float {
            let frame_count = u32::try_from(self.frames_written())?;
            self.file.write_all(b"fact")?;
            self.file.write_all(&4u32.to_le_bytes())?;
            self.file.write_all(&frame_count.to_le_bytes())?;
        }
        self.file.write_all(b"data")?;
        self.file.write_all(&data_size.to_le_bytes())?;
        Ok(())
    }
}

pub fn slice_wav_mono(
    source: &Path,
    destination: &Path,
    sample_rate: u32,
    bit_depth: u16,
    start_frame: u64,
    end_frame: u64,
) -> Result<()> {
    if end_frame <= start_frame {
        bail!("invalid slice: end must be after start");
    }
    let encoding = WavEncoding::for_bit_depth(bit_depth)?;
    let frame_bytes = u64::from(bytes_per_sample(bit_depth)?);
    let mut input =
        File::open(source).with_context(|| format!("open source WAV {}", source.display()))?;
    let input_len = input.metadata()?.len();
    let start_byte = encoding.header_len() + start_frame * frame_bytes;
    let end_byte = encoding.header_len() + end_frame * frame_bytes;
    if end_byte > input_len {
        bail!(
            "slice exceeds committed audio: requested byte {}, file length {}",
            end_byte,
            input_len
        );
    }
    input.seek(SeekFrom::Start(start_byte))?;
    let mut output = RecoverableWav::create(destination, sample_rate, 1, bit_depth)?;
    let mut remaining = end_byte - start_byte;
    // 48 KiB is divisible by 2, 3, and 4 bytes per sample.
    let mut bytes = vec![0u8; 48 * 1024];
    while remaining > 0 {
        let count = usize::try_from(remaining.min(bytes.len() as u64))?;
        input.read_exact(&mut bytes[..count])?;
        output.write_encoded_samples(&bytes[..count])?;
        remaining -= count as u64;
    }
    output.finalize()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "recorder-engine-wav-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn writes_and_slices_every_supported_bit_depth() {
        for (bit_depth, header_len, bytes_per_sample, format_code) in
            [(16, 44, 2, 1u16), (24, 44, 3, 1u16), (32, 56, 4, 3u16)]
        {
            let root = test_root(&bit_depth.to_string());
            let source = root.join("source.wav");
            let slice = root.join("slice.wav");
            let samples = [-1.0, -0.5, 0.0, 0.25, 0.5, 1.0];
            let mut writer = RecoverableWav::create(&source, 48_000, 1, bit_depth).unwrap();
            writer.write_samples(&samples).unwrap();
            writer.finalize().unwrap();
            slice_wav_mono(&source, &slice, 48_000, bit_depth, 1, 5).unwrap();

            let source_bytes = std::fs::read(&source).unwrap();
            let slice_bytes = std::fs::read(&slice).unwrap();
            assert_eq!(
                source_bytes.len(),
                header_len + samples.len() * bytes_per_sample
            );
            assert_eq!(slice_bytes.len(), header_len + 4 * bytes_per_sample);
            assert_eq!(
                u16::from_le_bytes([source_bytes[20], source_bytes[21]]),
                format_code
            );
            assert_eq!(
                u16::from_le_bytes([source_bytes[34], source_bytes[35]]),
                bit_depth
            );
            assert_eq!(
                &slice_bytes[header_len..],
                &source_bytes[header_len + bytes_per_sample..header_len + 5 * bytes_per_sample]
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn rejects_unsupported_bit_depth() {
        let root = test_root("unsupported");
        let result = RecoverableWav::create(&root.join("invalid.wav"), 48_000, 1, 20);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_a_block_before_crossing_the_riff_limit() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("limit-{bit_depth}"));
            let path = root.join("limit.wav");
            let mut writer = RecoverableWav::create(&path, 48_000, 1, bit_depth).unwrap();
            let sample_bytes = u64::from(bytes_per_sample(bit_depth).unwrap());
            let maximum_data_bytes = u64::from(u32::MAX) - (writer.encoding.header_len() - 8);
            writer.samples_written = maximum_data_bytes / sample_bytes;
            let initial_len = std::fs::metadata(&path).unwrap().len();

            let result = writer.write_samples(&[0.0]);

            assert!(result.is_err());
            assert_eq!(std::fs::metadata(&path).unwrap().len(), initial_len);
            let _ = std::fs::remove_dir_all(root);
        }
    }
}
