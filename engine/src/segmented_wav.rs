use crate::durable_fs::{durable_rename, durable_replace, sync_directory};
use crate::wav::{RecoverableWav, WavExportMode, WavExportWriter};
use anyhow::{Context, Result, bail};
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const SEGMENT_PREFIX: &str = "master-";
const SEGMENT_SUFFIX: &str = ".wav";
const SEGMENT_TEMP_PREFIX: &str = ".master-";
const SEGMENT_TEMP_SUFFIX: &str = ".wav.creating";
const SEGMENT_DIGITS: usize = 6;
const MAX_SEGMENT_INDEX: u32 = 999_999;

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
        let active = create_segment(&active_path, sample_rate, channels, bit_depth)?;
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
        let active_candidate = inspect_segment(
            &active_path,
            sample_rate,
            channels,
            bit_depth,
            HeaderPolicy::RecoverableTail,
        )?;
        if active_candidate.complete_frames > max_frames_per_segment {
            bail!(
                "active segment {} exceeds its configured frame limit",
                active_path.display()
            );
        }
        let active = RecoverableWav::open_append(&active_path, sample_rate, channels, bit_depth)?;
        if active.frames_written() != active_candidate.complete_frames {
            bail!("active segment changed while it was being recovered");
        }

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
        let next = create_segment(&next_path, self.sample_rate, self.channels, self.bit_depth)?;
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
        let existed = std::fs::symlink_metadata(directory).is_ok();
        std::fs::create_dir_all(directory)
            .with_context(|| format!("create segment directory {}", directory.display()))?;
        if !existed && let Some(parent) = directory.parent() {
            sync_directory(parent)?;
        }
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

fn is_segment_temp_name(name: &str) -> bool {
    let Some(digits) = name
        .strip_prefix(SEGMENT_TEMP_PREFIX)
        .and_then(|name| name.strip_suffix(SEGMENT_TEMP_SUFFIX))
    else {
        return false;
    };
    if digits.len() != SEGMENT_DIGITS || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    matches!(digits.parse::<u32>(), Ok(1..=MAX_SEGMENT_INDEX))
}

fn cleanup_segment_temps(directory: &Path) -> Result<()> {
    let mut removed_any = false;
    for entry in std::fs::read_dir(directory)
        .with_context(|| format!("scan segment directory {}", directory.display()))?
    {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !is_segment_temp_name(name) {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .with_context(|| format!("inspect temporary WAV segment {}", path.display()))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            bail!(
                "temporary WAV segment must be a regular file: {}",
                path.display()
            );
        }
        std::fs::remove_file(&path)
            .with_context(|| format!("remove temporary WAV segment {}", path.display()))?;
        removed_any = true;
    }
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
    for entry in std::fs::read_dir(directory)
        .with_context(|| format!("scan segment directory {}", directory.display()))?
    {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
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
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
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
    use std::time::{SystemTime, UNIX_EPOCH};

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
