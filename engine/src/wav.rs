use crate::durable_fs::durable_replace;
use anyhow::{Context, Result, bail};
use std::ffi::OsString;
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

/// Rejects a standard RIFF/WAVE render before any multi-gigabyte copy starts.
/// The segmented master remains the durable source of truth for recordings
/// whose continuous timeline no longer fits in a single 32-bit RIFF container.
pub(crate) fn validate_standard_wav_size(frames: u64, channels: u16, bit_depth: u16) -> Result<()> {
    if channels == 0 {
        bail!("channel count must be greater than zero");
    }
    let encoding = WavEncoding::for_bit_depth(bit_depth)?;
    let frame_bytes = u64::from(bytes_per_sample(bit_depth)?)
        .checked_mul(u64::from(channels))
        .context("WAV frame size overflow")?;
    let data_bytes = frames
        .checked_mul(frame_bytes)
        .context("WAV data size overflow")?;
    let riff_size = encoding
        .header_len()
        .checked_sub(8)
        .and_then(|header| header.checked_add(data_bytes))
        .context("WAV RIFF size overflow")?;
    if riff_size > u64::from(u32::MAX) {
        bail!(
            "整轨大小超过标准 RIFF/WAV 4 GiB 上限，当前版本不能生成单个 full-track.wav；分段母轨仍完整，请按分段交付或缩短录制时长。"
        );
    }
    Ok(())
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
        Self::create_inner(path, sample_rate, channels, bit_depth, false)
    }

    pub(crate) fn create_new(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
    ) -> Result<Self> {
        Self::create_inner(path, sample_rate, channels, bit_depth, true)
    }

    fn create_inner(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        create_new: bool,
    ) -> Result<Self> {
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
        let mut options = OpenOptions::new();
        options.read(true).write(true);
        if create_new {
            options.create_new(true);
        } else {
            options.create(true).truncate(true);
        }
        let file = options
            .open(path)
            .with_context(|| format!("create WAV {}", path.display()))?;
        file.try_lock()
            .with_context(|| format!("lock WAV {} for recording", path.display()))?;
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

    pub fn open_append(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
    ) -> Result<Self> {
        if sample_rate == 0 {
            bail!("sample rate must be greater than zero");
        }
        if channels == 0 {
            bail!("channels must be greater than zero");
        }
        let encoding = WavEncoding::for_bit_depth(bit_depth)?;
        let metadata = std::fs::symlink_metadata(path)
            .with_context(|| format!("inspect existing WAV {}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!("existing WAV must be a regular file");
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .with_context(|| format!("open existing WAV {}", path.display()))?;
        file.try_lock()
            .with_context(|| format!("lock WAV {} for resumed recording", path.display()))?;
        let header_len = encoding.header_len();
        let file_len = file.metadata()?.len();
        if file_len < header_len {
            bail!("existing WAV is shorter than its required header");
        }
        let mut header = vec![0u8; usize::try_from(header_len)?];
        file.read_exact(&mut header)?;
        if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" || &header[12..16] != b"fmt " {
            bail!("existing audio is not a supported RIFF/WAVE file");
        }
        let read_u16 = |offset: usize| u16::from_le_bytes([header[offset], header[offset + 1]]);
        let read_u32 =
            |offset: usize| u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap());
        if read_u32(16) != 16
            || read_u16(20) != encoding.format_code()
            || read_u16(22) != channels
            || read_u32(24) != sample_rate
            || read_u16(34) != bit_depth
        {
            bail!("existing WAV format does not match the recording settings");
        }
        let expected_block_align = channels
            .checked_mul(bytes_per_sample(bit_depth)?)
            .context("WAV block alignment overflow")?;
        if read_u16(32) != expected_block_align {
            bail!("existing WAV block alignment is invalid");
        }
        let data_marker = if encoding == WavEncoding::Float {
            48
        } else {
            36
        };
        if encoding == WavEncoding::Float && (&header[36..40] != b"fact" || read_u32(40) != 4) {
            bail!("existing float WAV is missing its fact chunk");
        }
        if &header[data_marker..data_marker + 4] != b"data" {
            bail!("existing WAV has an unsupported chunk layout");
        }
        // The physical EOF is authoritative during crash recovery. A checkpoint
        // deliberately makes audio durable before advancing the header, so a
        // stale header is expected after power loss. Older versions could also
        // leave the header ahead of durable audio. In both cases, retain every
        // complete physical frame and rebuild the mutable header counters.
        let actual_data_bytes = file_len - header_len;
        let frame_bytes = u64::from(expected_block_align);
        let complete_data_bytes = actual_data_bytes - (actual_data_bytes % frame_bytes);
        let maximum_data_bytes = u64::from(u32::MAX)
            .checked_sub(header_len - 8)
            .context("WAV RIFF size underflow")?;
        if complete_data_bytes > maximum_data_bytes {
            bail!("existing WAV exceeds the 4 GiB RIFF limit");
        }
        let repaired_file_len = header_len + complete_data_bytes;
        if repaired_file_len != file_len {
            file.set_len(repaired_file_len)
                .context("truncate incomplete WAV tail")?;
        }
        let samples_written = complete_data_bytes / u64::from(bytes_per_sample(bit_depth)?);
        file.seek(SeekFrom::Start(repaired_file_len))?;
        let mut wav = Self {
            file,
            sample_rate,
            channels,
            bit_depth,
            encoding,
            samples_written,
        };
        // Repair RIFF/data/fact sizes before accepting any appended samples.
        // This also durably records a tail truncation before the header points
        // at the recovered physical EOF.
        wav.checkpoint().context("repair existing WAV header")?;
        Ok(wav)
    }

    pub fn write_samples(&mut self, samples: &[f32]) -> Result<()> {
        let bytes_per_sample = usize::from(bytes_per_sample(self.bit_depth)?);
        let mut encoded = Vec::with_capacity(samples.len() * bytes_per_sample);
        for sample in samples {
            let sample = sample.clamp(-1.0, 1.0);
            match (self.encoding, self.bit_depth) {
                (WavEncoding::Pcm, 16) => {
                    let value = (sample * 32_768.0)
                        .round()
                        .clamp(f32::from(i16::MIN), f32::from(i16::MAX))
                        as i16;
                    encoded.extend_from_slice(&value.to_le_bytes());
                }
                (WavEncoding::Pcm, 24) => {
                    let value = (sample * 8_388_608.0)
                        .round()
                        .clamp(-8_388_608.0, 8_388_607.0) as i32;
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

    pub(crate) fn write_encoded_samples(&mut self, bytes: &[u8]) -> Result<()> {
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

    /// Snapshots encoded frames through the same handle that owns the WAV lock.
    /// This is required on Windows, where `LockFileEx` prevents even the locking
    /// process from reading the locked range through a second file handle.
    pub(crate) fn read_encoded_frames(
        &mut self,
        start_frame: u64,
        end_frame: u64,
    ) -> Result<Vec<u8>> {
        if end_frame <= start_frame || end_frame > self.frames_written() {
            bail!("invalid WAV frame copy range");
        }
        let frame_bytes = u64::from(self.channels)
            .checked_mul(u64::from(bytes_per_sample(self.bit_depth)?))
            .context("WAV frame size overflow")?;
        let restore_position = self.file.stream_position()?;
        let read_result = (|| -> Result<Vec<u8>> {
            let start_byte = self
                .encoding
                .header_len()
                .checked_add(
                    start_frame
                        .checked_mul(frame_bytes)
                        .context("WAV copy offset overflow")?,
                )
                .context("WAV copy offset overflow")?;
            self.file.seek(SeekFrom::Start(start_byte))?;
            let byte_count = (end_frame - start_frame)
                .checked_mul(frame_bytes)
                .context("WAV copy length overflow")?;
            let mut bytes = vec![0u8; usize::try_from(byte_count)?];
            self.file.read_exact(&mut bytes)?;
            Ok(bytes)
        })();
        let seek_result = self.file.seek(SeekFrom::Start(restore_position));
        let bytes = read_result?;
        seek_result?;
        Ok(bytes)
    }

    pub fn checkpoint(&mut self) -> Result<u64> {
        let end = self.file.stream_position()?;
        // Data must reach durable storage before the header is allowed to claim
        // it exists. A crash between these phases therefore leaves a stale
        // header, which open_append repairs from the complete physical EOF.
        self.file.flush()?;
        self.file.sync_data()?;
        let header_result = (|| -> Result<()> {
            self.write_header()?;
            self.file.flush()?;
            self.file.sync_data()?;
            Ok(())
        })();
        // Always restore the append position, including after a header I/O
        // failure, so an ignored checkpoint error cannot overwrite audio.
        let seek_result = self.file.seek(SeekFrom::Start(end));
        header_result?;
        seek_result?;
        Ok(self.frames_written())
    }

    pub fn finalize(mut self) -> Result<u64> {
        self.checkpoint()
    }

    pub fn frames_written(&self) -> u64 {
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
    if source == destination {
        bail!("cannot slice a WAV over its source file");
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
    let temporary = wav_export_temp_path(destination, "slicing")?;
    prepare_wav_export_temp(&temporary)?;
    let result = (|| -> Result<()> {
        let mut output = RecoverableWav::create_new(&temporary, sample_rate, 1, bit_depth)?;
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
        durable_replace(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() {
        remove_wav_export_temp_best_effort(&temporary);
    }
    result
}

fn wav_export_temp_path(destination: &Path, operation: &str) -> Result<std::path::PathBuf> {
    let file_name = destination
        .file_name()
        .context("WAV export destination has no file name")?;
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(".{operation}"));
    Ok(destination.with_file_name(temporary_name))
}

fn prepare_wav_export_temp(temporary: &Path) -> Result<()> {
    match std::fs::symlink_metadata(temporary) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!(
                    "temporary WAV export must be a regular file: {}",
                    temporary.display()
                );
            }
            std::fs::remove_file(temporary).with_context(|| {
                format!("remove stale temporary WAV export {}", temporary.display())
            })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("inspect temporary WAV export {}", temporary.display()));
        }
    }
    Ok(())
}

fn remove_wav_export_temp_best_effort(temporary: &Path) {
    if let Ok(metadata) = std::fs::symlink_metadata(temporary)
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        let _ = std::fs::remove_file(temporary);
    }
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

    fn assert_header_matches_physical_eof(path: &Path, bit_depth: u16, frames: u64) {
        let bytes = std::fs::read(path).unwrap();
        let encoding = WavEncoding::for_bit_depth(bit_depth).unwrap();
        let header_len = encoding.header_len();
        let data_bytes = frames * u64::from(bytes_per_sample(bit_depth).unwrap());
        assert_eq!(bytes.len() as u64, header_len + data_bytes);
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            u32::try_from(header_len - 8 + data_bytes).unwrap()
        );
        let data_size_offset = if encoding == WavEncoding::Float {
            52
        } else {
            40
        };
        assert_eq!(
            u32::from_le_bytes(
                bytes[data_size_offset..data_size_offset + 4]
                    .try_into()
                    .unwrap()
            ),
            u32::try_from(data_bytes).unwrap()
        );
        if encoding == WavEncoding::Float {
            assert_eq!(
                u32::from_le_bytes(bytes[44..48].try_into().unwrap()),
                u32::try_from(frames).unwrap()
            );
        }
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
    fn pcm_integer_normalization_round_trips_without_losing_positive_full_scale() {
        let root = test_root("pcm-bit-exact");

        let values_16 = (i16::MIN..=i16::MAX).collect::<Vec<_>>();
        let normalized_16 = values_16
            .iter()
            .map(|value| f32::from(*value) / 32_768.0)
            .collect::<Vec<_>>();
        let path_16 = root.join("roundtrip-16.wav");
        let mut writer = RecoverableWav::create(&path_16, 48_000, 1, 16).unwrap();
        writer.write_samples(&normalized_16).unwrap();
        writer.finalize().unwrap();
        let bytes_16 = std::fs::read(&path_16).unwrap();
        let decoded_16 = bytes_16[PCM_HEADER_LEN as usize..]
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
            .collect::<Vec<_>>();
        assert_eq!(decoded_16, values_16);

        let mut values_24 = vec![-8_388_608, -8_388_607, -1, 0, 1, 8_388_606, 8_388_607];
        let mut state = 0x7a31_4f29u32;
        for _ in 0..20_000 {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let raw = (state & 0x00ff_ffff) as i32;
            values_24.push(if raw & 0x0080_0000 != 0 {
                raw | !0x00ff_ffff
            } else {
                raw
            });
        }
        let normalized_24 = values_24
            .iter()
            .map(|value| *value as f32 / 8_388_608.0)
            .collect::<Vec<_>>();
        let path_24 = root.join("roundtrip-24.wav");
        let mut writer = RecoverableWav::create(&path_24, 48_000, 1, 24).unwrap();
        writer.write_samples(&normalized_24).unwrap();
        writer.finalize().unwrap();
        let bytes_24 = std::fs::read(&path_24).unwrap();
        let decoded_24 = bytes_24[PCM_HEADER_LEN as usize..]
            .chunks_exact(3)
            .map(|bytes| {
                let raw = i32::from_le_bytes([bytes[0], bytes[1], bytes[2], 0]);
                if raw & 0x0080_0000 != 0 {
                    raw | !0x00ff_ffff
                } else {
                    raw
                }
            })
            .collect::<Vec<_>>();
        assert_eq!(decoded_24, values_24);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_unsupported_bit_depth() {
        let root = test_root("unsupported");
        let result = RecoverableWav::create(&root.join("invalid.wav"), 48_000, 1, 20);
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reopens_and_appends_without_changing_existing_audio() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("append-{bit_depth}"));
            let path = root.join("append.wav");
            let initial = [-0.75, -0.25, 0.25];
            let appended = [0.5, 0.75];
            let mut writer = RecoverableWav::create(&path, 48_000, 1, bit_depth).unwrap();
            writer.write_samples(&initial).unwrap();
            writer.finalize().unwrap();
            let before = std::fs::read(&path).unwrap();

            let mut resumed = RecoverableWav::open_append(&path, 48_000, 1, bit_depth).unwrap();
            assert_eq!(resumed.frames_written(), initial.len() as u64);
            resumed.write_samples(&appended).unwrap();
            assert_eq!(
                resumed.finalize().unwrap(),
                (initial.len() + appended.len()) as u64
            );

            let after = std::fs::read(&path).unwrap();
            let header_len = WavEncoding::for_bit_depth(bit_depth).unwrap().header_len() as usize;
            assert_eq!(
                &after[header_len..header_len + before.len() - header_len],
                &before[header_len..]
            );
            assert_eq!(
                after.len(),
                header_len + (initial.len() + appended.len()) * usize::from(bit_depth / 8)
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn append_rejects_a_format_mismatch() {
        let root = test_root("append-mismatch");
        let path = root.join("source.wav");
        RecoverableWav::create(&path, 48_000, 1, 24)
            .unwrap()
            .finalize()
            .unwrap();
        assert!(RecoverableWav::open_append(&path, 44_100, 1, 24).is_err());
        assert!(RecoverableWav::open_append(&path, 48_000, 1, 16).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn recovers_audio_synced_before_its_header_checkpoint() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("append-power-loss-{bit_depth}"));
            let path = root.join("source.wav");
            let mut writer = RecoverableWav::create(&path, 48_000, 1, bit_depth).unwrap();
            writer.write_samples(&[0.1, 0.2, 0.3]).unwrap();

            // Simulate power loss after checkpoint phase one: audio is durable,
            // while the header still declares the empty file created initially.
            writer.file.flush().unwrap();
            writer.file.sync_data().unwrap();
            drop(writer);

            let resumed = RecoverableWav::open_append(&path, 48_000, 1, bit_depth).unwrap();
            assert_eq!(resumed.frames_written(), 3);
            drop(resumed);
            assert_header_matches_physical_eof(&path, bit_depth, 3);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn repairs_a_stale_header_from_complete_physical_frames() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("append-stale-header-{bit_depth}"));
            let path = root.join("source.wav");
            let mut writer = RecoverableWav::create(&path, 48_000, 1, bit_depth).unwrap();
            writer.write_samples(&[0.1, 0.2]).unwrap();
            writer.finalize().unwrap();

            let mut raw = OpenOptions::new().append(true).open(&path).unwrap();
            raw.write_all(&vec![0; usize::from(bit_depth / 8)]).unwrap();
            raw.sync_all().unwrap();
            drop(raw);

            let resumed = RecoverableWav::open_append(&path, 48_000, 1, bit_depth).unwrap();
            assert_eq!(resumed.frames_written(), 3);
            drop(resumed);
            assert_header_matches_physical_eof(&path, bit_depth, 3);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn truncates_an_incomplete_tail_to_the_last_complete_frame() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("append-torn-tail-{bit_depth}"));
            let path = root.join("source.wav");
            let mut writer = RecoverableWav::create(&path, 48_000, 1, bit_depth).unwrap();
            writer.write_samples(&[0.1, 0.2, 0.3]).unwrap();
            writer.finalize().unwrap();
            let complete = std::fs::read(&path).unwrap();

            let mut raw = OpenOptions::new().append(true).open(&path).unwrap();
            raw.write_all(&vec![0x7f; usize::from(bit_depth / 8 - 1)])
                .unwrap();
            raw.sync_all().unwrap();
            drop(raw);

            let resumed = RecoverableWav::open_append(&path, 48_000, 1, bit_depth).unwrap();
            assert_eq!(resumed.frames_written(), 3);
            drop(resumed);
            assert_eq!(std::fs::read(&path).unwrap(), complete);
            assert_header_matches_physical_eof(&path, bit_depth, 3);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn repairs_a_header_that_is_ahead_of_physical_audio() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("append-header-ahead-{bit_depth}"));
            let path = root.join("source.wav");
            let mut writer = RecoverableWav::create(&path, 48_000, 1, bit_depth).unwrap();
            writer.write_samples(&[0.1, 0.2, 0.3]).unwrap();
            writer.finalize().unwrap();

            let header_len = WavEncoding::for_bit_depth(bit_depth).unwrap().header_len();
            let sample_bytes = u64::from(bytes_per_sample(bit_depth).unwrap());
            let raw = OpenOptions::new().write(true).open(&path).unwrap();
            raw.set_len(header_len + 2 * sample_bytes).unwrap();
            raw.sync_all().unwrap();
            drop(raw);

            let resumed = RecoverableWav::open_append(&path, 48_000, 1, bit_depth).unwrap();
            assert_eq!(resumed.frames_written(), 2);
            drop(resumed);
            assert_header_matches_physical_eof(&path, bit_depth, 2);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn a_second_writer_cannot_lock_the_same_master() {
        let root = test_root("append-lock");
        let path = root.join("source.wav");
        let writer = RecoverableWav::create(&path, 48_000, 1, 16).unwrap();
        assert!(RecoverableWav::open_append(&path, 48_000, 1, 16).is_err());
        drop(writer);
        assert!(RecoverableWav::open_append(&path, 48_000, 1, 16).is_ok());
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

    #[test]
    fn preflights_standard_riff_size_without_writing_a_file() {
        for bit_depth in [16, 24, 32] {
            let encoding = WavEncoding::for_bit_depth(bit_depth).unwrap();
            let frame_bytes = u64::from(bytes_per_sample(bit_depth).unwrap());
            let maximum_data_bytes = u64::from(u32::MAX) - (encoding.header_len() - 8);
            let maximum_frames = maximum_data_bytes / frame_bytes;

            validate_standard_wav_size(maximum_frames, 1, bit_depth).unwrap();
            let error = validate_standard_wav_size(maximum_frames + 1, 1, bit_depth)
                .unwrap_err()
                .to_string();
            assert!(error.contains("4 GiB"));
            assert!(error.contains("full-track.wav"));
        }
    }
}
