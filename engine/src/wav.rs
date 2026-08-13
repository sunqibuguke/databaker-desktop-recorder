use crate::durable_fs::{durable_create_directory_all, durable_replace};
use anyhow::{Context, Result, bail};
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

const PCM_HEADER_LEN: u64 = 44;
const FLOAT_HEADER_LEN: u64 = 56;
const RF64_DS64_CHUNK_DATA_LEN: u32 = 28;
const RF64_HEADER_GROWTH: u64 = 36;

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

pub(crate) const REVIEW_WAVEFORM_BIN_SAMPLES: usize = 64;

pub(crate) fn decode_encoded_mono_samples(bytes: &[u8], bit_depth: u16) -> Result<Vec<f32>> {
    let sample_bytes = usize::from(bytes_per_sample(bit_depth)?);
    if !bytes.len().is_multiple_of(sample_bytes) {
        bail!("encoded PCM length is not a whole number of samples");
    }
    let mut samples = Vec::with_capacity(bytes.len() / sample_bytes);
    match bit_depth {
        16 => {
            for chunk in bytes.chunks_exact(2) {
                let value = i16::from_le_bytes([chunk[0], chunk[1]]);
                samples.push(f32::from(value) / 32_768.0);
            }
        }
        24 => {
            for chunk in bytes.chunks_exact(3) {
                let sign = if chunk[2] & 0x80 == 0 { 0 } else { 0xFF };
                let value = i32::from_le_bytes([chunk[0], chunk[1], chunk[2], sign]);
                samples.push(value as f32 / 8_388_608.0);
            }
        }
        32 => {
            for chunk in bytes.chunks_exact(4) {
                samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
            }
        }
        _ => bail!("bit depth must be one of 16-bit PCM, 24-bit PCM, or 32-bit Float"),
    }
    Ok(samples)
}

pub(crate) struct ReviewWaveformFold {
    pending: usize,
    minimum: f32,
    maximum: f32,
    bins: Vec<[f32; 2]>,
}

impl ReviewWaveformFold {
    pub(crate) fn new() -> Self {
        Self {
            pending: 0,
            minimum: 0.0,
            maximum: 0.0,
            bins: Vec::new(),
        }
    }

    pub(crate) fn push_bytes(&mut self, bytes: &[u8], bit_depth: u16) -> Result<()> {
        for sample in decode_encoded_mono_samples(bytes, bit_depth)? {
            let normalized = sample.clamp(-1.0, 1.0);
            self.minimum = self.minimum.min(normalized);
            self.maximum = self.maximum.max(normalized);
            self.pending += 1;
            if self.pending == REVIEW_WAVEFORM_BIN_SAMPLES {
                self.bins.push([self.minimum, self.maximum]);
                self.pending = 0;
                self.minimum = 0.0;
                self.maximum = 0.0;
            }
        }
        Ok(())
    }

    pub(crate) fn finish(mut self) -> Vec<[f32; 2]> {
        if self.pending > 0 {
            self.bins.push([self.minimum, self.maximum]);
        }
        self.bins
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WavExportMode {
    /// Sentence bundles and previews stay ordinary RIFF/WAVE. They should
    /// remain maximally compatible and are expected to be much smaller than
    /// the continuous master timeline.
    StandardRiff,
    /// Full-track delivery stays RIFF below the 4 GiB boundary and switches to
    /// RF64 only when the exact final frame count requires 64-bit chunk sizes.
    AutoRf64,
    #[cfg(test)]
    ForceRf64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WavContainer {
    Riff,
    Rf64,
}

#[derive(Debug)]
struct WavExportPlan {
    container: WavContainer,
    encoding: WavEncoding,
    header: Vec<u8>,
    frame_bytes: u64,
    data_bytes: u64,
    padding_bytes: u64,
    frames: u64,
}

impl WavExportPlan {
    fn new(
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        frames: u64,
        mode: WavExportMode,
    ) -> Result<Self> {
        if sample_rate == 0 {
            bail!("sample rate must be greater than zero");
        }
        if channels == 0 {
            bail!("channel count must be greater than zero");
        }
        let encoding = WavEncoding::for_bit_depth(bit_depth)?;
        let sample_bytes = bytes_per_sample(bit_depth)?;
        let block_align = channels
            .checked_mul(sample_bytes)
            .context("WAV block alignment overflow")?;
        let frame_bytes = u64::from(block_align);
        let data_bytes = frames
            .checked_mul(frame_bytes)
            .context("WAV data size overflow")?;
        let padding_bytes = data_bytes % 2;
        let standard_riff_size = encoding
            .header_len()
            .checked_sub(8)
            .and_then(|header| header.checked_add(data_bytes))
            .and_then(|size| size.checked_add(padding_bytes))
            .context("WAV RIFF size overflow")?;
        let container = match mode {
            WavExportMode::StandardRiff => {
                if standard_riff_size > u64::from(u32::MAX) {
                    bail!("audio range exceeds the standard RIFF/WAVE 4 GiB limit");
                }
                WavContainer::Riff
            }
            WavExportMode::AutoRf64 => {
                if standard_riff_size <= u64::from(u32::MAX) {
                    WavContainer::Riff
                } else {
                    WavContainer::Rf64
                }
            }
            #[cfg(test)]
            WavExportMode::ForceRf64 => WavContainer::Rf64,
        };
        let header_len = match container {
            WavContainer::Riff => encoding.header_len(),
            WavContainer::Rf64 => encoding
                .header_len()
                .checked_add(RF64_HEADER_GROWTH)
                .context("RF64 header size overflow")?,
        };
        let riff_size = header_len
            .checked_sub(8)
            .and_then(|header| header.checked_add(data_bytes))
            .and_then(|size| size.checked_add(padding_bytes))
            .context("WAV RIFF size overflow")?;
        let byte_rate = sample_rate
            .checked_mul(u32::from(block_align))
            .context("WAV byte rate overflow")?;
        let mut header = Vec::with_capacity(usize::try_from(header_len)?);
        match container {
            WavContainer::Riff => {
                header.extend_from_slice(b"RIFF");
                header.extend_from_slice(&u32::try_from(riff_size)?.to_le_bytes());
                header.extend_from_slice(b"WAVE");
            }
            WavContainer::Rf64 => {
                header.extend_from_slice(b"RF64");
                header.extend_from_slice(&u32::MAX.to_le_bytes());
                header.extend_from_slice(b"WAVE");
                header.extend_from_slice(b"ds64");
                header.extend_from_slice(&RF64_DS64_CHUNK_DATA_LEN.to_le_bytes());
                header.extend_from_slice(&riff_size.to_le_bytes());
                header.extend_from_slice(&data_bytes.to_le_bytes());
                header.extend_from_slice(&frames.to_le_bytes());
                header.extend_from_slice(&0u32.to_le_bytes());
            }
        }
        header.extend_from_slice(b"fmt ");
        header.extend_from_slice(&16u32.to_le_bytes());
        header.extend_from_slice(&encoding.format_code().to_le_bytes());
        header.extend_from_slice(&channels.to_le_bytes());
        header.extend_from_slice(&sample_rate.to_le_bytes());
        header.extend_from_slice(&byte_rate.to_le_bytes());
        header.extend_from_slice(&block_align.to_le_bytes());
        header.extend_from_slice(&bit_depth.to_le_bytes());
        if encoding == WavEncoding::Float {
            header.extend_from_slice(b"fact");
            header.extend_from_slice(&4u32.to_le_bytes());
            let fact_frames = match container {
                WavContainer::Riff => u32::try_from(frames)?,
                WavContainer::Rf64 => u32::MAX,
            };
            header.extend_from_slice(&fact_frames.to_le_bytes());
        }
        header.extend_from_slice(b"data");
        let data_size = match container {
            WavContainer::Riff => u32::try_from(data_bytes)?,
            WavContainer::Rf64 => u32::MAX,
        };
        header.extend_from_slice(&data_size.to_le_bytes());
        if header.len() as u64 != header_len {
            bail!("WAV header layout does not match its declared size");
        }
        Ok(Self {
            container,
            encoding,
            header,
            frame_bytes,
            data_bytes,
            padding_bytes,
            frames,
        })
    }

    fn file_bytes(&self) -> Result<u64> {
        (self.header.len() as u64)
            .checked_add(self.data_bytes)
            .and_then(|bytes| bytes.checked_add(self.padding_bytes))
            .context("WAV export file size overflow")
    }
}

pub(crate) fn standard_wav_file_size(frames: u64, channels: u16, bit_depth: u16) -> Result<u64> {
    WavExportPlan::new(1, channels, bit_depth, frames, WavExportMode::StandardRiff)?.file_bytes()
}

pub(crate) fn automatic_wav_file_size(frames: u64, channels: u16, bit_depth: u16) -> Result<u64> {
    WavExportPlan::new(1, channels, bit_depth, frames, WavExportMode::AutoRf64)?.file_bytes()
}

pub(crate) fn automatic_wav_container_name(
    frames: u64,
    channels: u16,
    bit_depth: u16,
) -> Result<&'static str> {
    let plan = WavExportPlan::new(1, channels, bit_depth, frames, WavExportMode::AutoRf64)?;
    Ok(match plan.container {
        WavContainer::Riff => "riff",
        WavContainer::Rf64 => "rf64",
    })
}

/// Streaming writer for immutable export temporaries. Unlike the crash-
/// recoverable recording writer, it knows the exact final frame count before
/// copying begins, so an RF64 header can be written once with final `ds64`
/// values and the completed temporary can then be atomically published.
pub(crate) struct WavExportWriter {
    file: File,
    plan: WavExportPlan,
    written_data_bytes: u64,
}

impl WavExportWriter {
    pub(crate) fn create_new(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        frames: u64,
        mode: WavExportMode,
    ) -> Result<Self> {
        let plan = WavExportPlan::new(sample_rate, channels, bit_depth, frames, mode)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create audio export directory {}", parent.display()))?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .with_context(|| format!("create WAV export {}", path.display()))?;
        file.write_all(&plan.header)?;
        Ok(Self {
            file,
            plan,
            written_data_bytes: 0,
        })
    }

    pub(crate) fn write_encoded_samples(&mut self, bytes: &[u8]) -> Result<()> {
        if !(bytes.len() as u64).is_multiple_of(self.plan.frame_bytes) {
            bail!("encoded export audio does not contain complete channel frames");
        }
        if self.plan.encoding == WavEncoding::Float {
            for sample in bytes.chunks_exact(std::mem::size_of::<f32>()) {
                let value = f32::from_le_bytes(sample.try_into().expect("f32 chunk size"));
                if !value.is_finite() {
                    bail!("WAV export contains a non-finite 32-bit Float sample");
                }
            }
        }
        let next_data_bytes = self
            .written_data_bytes
            .checked_add(bytes.len() as u64)
            .context("WAV export byte counter overflow")?;
        if next_data_bytes > self.plan.data_bytes {
            bail!("WAV export received more audio than its declared frame count");
        }
        self.file.write_all(bytes)?;
        self.written_data_bytes = next_data_bytes;
        Ok(())
    }

    pub(crate) fn finalize(mut self) -> Result<u64> {
        if self.written_data_bytes != self.plan.data_bytes {
            bail!(
                "WAV export ended before its declared frame count: wrote {} of {} bytes",
                self.written_data_bytes,
                self.plan.data_bytes
            );
        }
        if self.plan.padding_bytes != 0 {
            self.file.write_all(&[0])?;
        }
        self.file.flush()?;
        self.file.sync_all()?;
        let expected_file_len = (self.plan.header.len() as u64)
            .checked_add(self.plan.data_bytes)
            .and_then(|size| size.checked_add(self.plan.padding_bytes))
            .context("WAV export file size overflow")?;
        if self.file.metadata()?.len() != expected_file_len {
            bail!("WAV export physical size does not match its header");
        }
        Ok(self.plan.frames)
    }
}

/// Validates that a range can remain an ordinary RIFF/WAVE. Recording segments,
/// sentence files, and previews use this compatibility limit; full-track
/// exports instead select RF64 automatically when needed.
pub(crate) fn validate_standard_wav_size(frames: u64, channels: u16, bit_depth: u16) -> Result<()> {
    WavExportPlan::new(1, channels, bit_depth, frames, WavExportMode::StandardRiff)?;
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
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            durable_create_directory_all(parent)
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

    /// Rebuilds the mutable RIFF header of the final active recording segment
    /// from independently persisted format evidence.
    ///
    /// This deliberately does not try to recognize an arbitrary file by its
    /// length. The segmented storage layer is the only caller and must first
    /// validate the immutable per-segment descriptor against the trusted
    /// session snapshot, segment index, and file name. Older segments and
    /// descriptor-less recordings must continue through `open_append`, whose
    /// normal header validation remains fail-closed.
    pub(crate) fn open_append_rebuilding_active_header(
        path: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        maximum_frames: u64,
    ) -> Result<Self> {
        if sample_rate == 0 {
            bail!("sample rate must be greater than zero");
        }
        if channels == 0 {
            bail!("channels must be greater than zero");
        }
        if maximum_frames == 0 {
            bail!("active WAV recovery frame limit must be greater than zero");
        }
        let encoding = WavEncoding::for_bit_depth(bit_depth)?;
        let metadata = std::fs::symlink_metadata(path)
            .with_context(|| format!("inspect torn active WAV {}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!("torn active WAV must be a regular file");
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .with_context(|| format!("open torn active WAV {}", path.display()))?;
        file.try_lock()
            .with_context(|| format!("lock torn active WAV {} for recovery", path.display()))?;

        let header_len = encoding.header_len();
        let file_len = file.metadata()?.len();
        if file_len < header_len {
            bail!("torn active WAV is shorter than its descriptor header length");
        }
        let sample_bytes = u64::from(bytes_per_sample(bit_depth)?);
        let frame_bytes = u64::from(channels)
            .checked_mul(sample_bytes)
            .context("active WAV recovery frame size overflow")?;
        let actual_data_bytes = file_len - header_len;
        let complete_data_bytes = actual_data_bytes - actual_data_bytes % frame_bytes;
        let complete_frames = complete_data_bytes / frame_bytes;
        if complete_frames > maximum_frames {
            bail!(
                "torn active WAV has {complete_frames} complete frames; descriptor limit is {maximum_frames}"
            );
        }
        let maximum_data_bytes = u64::from(u32::MAX)
            .checked_sub(header_len - 8)
            .context("WAV RIFF size underflow")?;
        if complete_data_bytes > maximum_data_bytes {
            bail!("torn active WAV exceeds the 4 GiB RIFF limit");
        }

        // Recorder-generated 32-bit Float samples are always finite. Validate
        // the complete payload before replacing a destroyed header so a
        // descriptor next to unrelated non-audio float data does not get
        // silently promoted into a recording segment. Values outside [-1, 1]
        // remain valid because Float delivery may intentionally preserve
        // interface headroom.
        if encoding == WavEncoding::Float {
            file.seek(SeekFrom::Start(header_len))?;
            let mut remaining = complete_data_bytes;
            let mut buffer = vec![0u8; 64 * 1024];
            while remaining > 0 {
                let count = usize::try_from(remaining.min(buffer.len() as u64))?;
                file.read_exact(&mut buffer[..count])?;
                for sample in buffer[..count].chunks_exact(4) {
                    let value = f32::from_le_bytes(sample.try_into().expect("four-byte float"));
                    if !value.is_finite() {
                        bail!("torn active Float WAV contains invalid recorder sample data");
                    }
                }
                remaining -= count as u64;
            }
        }

        let repaired_file_len = header_len
            .checked_add(complete_data_bytes)
            .context("active WAV recovery length overflow")?;
        if repaired_file_len != file_len {
            file.set_len(repaired_file_len)
                .context("truncate incomplete torn active WAV tail")?;
        }
        file.seek(SeekFrom::Start(repaired_file_len))?;
        let samples_written = complete_data_bytes / sample_bytes;
        let mut wav = Self {
            file,
            sample_rate,
            channels,
            bit_depth,
            encoding,
            samples_written,
        };
        wav.checkpoint()
            .context("rebuild torn active WAV header from durable descriptor")?;
        Ok(wav)
    }

    pub fn write_samples(&mut self, samples: &[f32]) -> Result<()> {
        if samples.iter().any(|sample| !sample.is_finite()) {
            bail!("WAV sample block contains a non-finite value");
        }
        let bytes_per_sample = usize::from(bytes_per_sample(self.bit_depth)?);
        let mut encoded = Vec::with_capacity(samples.len() * bytes_per_sample);
        for sample in samples {
            match (self.encoding, self.bit_depth) {
                (WavEncoding::Pcm, 16) => {
                    let sample = sample.clamp(-1.0, 1.0);
                    let value = (sample * 32_768.0)
                        .round()
                        .clamp(f32::from(i16::MIN), f32::from(i16::MAX))
                        as i16;
                    encoded.extend_from_slice(&value.to_le_bytes());
                }
                (WavEncoding::Pcm, 24) => {
                    let sample = sample.clamp(-1.0, 1.0);
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
        let sample_bytes = u64::from(bytes_per_sample(self.bit_depth)?);
        let expected_end = self
            .samples_written
            .checked_mul(sample_bytes)
            .and_then(|data_bytes| self.encoding.header_len().checked_add(data_bytes))
            .context("WAV checkpoint size overflow")?;
        let physical_end = self.file.metadata()?.len();
        if physical_end < expected_end {
            bail!(
                "WAV audio is shorter than the writer's committed sample count: expected at least {expected_end} bytes, found {physical_end}"
            );
        }
        if physical_end > expected_end {
            // A failed `write_all` may leave a complete-frame-aligned prefix of
            // the rejected callback at EOF. The in-memory sample counter is the
            // acceptance boundary, so discard every byte beyond it before a
            // checkpoint can make that ambiguous prefix recoverable.
            self.file
                .set_len(expected_end)
                .context("truncate unaccepted WAV tail before checkpoint")?;
        }
        self.file.seek(SeekFrom::Start(expected_end))?;
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
        let seek_result = self.file.seek(SeekFrom::Start(expected_end));
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

pub fn waveform_wav_mono(
    source: &Path,
    sample_rate: u32,
    bit_depth: u16,
    start_frame: u64,
    end_frame: u64,
) -> Result<Vec<[f32; 2]>> {
    let _ = sample_rate;
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
    let mut remaining = end_byte - start_byte;
    let mut bytes = vec![0u8; 48 * 1024];
    let mut fold = ReviewWaveformFold::new();
    while remaining > 0 {
        let count = usize::try_from(remaining.min(bytes.len() as u64))?;
        input.read_exact(&mut bytes[..count])?;
        fold.push_bytes(&bytes[..count], bit_depth)?;
        remaining -= count as u64;
    }
    Ok(fold.finish())
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
        let mut output = WavExportWriter::create_new(
            &temporary,
            sample_rate,
            1,
            bit_depth,
            end_frame - start_frame,
            WavExportMode::StandardRiff,
        )?;
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

    #[derive(Debug)]
    struct ParsedTestWav {
        rf64: bool,
        riff_size: u64,
        data_size: u64,
        sample_count: u64,
        format_code: u16,
        channels: u16,
        sample_rate: u32,
        bit_depth: u16,
        fact_frames: Option<u32>,
        payload: Vec<u8>,
    }

    /// Independent chunk walker used by export tests. It does not share header
    /// offsets with `WavExportPlan`, so it catches malformed ordering, sizes,
    /// RF64 sentinels, and missing word-alignment padding.
    fn parse_test_wav(path: &Path) -> ParsedTestWav {
        let bytes = std::fs::read(path).unwrap();
        assert!(bytes.len() >= 12);
        let rf64 = match &bytes[0..4] {
            b"RIFF" => false,
            b"RF64" => true,
            other => panic!("unexpected WAV container: {other:?}"),
        };
        assert_eq!(&bytes[8..12], b"WAVE");
        let mut position = 12usize;
        let mut ds64_data_size = None;
        let mut ds64_sample_count = None;
        let riff_size = if rf64 {
            assert_eq!(
                u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
                u32::MAX
            );
            assert_eq!(&bytes[position..position + 4], b"ds64");
            assert_eq!(
                u32::from_le_bytes(bytes[position + 4..position + 8].try_into().unwrap()),
                RF64_DS64_CHUNK_DATA_LEN
            );
            let size = u64::from_le_bytes(bytes[position + 8..position + 16].try_into().unwrap());
            ds64_data_size = Some(u64::from_le_bytes(
                bytes[position + 16..position + 24].try_into().unwrap(),
            ));
            ds64_sample_count = Some(u64::from_le_bytes(
                bytes[position + 24..position + 32].try_into().unwrap(),
            ));
            assert_eq!(
                u32::from_le_bytes(bytes[position + 32..position + 36].try_into().unwrap()),
                0
            );
            position += 8 + usize::try_from(RF64_DS64_CHUNK_DATA_LEN).unwrap();
            size
        } else {
            u64::from(u32::from_le_bytes(bytes[4..8].try_into().unwrap()))
        };
        let mut format = None;
        let mut fact_frames = None;
        loop {
            assert!(position + 8 <= bytes.len());
            let chunk_id = &bytes[position..position + 4];
            let chunk_size_32 =
                u32::from_le_bytes(bytes[position + 4..position + 8].try_into().unwrap());
            let payload_start = position + 8;
            if chunk_id == b"data" {
                let data_size = if chunk_size_32 == u32::MAX {
                    assert!(rf64);
                    ds64_data_size.unwrap()
                } else {
                    u64::from(chunk_size_32)
                };
                let payload_end = payload_start + usize::try_from(data_size).unwrap();
                let physical_end = payload_end + usize::try_from(data_size % 2).unwrap();
                assert_eq!(physical_end, bytes.len());
                assert_eq!(riff_size + 8, bytes.len() as u64);
                if data_size % 2 != 0 {
                    assert_eq!(bytes[payload_end], 0);
                }
                let (format_code, channels, sample_rate, block_align, bit_depth) = format.unwrap();
                let sample_count = ds64_sample_count
                    .or_else(|| fact_frames.map(u64::from))
                    .unwrap_or(data_size / u64::from(block_align));
                return ParsedTestWav {
                    rf64,
                    riff_size,
                    data_size,
                    sample_count,
                    format_code,
                    channels,
                    sample_rate,
                    bit_depth,
                    fact_frames,
                    payload: bytes[payload_start..payload_end].to_vec(),
                };
            }
            let chunk_size = usize::try_from(chunk_size_32).unwrap();
            let payload_end = payload_start + chunk_size;
            assert!(payload_end <= bytes.len());
            if chunk_id == b"fmt " {
                assert_eq!(chunk_size, 16);
                format = Some((
                    u16::from_le_bytes(bytes[payload_start..payload_start + 2].try_into().unwrap()),
                    u16::from_le_bytes(
                        bytes[payload_start + 2..payload_start + 4]
                            .try_into()
                            .unwrap(),
                    ),
                    u32::from_le_bytes(
                        bytes[payload_start + 4..payload_start + 8]
                            .try_into()
                            .unwrap(),
                    ),
                    u16::from_le_bytes(
                        bytes[payload_start + 12..payload_start + 14]
                            .try_into()
                            .unwrap(),
                    ),
                    u16::from_le_bytes(
                        bytes[payload_start + 14..payload_start + 16]
                            .try_into()
                            .unwrap(),
                    ),
                ));
            } else if chunk_id == b"fact" {
                assert_eq!(chunk_size, 4);
                fact_frames = Some(u32::from_le_bytes(
                    bytes[payload_start..payload_end].try_into().unwrap(),
                ));
            } else {
                panic!("unexpected WAV chunk: {chunk_id:?}");
            }
            position = payload_end + chunk_size % 2;
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
            slice_wav_mono(&source, &slice, 48_000, bit_depth, 1, 4).unwrap();

            let source_bytes = std::fs::read(&source).unwrap();
            let slice_bytes = std::fs::read(&slice).unwrap();
            let slice_data_bytes = 3 * bytes_per_sample;
            assert_eq!(
                source_bytes.len(),
                header_len + samples.len() * bytes_per_sample
            );
            assert_eq!(
                slice_bytes.len(),
                header_len + slice_data_bytes + slice_data_bytes % 2
            );
            assert_eq!(
                u16::from_le_bytes([source_bytes[20], source_bytes[21]]),
                format_code
            );
            assert_eq!(
                u16::from_le_bytes([source_bytes[34], source_bytes[35]]),
                bit_depth
            );
            assert_eq!(
                &slice_bytes[header_len..header_len + slice_data_bytes],
                &source_bytes[header_len + bytes_per_sample..header_len + 4 * bytes_per_sample]
            );
            if slice_data_bytes % 2 != 0 {
                assert_eq!(slice_bytes.last(), Some(&0));
            }
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn recoverable_writer_rejects_non_finite_samples_before_writing_any_payload() {
        for bit_depth in [16, 24, 32] {
            for (name, invalid) in [
                ("nan", f32::NAN),
                ("positive-infinity", f32::INFINITY),
                ("negative-infinity", f32::NEG_INFINITY),
            ] {
                let root = test_root(&format!("non-finite-{bit_depth}-{name}"));
                let path = root.join("invalid.wav");
                let mut writer = RecoverableWav::create(&path, 48_000, 1, bit_depth).unwrap();
                let initial_len = std::fs::metadata(&path).unwrap().len();

                let error = writer.write_samples(&[0.25, invalid, -0.25]).unwrap_err();
                assert!(format!("{error:#}").contains("non-finite"));
                assert_eq!(writer.frames_written(), 0);
                assert_eq!(std::fs::metadata(&path).unwrap().len(), initial_len);

                writer.write_samples(&[0.5]).unwrap();
                assert_eq!(writer.finalize().unwrap(), 1);
                let _ = std::fs::remove_dir_all(root);
            }
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
    fn float_wav_preserves_finite_headroom_while_pcm_outputs_saturate() {
        let root = test_root("float-headroom");
        let input = [1.25f32, -1.5f32];

        let float_path = root.join("headroom-32.wav");
        let mut float_writer = RecoverableWav::create(&float_path, 48_000, 1, 32).unwrap();
        float_writer.write_samples(&input).unwrap();
        float_writer.finalize().unwrap();
        let float_bytes = std::fs::read(&float_path).unwrap();
        let decoded_float = float_bytes[FLOAT_HEADER_LEN as usize..]
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(decoded_float, input);

        let pcm16_path = root.join("saturated-16.wav");
        let mut pcm16_writer = RecoverableWav::create(&pcm16_path, 48_000, 1, 16).unwrap();
        pcm16_writer.write_samples(&input).unwrap();
        pcm16_writer.finalize().unwrap();
        let pcm16_bytes = std::fs::read(&pcm16_path).unwrap();
        let decoded_16 = pcm16_bytes[PCM_HEADER_LEN as usize..]
            .chunks_exact(2)
            .map(|bytes| i16::from_le_bytes(bytes.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(decoded_16, vec![i16::MAX, i16::MIN]);

        let pcm24_path = root.join("saturated-24.wav");
        let mut pcm24_writer = RecoverableWav::create(&pcm24_path, 48_000, 1, 24).unwrap();
        pcm24_writer.write_samples(&input).unwrap();
        pcm24_writer.finalize().unwrap();
        let pcm24_bytes = std::fs::read(&pcm24_path).unwrap();
        let decoded_24 = pcm24_bytes[PCM_HEADER_LEN as usize..]
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
        assert_eq!(decoded_24, vec![8_388_607, -8_388_608]);
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
    fn checkpoint_discards_an_unaccepted_tail_even_when_it_contains_complete_frames() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("checkpoint-unaccepted-tail-{bit_depth}"));
            let path = root.join("source.wav");
            let mut writer = RecoverableWav::create(&path, 48_000, 1, bit_depth).unwrap();
            writer.write_samples(&[0.1, 0.2]).unwrap();

            // Model a short/failed write that placed one whole encoded frame on
            // disk but returned before `samples_written` accepted that frame.
            writer
                .file
                .write_all(&vec![0x7f; usize::from(bit_depth / 8)])
                .unwrap();
            assert_eq!(writer.checkpoint().unwrap(), 2);
            drop(writer);

            assert_header_matches_physical_eof(&path, bit_depth, 2);
            let resumed = RecoverableWav::open_append(&path, 48_000, 1, bit_depth).unwrap();
            assert_eq!(resumed.frames_written(), 2);
            drop(resumed);
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
    fn export_file_size_includes_header_data_and_word_padding_at_every_bit_depth() {
        assert_eq!(standard_wav_file_size(1, 1, 16).unwrap(), 44 + 2);
        assert_eq!(standard_wav_file_size(1, 1, 24).unwrap(), 44 + 3 + 1);
        assert_eq!(standard_wav_file_size(1, 1, 32).unwrap(), 56 + 4);
        assert_eq!(standard_wav_file_size(2, 1, 24).unwrap(), 44 + 6);
    }

    #[test]
    fn auto_export_uses_riff_at_the_boundary_and_rf64_immediately_above_it() {
        for bit_depth in [16, 24, 32] {
            let encoding = WavEncoding::for_bit_depth(bit_depth).unwrap();
            let frame_bytes = u64::from(bytes_per_sample(bit_depth).unwrap());
            let maximum_data_bytes = u64::from(u32::MAX) - (encoding.header_len() - 8);
            let mut maximum_frames = maximum_data_bytes / frame_bytes;
            while validate_standard_wav_size(maximum_frames, 1, bit_depth).is_err() {
                maximum_frames -= 1;
            }

            validate_standard_wav_size(maximum_frames, 1, bit_depth).unwrap();
            assert!(validate_standard_wav_size(maximum_frames + 1, 1, bit_depth).is_err());
            assert_eq!(
                automatic_wav_container_name(maximum_frames, 1, bit_depth).unwrap(),
                "riff"
            );
            assert_eq!(
                automatic_wav_container_name(maximum_frames + 1, 1, bit_depth).unwrap(),
                "rf64"
            );

            let riff = WavExportPlan::new(
                48_000,
                1,
                bit_depth,
                maximum_frames,
                WavExportMode::AutoRf64,
            )
            .unwrap();
            assert_eq!(&riff.header[0..4], b"RIFF");
            assert_eq!(riff.header.len() as u64, encoding.header_len());

            let rf64_frames = maximum_frames + 1;
            let rf64 =
                WavExportPlan::new(48_000, 1, bit_depth, rf64_frames, WavExportMode::AutoRf64)
                    .unwrap();
            let data_bytes = rf64_frames * frame_bytes;
            let header_len = encoding.header_len() + RF64_HEADER_GROWTH;
            let riff_size = header_len - 8 + data_bytes + data_bytes % 2;
            assert_eq!(rf64.header.len() as u64, header_len);
            assert_eq!(
                automatic_wav_file_size(rf64_frames, 1, bit_depth).unwrap(),
                header_len + data_bytes + data_bytes % 2
            );
            assert_eq!(&rf64.header[0..4], b"RF64");
            assert_eq!(
                u32::from_le_bytes(rf64.header[4..8].try_into().unwrap()),
                u32::MAX
            );
            assert_eq!(&rf64.header[8..12], b"WAVE");
            assert_eq!(&rf64.header[12..16], b"ds64");
            assert_eq!(
                u32::from_le_bytes(rf64.header[16..20].try_into().unwrap()),
                RF64_DS64_CHUNK_DATA_LEN
            );
            assert_eq!(
                u64::from_le_bytes(rf64.header[20..28].try_into().unwrap()),
                riff_size
            );
            assert_eq!(
                u64::from_le_bytes(rf64.header[28..36].try_into().unwrap()),
                data_bytes
            );
            assert_eq!(
                u64::from_le_bytes(rf64.header[36..44].try_into().unwrap()),
                rf64_frames
            );
            assert_eq!(
                u32::from_le_bytes(rf64.header[44..48].try_into().unwrap()),
                0
            );
            assert_eq!(&rf64.header[48..52], b"fmt ");
            let data_marker = if encoding == WavEncoding::Float {
                assert_eq!(&rf64.header[72..76], b"fact");
                assert_eq!(
                    u32::from_le_bytes(rf64.header[80..84].try_into().unwrap()),
                    u32::MAX
                );
                84
            } else {
                72
            };
            assert_eq!(&rf64.header[data_marker..data_marker + 4], b"data");
            assert_eq!(
                u32::from_le_bytes(
                    rf64.header[data_marker + 4..data_marker + 8]
                        .try_into()
                        .unwrap()
                ),
                u32::MAX
            );
        }
    }

    #[test]
    fn export_writer_keeps_small_files_as_reader_compatible_riff() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("small-export-{bit_depth}"));
            let path = root.join("small.wav");
            let frames = 3u64;
            let data = vec![0u8; usize::try_from(frames * u64::from(bit_depth / 8)).unwrap()];
            let mut writer = WavExportWriter::create_new(
                &path,
                48_000,
                1,
                bit_depth,
                frames,
                WavExportMode::AutoRf64,
            )
            .unwrap();
            writer.write_encoded_samples(&data).unwrap();
            assert_eq!(writer.finalize().unwrap(), frames);
            let parsed = parse_test_wav(&path);
            assert!(!parsed.rf64);
            assert_eq!(
                parsed.riff_size + 8,
                std::fs::metadata(&path).unwrap().len()
            );
            assert_eq!(parsed.data_size, data.len() as u64);
            assert_eq!(parsed.sample_count, frames);
            assert_eq!(parsed.format_code, if bit_depth == 32 { 3 } else { 1 });
            assert_eq!(parsed.channels, 1);
            assert_eq!(parsed.sample_rate, 48_000);
            assert_eq!(parsed.bit_depth, bit_depth);
            assert_eq!(
                parsed.fact_frames,
                (bit_depth == 32).then_some(u32::try_from(frames).unwrap())
            );
            assert_eq!(parsed.payload, data);

            let reader = RecoverableWav::open_append(&path, 48_000, 1, bit_depth).unwrap();
            assert_eq!(reader.frames_written(), frames);
            drop(reader);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn float_export_writer_rejects_non_finite_encoded_payloads() {
        for (name, invalid) in [
            ("nan", f32::NAN),
            ("positive-infinity", f32::INFINITY),
            ("negative-infinity", f32::NEG_INFINITY),
        ] {
            let root = test_root(&format!("non-finite-export-{name}"));
            let path = root.join("invalid.wav");
            let mut writer =
                WavExportWriter::create_new(&path, 48_000, 1, 32, 1, WavExportMode::StandardRiff)
                    .unwrap();
            let initial_len = std::fs::metadata(&path).unwrap().len();

            let error = writer
                .write_encoded_samples(&invalid.to_le_bytes())
                .unwrap_err();
            assert!(format!("{error:#}").contains("non-finite"));
            assert_eq!(std::fs::metadata(&path).unwrap().len(), initial_len);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn export_writer_streams_rf64_payload_after_the_ds64_header() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("forced-rf64-export-{bit_depth}"));
            let path = root.join("large-layout.wav");
            let frames = 3u64;
            let data = (0..usize::try_from(frames * u64::from(bit_depth / 8)).unwrap())
                .map(|value| value as u8)
                .collect::<Vec<_>>();
            let mut writer = WavExportWriter::create_new(
                &path,
                48_000,
                1,
                bit_depth,
                frames,
                WavExportMode::ForceRf64,
            )
            .unwrap();
            writer.write_encoded_samples(&data).unwrap();
            assert_eq!(writer.finalize().unwrap(), frames);

            let parsed = parse_test_wav(&path);
            assert!(parsed.rf64);
            assert_eq!(
                parsed.riff_size + 8,
                std::fs::metadata(&path).unwrap().len()
            );
            assert_eq!(parsed.data_size, data.len() as u64);
            assert_eq!(parsed.sample_count, frames);
            assert_eq!(parsed.format_code, if bit_depth == 32 { 3 } else { 1 });
            assert_eq!(parsed.channels, 1);
            assert_eq!(parsed.sample_rate, 48_000);
            assert_eq!(parsed.bit_depth, bit_depth);
            assert_eq!(parsed.fact_frames, (bit_depth == 32).then_some(u32::MAX));
            assert_eq!(parsed.payload, data);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn review_waveform_fold_keeps_extrema_and_a_partial_tail() {
        let mut encoded = Vec::new();
        for sample in [-0.5f32, 0.25, 0.75] {
            encoded.extend_from_slice(&sample.to_le_bytes());
        }
        let mut fold = ReviewWaveformFold::new();
        fold.push_bytes(&encoded, 32).unwrap();
        let bins = fold.finish();
        assert_eq!(bins.len(), 1);
        assert!((bins[0][0] + 0.5).abs() < 0.001);
        assert!((bins[0][1] - 0.75).abs() < 0.001);
    }
}
