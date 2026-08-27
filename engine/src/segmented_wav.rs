use crate::durable_fs::{
    durable_create_directory_all, durable_rename, durable_replace, sync_directory,
};
use crate::wav::{RecoverableWav, ReviewWaveformFold, WavExportMode, WavExportWriter};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const SEGMENT_PREFIX: &str = "master-";
const SEGMENT_SUFFIX: &str = ".wav";
const SEGMENT_TEMP_PREFIX: &str = ".master-";
const SEGMENT_TEMP_SUFFIX: &str = ".wav.creating";
const SEGMENT_DIGITS: usize = 6;
const MAX_SEGMENT_INDEX: u32 = 999_999;
const SEGMENT_DESCRIPTOR_KIND: &str = "databaker.segmented-wav-header";
const SEGMENT_DESCRIPTOR_SUFFIX: &str = ".descriptor.json";
const SEGMENT_DESCRIPTOR_TEMP_SUFFIX: &str = ".descriptor.json.creating";
const SEGMENT_DESCRIPTOR_MAX_BYTES: u64 = 4 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SegmentDescriptor {
    schema_version: u32,
    kind: String,
    segment_index: u32,
    segment_file: String,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    encoding: String,
    header_len: u64,
    max_frames_per_segment: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentSpan {
    pub index: u32,
    pub path: PathBuf,
    pub global_start_frame: u64,
    pub frames: u64,
    pub active: bool,
}

impl SegmentSpan {
    pub fn global_end_frame(&self) -> u64 {
        self.global_start_frame + self.frames
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentRange {
    pub index: u32,
    pub path: PathBuf,
    pub global_start_frame: u64,
    pub global_end_frame: u64,
    pub local_start_frame: u64,
    pub local_end_frame: u64,
}

#[derive(Debug, Clone, Copy)]
struct WavLayout {
    header_len: u64,
    sample_bytes: u64,
    format_code: u16,
    data_marker: usize,
    data_size_offset: usize,
    fact_frame_offset: Option<usize>,
}

impl WavLayout {
    fn for_bit_depth(bit_depth: u16) -> Result<Self> {
        match bit_depth {
            16 => Ok(Self {
                header_len: 44,
                sample_bytes: 2,
                format_code: 1,
                data_marker: 36,
                data_size_offset: 40,
                fact_frame_offset: None,
            }),
            24 => Ok(Self {
                header_len: 44,
                sample_bytes: 3,
                format_code: 1,
                data_marker: 36,
                data_size_offset: 40,
                fact_frame_offset: None,
            }),
            32 => Ok(Self {
                header_len: 56,
                sample_bytes: 4,
                format_code: 3,
                data_marker: 48,
                data_size_offset: 52,
                fact_frame_offset: Some(44),
            }),
            _ => bail!("bit depth must be one of 16-bit PCM, 24-bit PCM, or 32-bit Float"),
        }
    }

    fn frame_bytes(self, channels: u16) -> Result<u64> {
        self.sample_bytes
            .checked_mul(u64::from(channels))
            .context("WAV frame size overflow")
    }
}

enum PreparedExportPart {
    ClosedSegment(SegmentRange),
    EncodedFrames(Vec<u8>),
}

/// An immutable WAV render plan. Active audio has already been copied through
/// the recording handle, while closed segments remain safe read-only ranges.
/// The plan owns no master writer or lock and can therefore be rendered on a
/// background thread without delaying live capture.
pub(crate) struct PreparedWavExport {
    destination: PathBuf,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    frames: u64,
    parts: Vec<PreparedExportPart>,
    mode: WavExportMode,
}

impl PreparedWavExport {
    pub(crate) fn from_encoded_frames(
        destination: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        frames: u64,
        bytes: Vec<u8>,
    ) -> Result<Self> {
        if sample_rate == 0 || channels == 0 {
            bail!("invalid prepared WAV format");
        }
        let layout = WavLayout::for_bit_depth(bit_depth)?;
        let expected_bytes = frames
            .checked_mul(layout.frame_bytes(channels)?)
            .context("prepared WAV byte length overflow")?;
        if bytes.len() as u64 != expected_bytes {
            bail!("prepared WAV bytes do not match its frame count");
        }
        Ok(Self {
            destination: destination.to_path_buf(),
            sample_rate,
            channels,
            bit_depth,
            frames,
            parts: vec![PreparedExportPart::EncodedFrames(bytes)],
            mode: WavExportMode::StandardRiff,
        })
    }

    #[cfg(test)]
    pub(crate) fn destination(&self) -> &Path {
        &self.destination
    }

    pub(crate) fn waveform_bins(self) -> Result<Vec<[f32; 2]>> {
        let layout = WavLayout::for_bit_depth(self.bit_depth)?;
        let frame_bytes = layout.frame_bytes(self.channels)?;
        let mut fold = ReviewWaveformFold::new();
        for part in self.parts {
            match part {
                PreparedExportPart::ClosedSegment(part) => {
                    fold_closed_part(
                        &part,
                        layout.header_len,
                        frame_bytes,
                        self.bit_depth,
                        &mut fold,
                    )?;
                }
                PreparedExportPart::EncodedFrames(bytes) => {
                    fold.push_bytes(&bytes, self.bit_depth)?;
                }
            }
        }
        Ok(fold.finish())
    }

    pub(crate) fn write(self) -> Result<u64> {
        let Self {
            destination,
            sample_rate,
            channels,
            bit_depth,
            frames,
            parts,
            mode,
        } = self;
        let layout = WavLayout::for_bit_depth(bit_depth)?;
        let frame_bytes = layout.frame_bytes(channels)?;
        let temporary = prepare_export_temp(&destination)?;
        let result = (|| -> Result<u64> {
            let mut output = WavExportWriter::create_new(
                &temporary,
                sample_rate,
                channels,
                bit_depth,
                frames,
                mode,
            )?;
            for part in parts {
                match part {
                    PreparedExportPart::ClosedSegment(part) => {
                        copy_closed_part(&part, layout.header_len, frame_bytes, &mut output)?;
                    }
                    PreparedExportPart::EncodedFrames(bytes) => {
                        output.write_encoded_samples(&bytes)?;
                    }
                }
            }
            let written = output.finalize()?;
            if written != frames {
                bail!("prepared WAV frame count changed while rendering");
            }
            publish_export(&temporary, &destination)?;
            Ok(written)
        })();
        if result.is_err() {
            remove_export_temp_best_effort(&temporary);
        }
        result
    }
}

#[derive(Debug, Clone, Copy)]
struct InspectedSegment {
    complete_frames: u64,
}

/// A continuous global frame timeline backed by numbered RIFF/WAVE segments.
///
/// Completed segments are opened read-only during recovery and are never passed
/// to `RecoverableWav` again. Only the highest-numbered segment can be repaired
/// or appended, which keeps previously sealed audio immutable.
pub struct SegmentedWav {
    directory: PathBuf,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    max_frames_per_segment: u64,
    closed_segments: Vec<SegmentSpan>,
    closed_frames: u64,
    active_index: u32,
    active_path: PathBuf,
    active: Option<RecoverableWav>,
    #[allow(dead_code)]
    recovery_warnings: Vec<String>,
}

impl SegmentedWav {
    pub fn create(
        directory: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        max_frames_per_segment: u64,
    ) -> Result<Self> {
        validate_settings(sample_rate, channels, bit_depth, max_frames_per_segment)?;
        ensure_directory(directory, true)?;
        cleanup_segment_temps(directory)?;
        if !scan_segments(directory)?.is_empty() {
            bail!("segmented master already contains audio");
        }
        Self::create_empty_validated(
            directory,
            sample_rate,
            channels,
            bit_depth,
            max_frames_per_segment,
        )
    }

    pub fn resume(
        directory: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        max_frames_per_segment: u64,
    ) -> Result<Self> {
        validate_settings(sample_rate, channels, bit_depth, max_frames_per_segment)?;
        ensure_directory(directory, false)?;
        cleanup_segment_temps(directory)?;
        let segments = scan_segments(directory)?;
        if segments.is_empty() {
            bail!("segmented master has no audio segments");
        }
        Self::resume_validated(
            directory,
            sample_rate,
            channels,
            bit_depth,
            max_frames_per_segment,
            segments,
        )
    }

    /// Resumes an existing segmented master, or creates its first segment only
    /// for a caller that has independently established an empty bootstrap.
    /// Normal recovery must use `resume` so missing recorded segments cannot be
    /// mistaken for a new recording.
    pub fn resume_or_create_empty(
        directory: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        max_frames_per_segment: u64,
    ) -> Result<Self> {
        validate_settings(sample_rate, channels, bit_depth, max_frames_per_segment)?;
        ensure_directory(directory, true)?;
        cleanup_segment_temps(directory)?;
        let segments = scan_segments(directory)?;
        if segments.is_empty() {
            return Self::create_empty_validated(
                directory,
                sample_rate,
                channels,
                bit_depth,
                max_frames_per_segment,
            );
        }
        Self::resume_validated(
            directory,
            sample_rate,
            channels,
            bit_depth,
            max_frames_per_segment,
            segments,
        )
    }

    fn create_empty_validated(
        directory: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        max_frames_per_segment: u64,
    ) -> Result<Self> {
        let active_index = 1;
        let active_path = segment_path(directory, active_index)?;
        let active = create_segment(
            &active_path,
            active_index,
            sample_rate,
            channels,
            bit_depth,
            max_frames_per_segment,
        )?;
        Ok(Self {
            directory: directory.to_path_buf(),
            sample_rate,
            channels,
            bit_depth,
            max_frames_per_segment,
            closed_segments: Vec::new(),
            closed_frames: 0,
            active_index,
            active_path,
            active: Some(active),
            recovery_warnings: Vec::new(),
        })
    }

    fn resume_validated(
        directory: &Path,
        sample_rate: u32,
        channels: u16,
        bit_depth: u16,
        max_frames_per_segment: u64,
        segments: Vec<(u32, PathBuf)>,
    ) -> Result<Self> {
        let mut closed_segments = Vec::with_capacity(segments.len().saturating_sub(1));
        let mut closed_frames = 0u64;
        for (index, path) in segments.iter().take(segments.len() - 1) {
            // Closed audio is never reconstructed. Its exact WAV header and
            // fixed segment length are the authoritative checks, so a damaged
            // redundant descriptor must not make healthy historical audio
            // unavailable.
            let inspected =
                inspect_segment(path, sample_rate, channels, bit_depth, HeaderPolicy::Exact)?;
            if inspected.complete_frames != max_frames_per_segment {
                bail!(
                    "closed segment {} has {} frames; expected {}",
                    path.display(),
                    inspected.complete_frames,
                    max_frames_per_segment
                );
            }
            closed_segments.push(SegmentSpan {
                index: *index,
                path: path.clone(),
                global_start_frame: closed_frames,
                frames: inspected.complete_frames,
                active: false,
            });
            closed_frames = closed_frames
                .checked_add(inspected.complete_frames)
                .context("global WAV frame counter overflow")?;
        }

        let (active_index, active_path) = segments.last().cloned().unwrap();
        let mut recovery_warnings = Vec::new();
        let active = match inspect_segment(
            &active_path,
            sample_rate,
            channels,
            bit_depth,
            HeaderPolicy::RecoverableTail,
        ) {
            Ok(active_candidate) => {
                if active_candidate.complete_frames > max_frames_per_segment {
                    bail!(
                        "active segment {} exceeds its configured frame limit",
                        active_path.display()
                    );
                }
                match validate_segment_descriptor(
                    &active_path,
                    active_index,
                    sample_rate,
                    channels,
                    bit_depth,
                    max_frames_per_segment,
                ) {
                    Ok(true) => {}
                    Ok(false) => {
                        create_segment_descriptor(
                            &active_path,
                            active_index,
                            sample_rate,
                            channels,
                            bit_depth,
                            max_frames_per_segment,
                        )?;
                        let warning = format!(
                            "活动母轨分段 {} 是早期无描述符格式，已根据可验证的 WAV 头与会话参数补建恢复描述符。",
                            active_path.display()
                        );
                        eprintln!("{warning}");
                        recovery_warnings.push(warning);
                    }
                    Err(descriptor_error) => {
                        replace_segment_descriptor(
                            &active_path,
                            active_index,
                            sample_rate,
                            channels,
                            bit_depth,
                            max_frames_per_segment,
                        )?;
                        let warning = format!(
                            "活动母轨分段 {} 的冗余恢复描述符无效，已根据完整 WAV 头与可信会话参数原子替换；原因：{descriptor_error:#}",
                            active_path.display()
                        );
                        eprintln!("{warning}");
                        recovery_warnings.push(warning);
                    }
                }
                let active =
                    RecoverableWav::open_append(&active_path, sample_rate, channels, bit_depth)?;
                if active.frames_written() != active_candidate.complete_frames {
                    bail!("active segment changed while it was being recovered");
                }
                active
            }
            Err(header_error) => {
                let descriptor_present = validate_segment_descriptor(
                    &active_path,
                    active_index,
                    sample_rate,
                    channels,
                    bit_depth,
                    max_frames_per_segment,
                )?;
                if !descriptor_present {
                    return Err(header_error.context(
                        "active segment header is invalid and no trusted immutable descriptor is available; refusing header reconstruction",
                    ));
                }
                let active = RecoverableWav::open_append_rebuilding_active_header(
                    &active_path,
                    sample_rate,
                    channels,
                    bit_depth,
                    max_frames_per_segment,
                )
                .with_context(|| {
                    format!(
                        "rebuild active segment {} from its trusted descriptor after header validation failed: {header_error:#}",
                        active_path.display()
                    )
                })?;
                let warning = format!(
                    "活动母轨分段 {} 的 WAV 头已损坏，已根据持久化分段描述符和物理 EOF 重建；原因：{header_error:#}",
                    active_path.display()
                );
                eprintln!("{warning}");
                recovery_warnings.push(warning);
                active
            }
        };

        Ok(Self {
            directory: directory.to_path_buf(),
            sample_rate,
            channels,
            bit_depth,
            max_frames_per_segment,
            closed_segments,
            closed_frames,
            active_index,
            active_path,
            active: Some(active),
            recovery_warnings,
        })
    }

    pub fn write_samples(&mut self, samples: &[f32]) -> Result<()> {
        let channels = usize::from(self.channels);
        if !samples.len().is_multiple_of(channels) {
            bail!("sample block does not contain complete channel frames");
        }
        if samples.iter().any(|sample| !sample.is_finite()) {
            bail!("segmented WAV sample block contains a non-finite value");
        }
        let mut sample_offset = 0usize;
        while sample_offset < samples.len() {
            let active_frames = self.active_ref()?.frames_written();
            if active_frames == self.max_frames_per_segment {
                self.roll_segment()?;
                continue;
            }
            let capacity_frames = self.max_frames_per_segment - active_frames;
            let remaining_frames = (samples.len() - sample_offset) / channels;
            let write_frames = remaining_frames.min(usize::try_from(capacity_frames)?);
            let write_samples = write_frames
                .checked_mul(channels)
                .context("segmented sample block overflow")?;
            let end = sample_offset + write_samples;
            self.active_mut()?
                .write_samples(&samples[sample_offset..end])?;
            sample_offset = end;
            if sample_offset < samples.len()
                && self.active_ref()?.frames_written() == self.max_frames_per_segment
            {
                self.roll_segment()?;
            }
        }
        Ok(())
    }

    /// Makes all frames returned by this method durable across every segment.
    pub fn checkpoint(&mut self) -> Result<u64> {
        let active_durable = self.active_mut()?.checkpoint()?;
        self.closed_frames
            .checked_add(active_durable)
            .context("global WAV frame counter overflow")
    }

    pub fn global_frames(&self) -> u64 {
        self.closed_frames
            + self
                .active
                .as_ref()
                .map_or(0, RecoverableWav::frames_written)
    }

    #[allow(dead_code)]
    pub fn recovery_warnings(&self) -> &[String] {
        &self.recovery_warnings
    }

    pub fn segments(&self) -> Vec<SegmentSpan> {
        let mut spans = self.closed_segments.clone();
        if let Some(active) = &self.active {
            spans.push(SegmentSpan {
                index: self.active_index,
                path: self.active_path.clone(),
                global_start_frame: self.closed_frames,
                frames: active.frames_written(),
                active: true,
            });
        }
        spans
    }

    /// Maps a continuous global frame range to immutable per-segment ranges.
    pub fn range_parts(&self, start_frame: u64, end_frame: u64) -> Result<Vec<SegmentRange>> {
        if end_frame <= start_frame {
            bail!("invalid segmented WAV range");
        }
        if end_frame > self.global_frames() {
            bail!("segmented WAV range exceeds captured audio");
        }
        let mut parts = Vec::new();
        for segment in self.segments() {
            let segment_end = segment.global_end_frame();
            let overlap_start = start_frame.max(segment.global_start_frame);
            let overlap_end = end_frame.min(segment_end);
            if overlap_start < overlap_end {
                parts.push(SegmentRange {
                    index: segment.index,
                    path: segment.path,
                    global_start_frame: overlap_start,
                    global_end_frame: overlap_end,
                    local_start_frame: overlap_start - segment.global_start_frame,
                    local_end_frame: overlap_end - segment.global_start_frame,
                });
            }
        }
        let mapped_frames = parts.iter().try_fold(0u64, |total, part| {
            total
                .checked_add(part.local_end_frame - part.local_start_frame)
                .context("segmented WAV range overflow")
        })?;
        if mapped_frames != end_frame - start_frame {
            bail!("segmented WAV timeline is not continuous");
        }
        Ok(parts)
    }

    /// Writes a standard single RIFF/WAVE for a continuous global frame range.
    /// Sentence and preview ranges deliberately retain the 4 GiB RIFF limit.
    pub fn export_range(
        &mut self,
        destination: &Path,
        start_frame: u64,
        end_frame: u64,
    ) -> Result<u64> {
        self.prepare_export_range(destination, start_frame, end_frame)?
            .write()
    }

    pub(crate) fn prepare_export_range(
        &mut self,
        destination: &Path,
        start_frame: u64,
        end_frame: u64,
    ) -> Result<PreparedWavExport> {
        self.checkpoint()?;
        self.prepare_export_range_after_checkpoint(destination, start_frame, end_frame)
    }

    pub(crate) fn prepare_export_range_after_checkpoint(
        &mut self,
        destination: &Path,
        start_frame: u64,
        end_frame: u64,
    ) -> Result<PreparedWavExport> {
        let parts = self.range_parts(start_frame, end_frame)?;
        if self
            .segments()
            .iter()
            .any(|segment| segment.path == destination)
        {
            bail!("cannot export over a segmented master file");
        }
        let mut prepared_parts = Vec::with_capacity(parts.len());
        for part in parts {
            if part.index == self.active_index {
                let bytes = self
                    .active_mut()?
                    .read_encoded_frames(part.local_start_frame, part.local_end_frame)?;
                prepared_parts.push(PreparedExportPart::EncodedFrames(bytes));
            } else {
                prepared_parts.push(PreparedExportPart::ClosedSegment(part));
            }
        }
        Ok(PreparedWavExport {
            destination: destination.to_path_buf(),
            sample_rate: self.sample_rate,
            channels: self.channels,
            bit_depth: self.bit_depth,
            frames: end_frame - start_frame,
            parts: prepared_parts,
            mode: WavExportMode::StandardRiff,
        })
    }

    pub fn export_whole(&mut self, destination: &Path) -> Result<u64> {
        let end_frame = self.global_frames();
        if end_frame == 0 {
            if self
                .segments()
                .iter()
                .any(|segment| segment.path == destination)
            {
                bail!("cannot export over a segmented master file");
            }
            return PreparedWavExport {
                destination: destination.to_path_buf(),
                sample_rate: self.sample_rate,
                channels: self.channels,
                bit_depth: self.bit_depth,
                frames: 0,
                parts: Vec::new(),
                mode: WavExportMode::AutoRf64,
            }
            .write();
        }
        let mut prepared = self.prepare_export_range(destination, 0, end_frame)?;
        prepared.mode = WavExportMode::AutoRf64;
        prepared.write()
    }

    pub fn finalize(mut self) -> Result<u64> {
        let active = self.active.take().context("segmented WAV is unavailable")?;
        let active_durable = active.finalize()?;
        self.closed_frames
            .checked_add(active_durable)
            .context("global WAV frame counter overflow")
    }

    fn roll_segment(&mut self) -> Result<()> {
        let active = self.active.take().context("segmented WAV is unavailable")?;
        let frames = active.frames_written();
        if frames != self.max_frames_per_segment {
            self.active = Some(active);
            bail!("cannot close a segment before it reaches its configured frame limit");
        }
        let durable = active.finalize()?;
        if durable != frames {
            bail!("segment checkpoint did not commit every captured frame");
        }
        self.closed_segments.push(SegmentSpan {
            index: self.active_index,
            path: self.active_path.clone(),
            global_start_frame: self.closed_frames,
            frames,
            active: false,
        });
        self.closed_frames = self
            .closed_frames
            .checked_add(frames)
            .context("global WAV frame counter overflow")?;

        let next_index = self
            .active_index
            .checked_add(1)
            .filter(|index| *index <= MAX_SEGMENT_INDEX)
            .context("segmented WAV exhausted its file numbering range")?;
        let next_path = segment_path(&self.directory, next_index)?;
        let next = create_segment(
            &next_path,
            next_index,
            self.sample_rate,
            self.channels,
            self.bit_depth,
            self.max_frames_per_segment,
        )?;
        self.active_index = next_index;
        self.active_path = next_path;
        self.active = Some(next);
        Ok(())
    }

    fn active_ref(&self) -> Result<&RecoverableWav> {
        self.active.as_ref().context("segmented WAV is unavailable")
    }

    fn active_mut(&mut self) -> Result<&mut RecoverableWav> {
        self.active.as_mut().context("segmented WAV is unavailable")
    }
}

#[derive(Clone, Copy)]
enum HeaderPolicy {
    Exact,
    RecoverableTail,
}

fn validate_settings(
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    max_frames_per_segment: u64,
) -> Result<()> {
    if sample_rate == 0 {
        bail!("sample rate must be greater than zero");
    }
    if channels == 0 {
        bail!("channel count must be greater than zero");
    }
    if max_frames_per_segment == 0 {
        bail!("max frames per segment must be greater than zero");
    }
    let layout = WavLayout::for_bit_depth(bit_depth)?;
    let data_bytes = max_frames_per_segment
        .checked_mul(layout.frame_bytes(channels)?)
        .context("segment data size overflow")?;
    let riff_size = (layout.header_len - 8)
        .checked_add(data_bytes)
        .context("segment RIFF size overflow")?;
    if riff_size > u64::from(u32::MAX) {
        bail!("configured segment size exceeds the 4 GiB RIFF limit");
    }
    Ok(())
}

fn ensure_directory(directory: &Path, create: bool) -> Result<()> {
    if create {
        durable_create_directory_all(directory)
            .with_context(|| format!("create segment directory {}", directory.display()))?;
    }
    let metadata = std::fs::symlink_metadata(directory)
        .with_context(|| format!("inspect segment directory {}", directory.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!("segmented master path must be a regular directory");
    }
    Ok(())
}

fn segment_path(directory: &Path, index: u32) -> Result<PathBuf> {
    if index == 0 || index > MAX_SEGMENT_INDEX {
        bail!("invalid segmented WAV file index");
    }
    Ok(directory.join(format!(
        "{SEGMENT_PREFIX}{index:0SEGMENT_DIGITS$}{SEGMENT_SUFFIX}"
    )))
}

fn segment_temp_path(final_path: &Path) -> Result<PathBuf> {
    let file_name = final_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("WAV segment path has no UTF-8 file name")?;
    Ok(final_path.with_file_name(format!(".{file_name}.creating")))
}

fn segment_descriptor_path(segment_path: &Path) -> Result<PathBuf> {
    let file_name = segment_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("WAV segment path has no UTF-8 file name")?;
    Ok(segment_path.with_file_name(format!("{file_name}{SEGMENT_DESCRIPTOR_SUFFIX}")))
}

fn segment_descriptor_temp_path(segment_path: &Path) -> Result<PathBuf> {
    let file_name = segment_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("WAV segment path has no UTF-8 file name")?;
    Ok(segment_path.with_file_name(format!(".{file_name}{SEGMENT_DESCRIPTOR_TEMP_SUFFIX}")))
}

fn segment_encoding_name(bit_depth: u16) -> Result<&'static str> {
    match bit_depth {
        16 | 24 => Ok("pcm"),
        32 => Ok("float"),
        _ => bail!("bit depth must be one of 16-bit PCM, 24-bit PCM, or 32-bit Float"),
    }
}

fn expected_segment_descriptor(
    segment_path: &Path,
    segment_index: u32,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    max_frames_per_segment: u64,
) -> Result<SegmentDescriptor> {
    let segment_file = segment_path
        .file_name()
        .and_then(|name| name.to_str())
        .context("WAV segment path has no UTF-8 file name")?
        .to_string();
    let layout = WavLayout::for_bit_depth(bit_depth)?;
    Ok(SegmentDescriptor {
        schema_version: 1,
        kind: SEGMENT_DESCRIPTOR_KIND.to_string(),
        segment_index,
        segment_file,
        sample_rate,
        channels,
        bit_depth,
        encoding: segment_encoding_name(bit_depth)?.to_string(),
        header_len: layout.header_len,
        max_frames_per_segment,
    })
}

fn create_segment_descriptor(
    segment_path: &Path,
    segment_index: u32,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    max_frames_per_segment: u64,
) -> Result<()> {
    let descriptor_path = segment_descriptor_path(segment_path)?;
    let temporary = segment_descriptor_temp_path(segment_path)?;
    if std::fs::symlink_metadata(&descriptor_path).is_ok() {
        bail!(
            "refusing to overwrite WAV segment descriptor {}",
            descriptor_path.display()
        );
    }
    if std::fs::symlink_metadata(&temporary).is_ok() {
        bail!(
            "temporary WAV segment descriptor already exists: {}",
            temporary.display()
        );
    }
    let descriptor = expected_segment_descriptor(
        segment_path,
        segment_index,
        sample_rate,
        channels,
        bit_depth,
        max_frames_per_segment,
    )?;
    write_segment_descriptor_temporary(&temporary, &descriptor)?;
    durable_rename(&temporary, &descriptor_path).with_context(|| {
        format!(
            "publish WAV segment descriptor {} as {}",
            temporary.display(),
            descriptor_path.display()
        )
    })
}

fn replace_segment_descriptor(
    segment_path: &Path,
    segment_index: u32,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    max_frames_per_segment: u64,
) -> Result<()> {
    let descriptor_path = segment_descriptor_path(segment_path)?;
    let temporary = segment_descriptor_temp_path(segment_path)?;
    if std::fs::symlink_metadata(&temporary).is_ok() {
        bail!(
            "temporary WAV segment descriptor already exists: {}",
            temporary.display()
        );
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&descriptor_path)
        && metadata.is_dir()
        && !metadata.file_type().is_symlink()
    {
        bail!(
            "WAV segment descriptor path is a directory and cannot be repaired: {}",
            descriptor_path.display()
        );
    }
    let descriptor = expected_segment_descriptor(
        segment_path,
        segment_index,
        sample_rate,
        channels,
        bit_depth,
        max_frames_per_segment,
    )?;
    write_segment_descriptor_temporary(&temporary, &descriptor)?;
    durable_replace(&temporary, &descriptor_path).with_context(|| {
        format!(
            "replace invalid WAV segment descriptor {} from {}",
            descriptor_path.display(),
            temporary.display()
        )
    })
}

fn write_segment_descriptor_temporary(
    temporary: &Path,
    descriptor: &SegmentDescriptor,
) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .with_context(|| {
            format!(
                "create temporary WAV segment descriptor {}",
                temporary.display()
            )
        })?;
    serde_json::to_writer_pretty(&mut file, &descriptor)?;
    file.write_all(b"\n")?;
    file.flush()?;
    file.sync_all()?;
    drop(file);
    Ok(())
}

/// Returns whether the immutable descriptor exists. A present but malformed,
/// mismatched, or non-regular descriptor is always a hard failure; silently
/// ignoring it would turn corrupted recovery evidence into an unsafe fallback.
fn validate_segment_descriptor(
    segment_path: &Path,
    segment_index: u32,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    max_frames_per_segment: u64,
) -> Result<bool> {
    let descriptor_path = segment_descriptor_path(segment_path)?;
    let metadata = match std::fs::symlink_metadata(&descriptor_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!(
            "WAV segment descriptor must be a regular file: {}",
            descriptor_path.display()
        );
    }
    if metadata.len() == 0 || metadata.len() > SEGMENT_DESCRIPTOR_MAX_BYTES {
        bail!(
            "WAV segment descriptor has an invalid size: {}",
            descriptor_path.display()
        );
    }
    let source = std::fs::read(&descriptor_path)
        .with_context(|| format!("read WAV segment descriptor {}", descriptor_path.display()))?;
    let actual: SegmentDescriptor = serde_json::from_slice(&source)
        .with_context(|| format!("parse WAV segment descriptor {}", descriptor_path.display()))?;
    let expected = expected_segment_descriptor(
        segment_path,
        segment_index,
        sample_rate,
        channels,
        bit_depth,
        max_frames_per_segment,
    )?;
    if actual != expected {
        bail!(
            "WAV segment descriptor does not match its trusted session format, index, or file name: {}",
            descriptor_path.display()
        );
    }
    Ok(true)
}

fn is_segment_temp_name(name: &str) -> bool {
    parse_segment_index(name, SEGMENT_TEMP_PREFIX, SEGMENT_TEMP_SUFFIX).is_some()
}

fn is_segment_descriptor_temp_name(name: &str) -> bool {
    parse_segment_index(
        name,
        SEGMENT_TEMP_PREFIX,
        &format!("{SEGMENT_SUFFIX}{SEGMENT_DESCRIPTOR_TEMP_SUFFIX}"),
    )
    .is_some()
}

fn parse_segment_index(name: &str, prefix: &str, suffix: &str) -> Option<u32> {
    let digits = name.strip_prefix(prefix)?.strip_suffix(suffix)?;
    if digits.len() != SEGMENT_DIGITS || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits
        .parse::<u32>()
        .ok()
        .filter(|index| (1..=MAX_SEGMENT_INDEX).contains(index))
}

fn cleanup_segment_temps(directory: &Path) -> Result<()> {
    let entries = std::fs::read_dir(directory)
        .with_context(|| format!("scan segment directory {}", directory.display()))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut removed_any = false;
    for entry in &entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_segment_descriptor_temp_name(name) {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .with_context(|| format!("inspect temporary WAV descriptor {}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!(
                "temporary WAV descriptor must be a regular file: {}",
                path.display()
            );
        }
        std::fs::remove_file(&path)
            .with_context(|| format!("remove temporary WAV descriptor {}", path.display()))?;
        removed_any = true;
    }
    for entry in &entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_segment_temp_name(name) {
            continue;
        }
        let temporary_path = entry.path();
        let metadata = std::fs::symlink_metadata(&temporary_path).with_context(|| {
            format!("inspect temporary WAV segment {}", temporary_path.display())
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!(
                "temporary WAV segment must be a regular file: {}",
                temporary_path.display()
            );
        }
        let index = parse_segment_index(name, SEGMENT_TEMP_PREFIX, SEGMENT_TEMP_SUFFIX)
            .context("parse temporary WAV segment index")?;
        let final_path = segment_path(directory, index)?;
        let final_missing = match std::fs::symlink_metadata(&final_path) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(error.into()),
        };
        if final_missing {
            let descriptor_path = segment_descriptor_path(&final_path)?;
            match std::fs::symlink_metadata(&descriptor_path) {
                Ok(descriptor_metadata)
                    if descriptor_metadata.is_file()
                        || descriptor_metadata.file_type().is_symlink() =>
                {
                    // Descriptor publication precedes WAV publication. If the
                    // ignored `.creating` WAV still exists and the final WAV
                    // does not, no audio callback could ever have opened it.
                    // Remove the descriptor first so another crash cannot
                    // leave reusable recovery authority without its segment.
                    std::fs::remove_file(&descriptor_path).with_context(|| {
                        format!("remove orphan WAV descriptor {}", descriptor_path.display())
                    })?;
                }
                Ok(_) => bail!(
                    "orphan WAV descriptor must be a file or symlink: {}",
                    descriptor_path.display()
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        std::fs::remove_file(&temporary_path).with_context(|| {
            format!("remove temporary WAV segment {}", temporary_path.display())
        })?;
        removed_any = true;
    }
    // Do not remove a descriptor that has neither a final nor temporary WAV.
    // Descriptor publication synchronizes the same directory that contains the
    // already-fsynced `.wav.creating` entry, so a legitimate pre-publication
    // crash is handled by the paired-temp branch above. Descriptor-only state
    // can instead mean that a recorded final segment was lost; scan_segments
    // must retain that evidence and fail closed rather than shortening history.
    if removed_any {
        sync_directory(directory)?;
    }
    Ok(())
}

fn export_temp_path(destination: &Path) -> Result<PathBuf> {
    let file_name = destination
        .file_name()
        .context("export destination has no file name")?;
    let mut temporary_name = OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(".exporting");
    Ok(destination.with_file_name(temporary_name))
}

fn prepare_export_temp(destination: &Path) -> Result<PathBuf> {
    let temporary = export_temp_path(destination)?;
    match std::fs::symlink_metadata(&temporary) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                bail!(
                    "temporary export must be a regular file: {}",
                    temporary.display()
                );
            }
            std::fs::remove_file(&temporary).with_context(|| {
                format!("remove stale temporary export {}", temporary.display())
            })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("inspect temporary export {}", temporary.display()));
        }
    }
    Ok(temporary)
}

fn publish_export(temporary: &Path, destination: &Path) -> Result<()> {
    durable_replace(temporary, destination).with_context(|| {
        format!(
            "publish temporary export {} as {}",
            temporary.display(),
            destination.display()
        )
    })
}

fn remove_export_temp_best_effort(temporary: &Path) {
    if let Ok(metadata) = std::fs::symlink_metadata(temporary)
        && metadata.is_file()
        && !metadata.file_type().is_symlink()
    {
        let _ = std::fs::remove_file(temporary);
    }
}

fn scan_segments(directory: &Path) -> Result<Vec<(u32, PathBuf)>> {
    let mut segments = Vec::new();
    let mut descriptor_indices = Vec::new();
    for entry in std::fs::read_dir(directory)
        .with_context(|| format!("scan segment directory {}", directory.display()))?
    {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if let Some(index) = parse_segment_index(
            name,
            SEGMENT_PREFIX,
            &format!("{SEGMENT_SUFFIX}{SEGMENT_DESCRIPTOR_SUFFIX}"),
        ) {
            descriptor_indices.push(index);
            continue;
        }
        if name.starts_with(SEGMENT_PREFIX)
            && name.ends_with(&format!("{SEGMENT_SUFFIX}{SEGMENT_DESCRIPTOR_SUFFIX}"))
        {
            bail!("invalid WAV segment descriptor file name: {name}");
        }
        if !name.starts_with(SEGMENT_PREFIX) || !name.ends_with(SEGMENT_SUFFIX) {
            continue;
        }
        let digits = &name[SEGMENT_PREFIX.len()..name.len() - SEGMENT_SUFFIX.len()];
        if digits.len() != SEGMENT_DIGITS || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
            bail!("invalid segmented WAV file name: {name}");
        }
        let index = digits.parse::<u32>().context("parse WAV segment index")?;
        if index == 0 {
            bail!("segmented WAV numbering must start at one");
        }
        segments.push((index, entry.path()));
    }
    segments.sort_by_key(|(index, _)| *index);
    for (offset, (index, _)) in segments.iter().enumerate() {
        let expected = u32::try_from(offset + 1)?;
        if *index != expected {
            bail!("segmented WAV numbering has a gap before segment {index:06}");
        }
    }
    for descriptor_index in descriptor_indices {
        if !segments.iter().any(|(index, _)| *index == descriptor_index) {
            bail!("WAV segment descriptor exists without segment {descriptor_index:06}");
        }
    }
    Ok(segments)
}

fn inspect_segment(
    path: &Path,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    policy: HeaderPolicy,
) -> Result<InspectedSegment> {
    let layout = WavLayout::for_bit_depth(bit_depth)?;
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("inspect WAV segment {}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        bail!("WAV segment must be a regular file: {}", path.display());
    }
    if metadata.len() < layout.header_len {
        bail!("WAV segment is shorter than its header: {}", path.display());
    }
    let mut file =
        File::open(path).with_context(|| format!("open WAV segment {}", path.display()))?;
    let mut header = vec![0u8; usize::try_from(layout.header_len)?];
    file.read_exact(&mut header)?;
    let read_u16 = |offset: usize| u16::from_le_bytes([header[offset], header[offset + 1]]);
    let read_u32 =
        |offset: usize| u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap());
    if &header[0..4] != b"RIFF"
        || &header[8..12] != b"WAVE"
        || &header[12..16] != b"fmt "
        || read_u32(16) != 16
        || read_u16(20) != layout.format_code
        || read_u16(22) != channels
        || read_u32(24) != sample_rate
        || read_u16(34) != bit_depth
    {
        bail!("WAV segment format does not match: {}", path.display());
    }
    let frame_bytes = layout.frame_bytes(channels)?;
    let expected_byte_rate = u64::from(sample_rate)
        .checked_mul(frame_bytes)
        .context("WAV byte rate overflow")?;
    if read_u16(32) != u16::try_from(frame_bytes)? || u64::from(read_u32(28)) != expected_byte_rate
    {
        bail!("WAV segment alignment is invalid: {}", path.display());
    }
    if layout.fact_frame_offset.is_some() && (&header[36..40] != b"fact" || read_u32(40) != 4) {
        bail!(
            "float WAV segment is missing its fact chunk: {}",
            path.display()
        );
    }
    if &header[layout.data_marker..layout.data_marker + 4] != b"data" {
        bail!(
            "WAV segment has an unsupported chunk layout: {}",
            path.display()
        );
    }

    let actual_data_bytes = metadata.len() - layout.header_len;
    let complete_data_bytes = actual_data_bytes - actual_data_bytes % frame_bytes;
    let complete_frames = complete_data_bytes / frame_bytes;
    if matches!(policy, HeaderPolicy::Exact) {
        if complete_data_bytes != actual_data_bytes {
            bail!(
                "closed WAV segment has an incomplete frame: {}",
                path.display()
            );
        }
        let expected_riff_size = metadata.len() - 8;
        if u64::from(read_u32(4)) != expected_riff_size
            || u64::from(read_u32(layout.data_size_offset)) != actual_data_bytes
        {
            bail!(
                "closed WAV segment header does not match EOF: {}",
                path.display()
            );
        }
        if let Some(fact_offset) = layout.fact_frame_offset
            && u64::from(read_u32(fact_offset)) != complete_frames
        {
            bail!(
                "closed float WAV fact count does not match EOF: {}",
                path.display()
            );
        }
    }
    Ok(InspectedSegment { complete_frames })
}

fn create_segment(
    path: &Path,
    segment_index: u32,
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
    max_frames_per_segment: u64,
) -> Result<RecoverableWav> {
    if std::fs::symlink_metadata(path).is_ok() {
        bail!("refusing to overwrite WAV segment {}", path.display());
    }
    let temp_path = segment_temp_path(path)?;
    if std::fs::symlink_metadata(&temp_path).is_ok() {
        bail!(
            "temporary WAV segment already exists: {}",
            temp_path.display()
        );
    }
    let mut writer = RecoverableWav::create_new(&temp_path, sample_rate, channels, bit_depth)?;
    // The temporary header is made durable while its name is still ignored by
    // recovery. Closing it before rename is required on Windows because the
    // recording lock otherwise prevents the directory entry from being moved.
    writer.checkpoint()?;
    drop(writer);
    // Publish immutable recovery authority before publishing the segment. The
    // `.creating` WAV is still ignored at this point, so a crash cannot leave
    // recorded PCM without its descriptor. Cleanup removes this descriptor
    // only when the ignored temporary remains and the final WAV is absent.
    create_segment_descriptor(
        path,
        segment_index,
        sample_rate,
        channels,
        bit_depth,
        max_frames_per_segment,
    )?;
    if std::fs::symlink_metadata(path).is_ok() {
        bail!("refusing to overwrite WAV segment {}", path.display());
    }
    durable_rename(&temp_path, path).with_context(|| {
        format!(
            "publish temporary WAV segment {} as {}",
            temp_path.display(),
            path.display()
        )
    })?;
    RecoverableWav::open_append(path, sample_rate, channels, bit_depth)
}

fn fold_closed_part(
    part: &SegmentRange,
    header_len: u64,
    frame_bytes: u64,
    bit_depth: u16,
    fold: &mut ReviewWaveformFold,
) -> Result<()> {
    let mut source = File::open(&part.path)
        .with_context(|| format!("open WAV segment {}", part.path.display()))?;
    source.seek(SeekFrom::Start(
        header_len + part.local_start_frame * frame_bytes,
    ))?;
    let mut remaining = (part.local_end_frame - part.local_start_frame) * frame_bytes;
    let mut buffer = vec![0u8; 48 * 1024];
    while remaining > 0 {
        let mut count = remaining.min(buffer.len() as u64);
        count -= count % frame_bytes;
        if count == 0 {
            count = remaining;
        }
        let count = usize::try_from(count)?;
        source.read_exact(&mut buffer[..count])?;
        fold.push_bytes(&buffer[..count], bit_depth)?;
        remaining -= count as u64;
    }
    Ok(())
}

fn copy_closed_part(
    part: &SegmentRange,
    header_len: u64,
    frame_bytes: u64,
    output: &mut WavExportWriter,
) -> Result<()> {
    let mut source = File::open(&part.path)
        .with_context(|| format!("open WAV segment {}", part.path.display()))?;
    source.seek(SeekFrom::Start(
        header_len + part.local_start_frame * frame_bytes,
    ))?;
    let mut remaining = (part.local_end_frame - part.local_start_frame) * frame_bytes;
    let mut buffer = vec![0u8; 48 * 1024];
    while remaining > 0 {
        let mut count = remaining.min(buffer.len() as u64);
        count -= count % frame_bytes;
        if count == 0 {
            count = remaining;
        }
        let count = usize::try_from(count)?;
        source.read_exact(&mut buffer[..count])?;
        output.write_encoded_samples(&buffer[..count])?;
        remaining -= count as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const CRASH_WRITER_ROOT_ENV: &str = "DATABAKER_SEGMENTED_WAV_CRASH_WRITER_ROOT";
    const CRASH_WRITER_HELPER_TEST: &str = "segmented_wav::tests::subprocess_crash_writer_helper";

    fn test_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "databaker-segmented-wav-{name}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn audio_bytes(path: &Path, bit_depth: u16) -> Vec<u8> {
        let layout = WavLayout::for_bit_depth(bit_depth).unwrap();
        let bytes = std::fs::read(path).unwrap();
        let data_bytes = usize::try_from(u32::from_le_bytes(
            bytes[layout.data_size_offset..layout.data_size_offset + 4]
                .try_into()
                .unwrap(),
        ))
        .unwrap();
        let start = usize::try_from(layout.header_len).unwrap();
        bytes[start..start + data_bytes].to_vec()
    }

    #[test]
    fn subprocess_crash_writer_helper() {
        let Some(root) = std::env::var_os(CRASH_WRITER_ROOT_ENV).map(PathBuf::from) else {
            return;
        };
        let segment_dir = root.join("segments");
        let mut writer = SegmentedWav::create(&segment_dir, 48_000, 1, 24, 4).unwrap();
        writer
            .write_samples(&[-0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75])
            .unwrap();

        // The first segment was finalized by rollover, while the second has
        // physical PCM beyond its deliberately stale WAV header. Tell the
        // parent only after both states are observable from another process.
        std::fs::write(root.join("writer-ready"), b"ready").unwrap();
        loop {
            std::hint::black_box(writer.global_frames());
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    #[test]
    fn resumes_a_real_segment_writer_after_external_process_kill() {
        let root = test_root("external-kill");
        let segment_dir = root.join("segments");
        let active_path = segment_dir.join("master-000002.wav");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(CRASH_WRITER_HELPER_TEST)
            .arg("--nocapture")
            .env(CRASH_WRITER_ROOT_ENV, &root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                panic!("crash writer helper exited before it could be killed: {status}");
            }
            let pcm_is_visible =
                std::fs::metadata(&active_path).is_ok_and(|metadata| metadata.len() >= 44 + 3 * 3);
            if root.join("writer-ready").is_file() && pcm_is_visible {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("timed out waiting for the crash writer helper");
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        child.kill().unwrap();
        let killed = child.wait().unwrap();
        assert!(!killed.success());

        let closed_path = segment_dir.join("master-000001.wav");
        let closed_before_resume = std::fs::read(&closed_path).unwrap();
        let mut resumed = SegmentedWav::resume(&segment_dir, 48_000, 1, 24, 4).unwrap();
        assert_eq!(resumed.global_frames(), 7);
        assert_eq!(
            resumed
                .segments()
                .iter()
                .map(|segment| (segment.frames, segment.active))
                .collect::<Vec<_>>(),
            vec![(4, false), (3, true)]
        );

        resumed.write_samples(&[0.875]).unwrap();
        assert_eq!(resumed.checkpoint().unwrap(), 8);
        assert_eq!(std::fs::read(&closed_path).unwrap(), closed_before_resume);

        let recovered_export = root.join("recovered.wav");
        assert_eq!(resumed.export_whole(&recovered_export).unwrap(), 8);

        let reference_dir = root.join("reference");
        let mut reference = SegmentedWav::create(&reference_dir, 48_000, 1, 24, 4).unwrap();
        reference
            .write_samples(&[-0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.875])
            .unwrap();
        reference.checkpoint().unwrap();
        let reference_export = root.join("reference.wav");
        assert_eq!(reference.export_whole(&reference_export).unwrap(), 8);
        assert_eq!(
            std::fs::read(&recovered_export).unwrap(),
            std::fs::read(&reference_export).unwrap()
        );

        drop(reference);
        drop(resumed);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rolls_and_exports_continuous_audio_at_every_bit_depth() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("roll-{bit_depth}"));
            let segment_dir = root.join("segments");
            let mut writer = SegmentedWav::create(&segment_dir, 48_000, 1, bit_depth, 3).unwrap();
            writer
                .write_samples(&[-0.8, -0.6, -0.4, -0.2, 0.0, 0.2, 0.4, 0.6])
                .unwrap();
            assert_eq!(writer.checkpoint().unwrap(), 8);
            assert_eq!(
                writer
                    .segments()
                    .iter()
                    .map(|segment| segment.frames)
                    .collect::<Vec<_>>(),
                vec![3, 3, 2]
            );
            let parts = writer.range_parts(2, 7).unwrap();
            assert_eq!(parts.len(), 3);

            let whole = root.join("whole.wav");
            let slice = root.join("slice.wav");
            assert_eq!(writer.export_whole(&whole).unwrap(), 8);
            assert_eq!(writer.export_range(&slice, 2, 7).unwrap(), 5);
            let segment_paths = writer
                .segments()
                .into_iter()
                .map(|segment| segment.path)
                .collect::<Vec<_>>();
            // RecoverableWav deliberately locks the active segment. A second
            // read handle is rejected on Windows, so release the recorder
            // handle before independently verifying the physical files.
            drop(writer);
            let stitched = segment_paths
                .iter()
                .flat_map(|path| audio_bytes(path, bit_depth))
                .collect::<Vec<_>>();
            assert_eq!(audio_bytes(&whole, bit_depth), stitched);
            let frame_bytes = usize::from(bit_depth / 8);
            assert_eq!(
                audio_bytes(&slice, bit_depth),
                stitched[2 * frame_bytes..7 * frame_bytes]
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn non_finite_block_is_rejected_before_crossing_a_segment_boundary() {
        let root = test_root("non-finite-boundary");
        let segment_dir = root.join("segments");
        let mut writer = SegmentedWav::create(&segment_dir, 48_000, 1, 32, 3).unwrap();
        writer.write_samples(&[0.1, 0.2]).unwrap();

        let error = writer.write_samples(&[0.3, f32::NAN]).unwrap_err();
        assert!(format!("{error:#}").contains("non-finite"));
        assert_eq!(writer.global_frames(), 2);
        assert_eq!(writer.segments().len(), 1);

        writer.write_samples(&[0.4]).unwrap();
        assert_eq!(writer.finalize().unwrap(), 3);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn exports_the_locked_active_segment_and_restores_its_append_cursor() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("active-export-{bit_depth}"));
            let segment_dir = root.join("segments");
            let destination = root.join("preview.wav");
            let initial = [-0.75, -0.25, 0.25, 0.75];
            let mut writer = SegmentedWav::create(&segment_dir, 48_000, 1, bit_depth, 10).unwrap();
            writer.write_samples(&initial).unwrap();
            writer.checkpoint().unwrap();

            // Reuse the destination to exercise atomic replacement as well as
            // reading the active segment through its lock-owning file handle.
            assert_eq!(writer.export_range(&destination, 0, 1).unwrap(), 1);
            assert_eq!(writer.export_range(&destination, 1, 4).unwrap(), 3);
            writer.write_samples(&[0.5]).unwrap();
            assert_eq!(writer.checkpoint().unwrap(), 5);
            let active_path = writer.segments().last().unwrap().path.clone();
            drop(writer);

            let frame_bytes = usize::from(bit_depth / 8);
            assert_eq!(
                audio_bytes(&destination, bit_depth),
                audio_bytes(&active_path, bit_depth)[frame_bytes..4 * frame_bytes]
            );
            assert!(!export_temp_path(&destination).unwrap().exists());
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn empty_bootstrap_removes_a_pre_publish_temp_and_creates_a_valid_first_segment() {
        let root = test_root("empty-bootstrap-temp");
        assert!(SegmentedWav::resume(&root, 48_000, 1, 24, 10).is_err());

        let final_path = segment_path(&root, 1).unwrap();
        let temporary = segment_temp_path(&final_path).unwrap();
        let mut torn = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .unwrap();
        torn.write_all(b"RIFF").unwrap();
        torn.sync_all().unwrap();
        drop(torn);

        let writer = SegmentedWav::resume_or_create_empty(&root, 48_000, 1, 24, 10).unwrap();
        assert_eq!(writer.global_frames(), 0);
        assert!(final_path.is_file());
        assert!(!temporary.exists());
        drop(writer);

        let resumed = SegmentedWav::resume(&root, 48_000, 1, 24, 10).unwrap();
        assert_eq!(resumed.global_frames(), 0);
        drop(resumed);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn resumes_across_segment_boundaries_at_every_bit_depth() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("resume-{bit_depth}"));
            let mut writer = SegmentedWav::create(&root, 48_000, 1, bit_depth, 3).unwrap();
            writer.write_samples(&[0.1; 5]).unwrap();
            writer.checkpoint().unwrap();
            drop(writer);

            let mut resumed = SegmentedWav::resume(&root, 48_000, 1, bit_depth, 3).unwrap();
            assert_eq!(resumed.global_frames(), 5);
            resumed.write_samples(&[0.2; 4]).unwrap();
            assert_eq!(resumed.checkpoint().unwrap(), 9);
            assert_eq!(
                resumed
                    .segments()
                    .iter()
                    .map(|segment| segment.frames)
                    .collect::<Vec<_>>(),
                vec![3, 3, 3]
            );
            drop(resumed);

            let mut resumed = SegmentedWav::resume(&root, 48_000, 1, bit_depth, 3).unwrap();
            resumed.write_samples(&[0.3]).unwrap();
            assert_eq!(resumed.checkpoint().unwrap(), 10);
            assert_eq!(
                resumed
                    .segments()
                    .iter()
                    .map(|segment| segment.frames)
                    .collect::<Vec<_>>(),
                vec![3, 3, 3, 1]
            );
            drop(resumed);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn repairs_only_the_torn_active_tail_at_every_bit_depth() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("tail-{bit_depth}"));
            let mut writer = SegmentedWav::create(&root, 48_000, 1, bit_depth, 5).unwrap();
            writer.write_samples(&[0.1; 3]).unwrap();
            writer.checkpoint().unwrap();
            let active_path = writer.segments().last().unwrap().path.clone();
            drop(writer);

            let mut raw = OpenOptions::new().append(true).open(&active_path).unwrap();
            raw.write_all(&vec![0x55; usize::from(bit_depth / 8 - 1)])
                .unwrap();
            raw.sync_all().unwrap();
            drop(raw);

            let mut resumed = SegmentedWav::resume(&root, 48_000, 1, bit_depth, 5).unwrap();
            assert_eq!(resumed.global_frames(), 3);
            resumed.write_samples(&[0.2; 3]).unwrap();
            assert_eq!(resumed.checkpoint().unwrap(), 6);
            assert_eq!(
                resumed
                    .segments()
                    .iter()
                    .map(|segment| segment.frames)
                    .collect::<Vec<_>>(),
                vec![5, 1]
            );
            drop(resumed);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn rejects_a_missing_segment_number() {
        let root = test_root("gap");
        let mut writer = SegmentedWav::create(&root, 48_000, 1, 16, 2).unwrap();
        writer.write_samples(&[0.1; 5]).unwrap();
        writer.checkpoint().unwrap();
        drop(writer);
        std::fs::remove_file(root.join("master-000002.wav")).unwrap();
        assert!(SegmentedWav::resume(&root, 48_000, 1, 16, 2).is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rebuilds_torn_active_headers_from_the_immutable_descriptor_at_every_bit_depth() {
        for bit_depth in [16, 24, 32] {
            let layout = WavLayout::for_bit_depth(bit_depth).unwrap();
            let cases = [
                ("riff", 0usize, 4usize),
                ("fmt", 12usize, 4usize),
                ("data", layout.data_marker, 4usize),
                (
                    "complete",
                    0usize,
                    usize::try_from(layout.header_len).unwrap(),
                ),
            ];
            for (case, offset, length) in cases {
                let root = test_root(&format!("active-header-{bit_depth}-{case}"));
                let mut writer = SegmentedWav::create(&root, 48_000, 1, bit_depth, 5).unwrap();
                writer.write_samples(&[-0.75, -0.25, 0.25]).unwrap();
                writer.checkpoint().unwrap();
                let active_path = writer.segments().last().unwrap().path.clone();
                let descriptor_path = segment_descriptor_path(&active_path).unwrap();
                assert!(descriptor_path.is_file());
                // Windows keeps the active WAV range locked while the
                // recoverable writer is alive. Simulate a crashed process by
                // releasing that handle before inspecting and corrupting it.
                drop(writer);
                let before = std::fs::read(&active_path).unwrap();
                let header_len = usize::try_from(layout.header_len).unwrap();
                let audio_before = before[header_len..].to_vec();

                let mut raw = OpenOptions::new().write(true).open(&active_path).unwrap();
                raw.seek(SeekFrom::Start(offset as u64)).unwrap();
                raw.write_all(&vec![0xa5; length]).unwrap();
                raw.sync_all().unwrap();
                drop(raw);

                let repaired = SegmentedWav::resume(&root, 48_000, 1, bit_depth, 5).unwrap();
                assert_eq!(repaired.global_frames(), 3);
                assert_eq!(repaired.recovery_warnings().len(), 1);
                assert!(repaired.recovery_warnings()[0].contains("WAV 头已损坏"));
                drop(repaired);

                let repaired_bytes = std::fs::read(&active_path).unwrap();
                assert_eq!(&repaired_bytes[header_len..], audio_before);
                inspect_segment(
                    &active_path,
                    48_000,
                    1,
                    bit_depth,
                    HeaderPolicy::RecoverableTail,
                )
                .unwrap();

                // Once repaired, a second recovery is byte-for-byte idempotent
                // and no longer reports a torn-header warning.
                let second = SegmentedWav::resume(&root, 48_000, 1, bit_depth, 5).unwrap();
                assert!(second.recovery_warnings().is_empty());
                drop(second);
                assert_eq!(std::fs::read(&active_path).unwrap(), repaired_bytes);
                let _ = std::fs::remove_dir_all(root);
            }
        }
    }

    #[test]
    fn refuses_torn_or_arbitrary_active_files_without_a_trusted_descriptor() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("missing-descriptor-{bit_depth}"));
            let mut writer = SegmentedWav::create(&root, 48_000, 1, bit_depth, 5).unwrap();
            writer.write_samples(&[0.1, -0.2, 0.3]).unwrap();
            writer.checkpoint().unwrap();
            let active_path = writer.segments().last().unwrap().path.clone();
            drop(writer);
            std::fs::remove_file(segment_descriptor_path(&active_path).unwrap()).unwrap();

            let layout = WavLayout::for_bit_depth(bit_depth).unwrap();
            let arbitrary = vec![
                0x5a;
                usize::try_from(layout.header_len).unwrap()
                    + 3 * usize::from(bit_depth / 8)
            ];
            let mut raw = OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(&active_path)
                .unwrap();
            raw.write_all(&arbitrary).unwrap();
            raw.sync_all().unwrap();
            drop(raw);

            let error = SegmentedWav::resume(&root, 48_000, 1, bit_depth, 5)
                .err()
                .expect("descriptor-less arbitrary file must fail closed");
            assert!(format!("{error:#}").contains("no trusted immutable descriptor"));
            assert_eq!(std::fs::read(&active_path).unwrap(), arbitrary);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn repairs_a_bad_redundant_descriptor_when_the_active_wav_is_healthy() {
        let root = test_root("mismatched-descriptor");
        let mut writer = SegmentedWav::create(&root, 48_000, 1, 24, 5).unwrap();
        writer.write_samples(&[0.1, 0.2]).unwrap();
        writer.checkpoint().unwrap();
        let active_path = writer.segments().last().unwrap().path.clone();
        drop(writer);

        let descriptor_path = segment_descriptor_path(&active_path).unwrap();
        let mut descriptor: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&descriptor_path).unwrap()).unwrap();
        descriptor["bit_depth"] = serde_json::json!(16);
        let mut descriptor_file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&descriptor_path)
            .unwrap();
        serde_json::to_writer_pretty(&mut descriptor_file, &descriptor).unwrap();
        descriptor_file.write_all(b"\n").unwrap();
        descriptor_file.sync_all().unwrap();
        drop(descriptor_file);

        let before = std::fs::read(&active_path).unwrap();
        let resumed = SegmentedWav::resume(&root, 48_000, 1, 24, 5).unwrap();
        assert_eq!(resumed.global_frames(), 2);
        assert_eq!(resumed.recovery_warnings().len(), 1);
        assert!(resumed.recovery_warnings()[0].contains("冗余恢复描述符无效"));
        drop(resumed);
        assert_eq!(std::fs::read(&active_path).unwrap(), before);
        assert!(validate_segment_descriptor(&active_path, 1, 48_000, 1, 24, 5).unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_a_torn_active_header_when_its_descriptor_is_not_trusted() {
        let root = test_root("torn-mismatched-descriptor");
        let mut writer = SegmentedWav::create(&root, 48_000, 1, 24, 5).unwrap();
        writer.write_samples(&[0.1, 0.2]).unwrap();
        writer.checkpoint().unwrap();
        let active_path = writer.segments().last().unwrap().path.clone();
        drop(writer);

        let descriptor_path = segment_descriptor_path(&active_path).unwrap();
        let mut descriptor: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&descriptor_path).unwrap()).unwrap();
        descriptor["segment_index"] = serde_json::json!(2);
        let mut descriptor_file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&descriptor_path)
            .unwrap();
        serde_json::to_writer_pretty(&mut descriptor_file, &descriptor).unwrap();
        descriptor_file.write_all(b"\n").unwrap();
        descriptor_file.sync_all().unwrap();
        drop(descriptor_file);
        let mut wav = OpenOptions::new().write(true).open(&active_path).unwrap();
        wav.write_all(b"FAIL").unwrap();
        wav.sync_all().unwrap();
        drop(wav);

        let corrupted = std::fs::read(&active_path).unwrap();
        let error = SegmentedWav::resume(&root, 48_000, 1, 24, 5)
            .err()
            .expect("a torn header cannot use mismatched recovery authority");
        assert!(format!("{error:#}").contains("does not match"));
        assert_eq!(std::fs::read(&active_path).unwrap(), corrupted);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn retains_a_descriptor_without_a_wav_and_fails_closed() {
        let root = test_root("descriptor-only-orphan");
        let writer = SegmentedWav::create(&root, 48_000, 1, 24, 5).unwrap();
        drop(writer);
        let missing_segment = segment_path(&root, 2).unwrap();
        create_segment_descriptor(&missing_segment, 2, 48_000, 1, 24, 5).unwrap();
        let orphan = segment_descriptor_path(&missing_segment).unwrap();
        assert!(orphan.is_file());

        let error = SegmentedWav::resume(&root, 48_000, 1, 24, 5)
            .err()
            .expect("a descriptor without its WAV is evidence of an incomplete publication");
        assert!(format!("{error:#}").contains("descriptor exists without segment 000002"));
        assert!(orphan.is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn never_rebuilds_a_torn_closed_segment_even_when_its_descriptor_is_valid() {
        for bit_depth in [16, 24, 32] {
            let root = test_root(&format!("closed-torn-header-{bit_depth}"));
            let mut writer = SegmentedWav::create(&root, 48_000, 1, bit_depth, 2).unwrap();
            writer.write_samples(&[0.1; 3]).unwrap();
            writer.checkpoint().unwrap();
            drop(writer);

            let closed_path = root.join("master-000001.wav");
            assert!(segment_descriptor_path(&closed_path).unwrap().is_file());
            let before = std::fs::read(&closed_path).unwrap();
            let mut raw = OpenOptions::new().write(true).open(&closed_path).unwrap();
            raw.seek(SeekFrom::Start(0)).unwrap();
            raw.write_all(b"FAIL").unwrap();
            raw.sync_all().unwrap();
            drop(raw);
            let corrupted = std::fs::read(&closed_path).unwrap();
            assert_ne!(corrupted, before);

            assert!(SegmentedWav::resume(&root, 48_000, 1, bit_depth, 2).is_err());
            assert_eq!(std::fs::read(&closed_path).unwrap(), corrupted);
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn a_bad_closed_segment_descriptor_cannot_hide_healthy_audio() {
        let root = test_root("closed-bad-descriptor");
        let mut writer = SegmentedWav::create(&root, 48_000, 1, 24, 2).unwrap();
        writer.write_samples(&[0.1; 3]).unwrap();
        writer.checkpoint().unwrap();
        drop(writer);

        let closed_path = root.join("master-000001.wav");
        let descriptor_path = segment_descriptor_path(&closed_path).unwrap();
        let mut descriptor = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&descriptor_path)
            .unwrap();
        descriptor.write_all(b"not-json").unwrap();
        descriptor.sync_all().unwrap();
        drop(descriptor);

        let resumed = SegmentedWav::resume(&root, 48_000, 1, 24, 2).unwrap();
        assert_eq!(resumed.global_frames(), 3);
        assert_eq!(resumed.segments().len(), 2);
        drop(resumed);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_a_closed_segment_whose_header_does_not_match_eof() {
        let root = test_root("closed-header");
        let mut writer = SegmentedWav::create(&root, 48_000, 1, 16, 2).unwrap();
        writer.write_samples(&[0.1; 3]).unwrap();
        writer.checkpoint().unwrap();
        drop(writer);

        let path = root.join("master-000001.wav");
        let mut raw = OpenOptions::new().write(true).open(&path).unwrap();
        raw.seek(SeekFrom::Start(40)).unwrap();
        raw.write_all(&0u32.to_le_bytes()).unwrap();
        raw.sync_all().unwrap();
        drop(raw);
        assert!(SegmentedWav::resume(&root, 48_000, 1, 16, 2).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
