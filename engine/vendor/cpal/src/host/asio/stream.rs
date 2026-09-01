extern crate asio_sys as sys;
extern crate num_traits;

use std::{
    sync::{
        atomic::{AtomicU32, AtomicU64, AtomicU8, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

use self::num_traits::{FromPrimitive, PrimInt};
use super::Device;
use crate::{
    host::{com, error_emit::emit_error, frames_to_duration},
    BufferSize, Data, Error, ErrorKind, FrameCount, InputCallbackInfo, InputStreamTimestamp,
    OutputCallbackInfo, OutputStreamTimestamp, SampleFormat, SampleRate, StreamConfig,
    StreamInstant, I24,
};

/// Shared state for extending the 32-bit `timeGetTime()` millisecond counter into a
/// monotonic 64-bit nanosecond value, shared between `now()` and audio callbacks.
struct TimeBase {
    last_stream_ns: AtomicU64,
}

/// Nanosecond span of one full `timeGetTime()` wrap period (~49.7 days).
const TIMEGETIME_WRAP_NS: u64 = (u32::MAX as u64 + 1) * 1_000_000;
const TIMEGETIME_HALF_WRAP_NS: u64 = TIMEGETIME_WRAP_NS / 2;
const TIME_BASE_UNINITIALIZED: u64 = u64::MAX;
const ASIO_SAMPLE_RATE_CHANGED_FLAG: i32 = 1 << 4;
const ASIO_CLOCK_SOURCE_CHANGED_FLAG: i32 = 1 << 5;
const ASIO_CONFIGURATION_CHANGED_FLAGS: i32 =
    ASIO_SAMPLE_RATE_CHANGED_FLAG | ASIO_CLOCK_SOURCE_CHANGED_FLAG;

impl Default for TimeBase {
    fn default() -> Self {
        Self {
            last_stream_ns: AtomicU64::new(TIME_BASE_UNINITIALIZED),
        }
    }
}

impl TimeBase {
    /// Convert a nanosecond timestamp to a monotonic `StreamInstant`.
    fn to_stream_instant(&self, ns: u64) -> StreamInstant {
        let raw = ns % TIMEGETIME_WRAP_NS;
        loop {
            let previous = self.last_stream_ns.load(Ordering::Relaxed);
            let candidate = if previous == TIME_BASE_UNINITIALIZED {
                raw
            } else {
                let previous_raw = previous % TIMEGETIME_WRAP_NS;
                if raw >= previous_raw {
                    let forward = raw - previous_raw;
                    if forward <= TIMEGETIME_HALF_WRAP_NS {
                        previous.saturating_add(forward)
                    } else {
                        // A delayed callback from just before the previous wrap.
                        previous
                    }
                } else {
                    let backwards = previous_raw - raw;
                    if backwards > TIMEGETIME_HALF_WRAP_NS {
                        // The low 32-bit clock crossed its wrap point.
                        previous.saturating_add(TIMEGETIME_WRAP_NS - backwards)
                    } else {
                        // Small rollback or an out-of-order observation. Clamp it.
                        previous
                    }
                }
            };
            match self.last_stream_ns.compare_exchange_weak(
                previous,
                candidate,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return StreamInstant::from_nanos(candidate),
                Err(_) => continue,
            }
        }
    }
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum StreamState {
    Starting = 0,
    Paused = 1,
    Playing = 2,
    Invalidated = 3,
    Resuming = 4,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CallbackStamp {
    buffer_index: i32,
    system_time: Option<u64>,
    sample_position: Option<u64>,
    time_info_flags: i32,
}

impl CallbackStamp {
    fn from_callback_info(info: &sys::CallbackInfo) -> Self {
        Self {
            buffer_index: info.buffer_index,
            system_time: info.system_time_valid.then_some(info.system_time),
            sample_position: info.sample_position_valid.then_some(info.sample_position),
            time_info_flags: info.time_info_flags,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CallbackContinuityResult {
    Process,
    /// PCM continuity is proven by the sample clock, but the driver's system
    /// timestamp moved backwards. The timestamp is diagnostic-only.
    ProcessWithSystemTimeAnomaly,
    Duplicate,
    Discontinuity(CallbackDiscontinuity),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CallbackDiscontinuity {
    kind: ErrorKind,
    subcode: &'static str,
    reason: &'static str,
    previous: Option<CallbackStamp>,
    current: CallbackStamp,
    frame_delta: Option<u64>,
    buffer_frames: usize,
    sample_rate: SampleRate,
}

#[derive(Default)]
struct CallbackContinuity {
    last: Option<CallbackStamp>,
}

impl CallbackContinuity {
    fn reset(&mut self) {
        self.last = None;
    }

    fn observe(
        &mut self,
        current: CallbackStamp,
        buffer_frames: usize,
        sample_rate: SampleRate,
    ) -> CallbackContinuityResult {
        if !matches!(current.buffer_index, 0 | 1) {
            return CallbackContinuityResult::Discontinuity(CallbackDiscontinuity {
                kind: ErrorKind::StreamInvalidated,
                subcode: "invalid_buffer_index",
                reason: "driver returned an invalid double-buffer index",
                previous: self.last,
                current,
                frame_delta: None,
                buffer_frames,
                sample_rate,
            });
        }

        if current.time_info_flags & ASIO_CONFIGURATION_CHANGED_FLAGS != 0 {
            return CallbackContinuityResult::Discontinuity(CallbackDiscontinuity {
                kind: ErrorKind::StreamInvalidated,
                subcode: "time_info_configuration_changed",
                reason: "ASIO driver reported a sample-rate or clock-source change",
                previous: self.last,
                current,
                frame_delta: None,
                buffer_frames,
                sample_rate,
            });
        }

        let Some(current_position) = current.sample_position else {
            return CallbackContinuityResult::Discontinuity(CallbackDiscontinuity {
                kind: ErrorKind::StreamInvalidated,
                subcode: "sample_position_unavailable",
                reason: "ASIO driver did not provide a valid sample position",
                previous: self.last,
                current,
                frame_delta: None,
                buffer_frames,
                sample_rate,
            });
        };

        let Some(previous) = self.last else {
            self.last = Some(current);
            return CallbackContinuityResult::Process;
        };

        // ASIO's valid sample position is the audio clock and is therefore the
        // authoritative continuity signal. Buffer index and system time alone
        // cannot reveal an even number of missed double-buffer callbacks.
        let previous_position = previous
            .sample_position
            .expect("continuity stores only callbacks with a valid sample position");
        if current_position < previous_position {
            return CallbackContinuityResult::Discontinuity(CallbackDiscontinuity {
                kind: ErrorKind::StreamInvalidated,
                subcode: "sample_position_backwards",
                reason: "ASIO sample position moved backwards",
                previous: Some(previous),
                current,
                frame_delta: None,
                buffer_frames,
                sample_rate,
            });
        }

        let frame_delta = current_position - previous_position;
        if frame_delta == 0 {
            // Do not advance the baseline for a replay of the same physical
            // buffer; the next real block must still be compared with it.
            return if current.buffer_index == previous.buffer_index {
                CallbackContinuityResult::Duplicate
            } else {
                CallbackContinuityResult::Discontinuity(CallbackDiscontinuity {
                    kind: ErrorKind::StreamInvalidated,
                    subcode: "sample_position_stalled",
                    reason: "ASIO buffer index advanced without sample position",
                    previous: Some(previous),
                    current,
                    frame_delta: Some(0),
                    buffer_frames,
                    sample_rate,
                })
            };
        }

        if buffer_frames == 0 || frame_delta != buffer_frames as u64 {
            let (kind, subcode, reason) = if frame_delta > buffer_frames as u64 {
                (
                    ErrorKind::Xrun,
                    "sample_position_gap",
                    "ASIO sample position skipped one or more audio frames",
                )
            } else {
                (
                    ErrorKind::StreamInvalidated,
                    "sample_position_misaligned",
                    "ASIO sample position advanced by a partial buffer",
                )
            };
            return CallbackContinuityResult::Discontinuity(CallbackDiscontinuity {
                kind,
                subcode,
                reason,
                previous: Some(previous),
                current,
                frame_delta: Some(frame_delta),
                buffer_frames,
                sample_rate,
            });
        }

        if current.buffer_index == previous.buffer_index {
            return CallbackContinuityResult::Discontinuity(CallbackDiscontinuity {
                kind: ErrorKind::StreamInvalidated,
                subcode: "buffer_index_not_alternating",
                reason: "ASIO double-buffer index did not alternate for a new sample position",
                previous: Some(previous),
                current,
                frame_delta: Some(frame_delta),
                buffer_frames,
                sample_rate,
            });
        }

        self.last = Some(current);
        if system_time_moved_backwards(previous.system_time, current.system_time) {
            CallbackContinuityResult::ProcessWithSystemTimeAnomaly
        } else {
            CallbackContinuityResult::Process
        }
    }
}

fn system_time_moved_backwards(previous: Option<u64>, current: Option<u64>) -> bool {
    let (Some(previous), Some(current)) = (previous, current) else {
        return false;
    };
    let previous = previous % TIMEGETIME_WRAP_NS;
    let current = current % TIMEGETIME_WRAP_NS;
    current < previous && previous - current <= TIMEGETIME_HALF_WRAP_NS
}

fn callback_system_time_ns(info: &sys::CallbackInfo) -> u64 {
    if info.system_time_valid {
        info.system_time
    } else {
        // ASIO requires the same timeGetTime-derived clock. Use it when a
        // callback explicitly marks its systemTime field invalid.
        unsafe { windows::Win32::Media::timeGetTime() as u64 * 1_000_000 }
    }
}

fn callback_continuity_error(direction: &str, fault: CallbackDiscontinuity) -> Error {
    let previous = fault.previous.unwrap_or(CallbackStamp {
        buffer_index: -1,
        system_time: None,
        sample_position: None,
        time_info_flags: 0,
    });
    Error::with_message(
        fault.kind,
        format!(
            "ASIO {direction} callback continuity was lost: {}; subcode={}; \
             previous_buffer_index={}; current_buffer_index={}; \
             previous_system_time_ns={:?}; current_system_time_ns={:?}; \
             previous_sample_position={:?}; current_sample_position={:?}; frame_delta={:?}; \
             previous_time_info_flags=0x{:x}; current_time_info_flags=0x{:x}; \
             buffer_frames={}; sample_rate={}",
            fault.reason,
            fault.subcode,
            previous.buffer_index,
            fault.current.buffer_index,
            previous.system_time,
            fault.current.system_time,
            previous.sample_position,
            fault.current.sample_position,
            fault.frame_delta,
            previous.time_info_flags as u32,
            fault.current.time_info_flags as u32,
            fault.buffer_frames,
            fault.sample_rate,
        ),
    )
}

#[inline]
fn normalize_aligned_asio_i32(sample: i32, little_endian: bool, valid_bits: u32) -> i32 {
    let native = if little_endian {
        i32::from_le(sample)
    } else {
        i32::from_be(sample)
    };
    native.wrapping_shl(32 - valid_bits)
}

#[inline]
fn aligned_asio_i32_to_i16(sample: i32, little_endian: bool) -> i16 {
    (normalize_aligned_asio_i32(sample, little_endian, 16) >> 16) as i16
}

#[inline]
fn aligned_asio_i32_to_i24(sample: i32, little_endian: bool) -> I24 {
    I24::new(normalize_aligned_asio_i32(sample, little_endian, 24) >> 8)
        .expect("normalized ASIO sample must fit in i24")
}

fn buffer_size_change_error(value: i32) -> Error {
    let detail = if value > 0 {
        format!("ASIO driver requested buffer size {value}; the stream must be rebuilt")
    } else {
        "ASIO driver requested a buffer-size change; the stream must be rebuilt".to_owned()
    };
    Error::with_message(ErrorKind::StreamInvalidated, detail)
}

fn latency_change_error() -> Error {
    Error::with_message(
        ErrorKind::StreamInvalidated,
        "ASIO driver reported a hardware-latency change; the stream must be rebuilt",
    )
}

impl StreamState {
    fn load(atom: &AtomicU8, order: Ordering) -> Self {
        match atom.load(order) {
            1 => Self::Paused,
            2 => Self::Playing,
            3 => Self::Invalidated,
            4 => Self::Resuming,
            _ => Self::Starting,
        }
    }

    fn store(self, atom: &AtomicU8, order: Ordering) {
        atom.store(self as u8, order);
    }
}

pub struct Stream {
    state: Arc<AtomicU8>,
    continuity_epoch: Arc<AtomicU64>,
    driver: Arc<sys::Driver>,
    asio_streams: Arc<Mutex<sys::AsioStreams>>,
    callback_id: sys::BufferCallbackId,
    driver_event_callback_id: sys::DriverEventCallbackId,
    error_worker_join: Option<std::thread::JoinHandle<()>>,
    time_base: Arc<TimeBase>,
}

struct AsioEventCallbackRegistration {
    callback_id: sys::DriverEventCallbackId,
    terminal_error_tx: mpsc::Sender<Error>,
    worker_join: std::thread::JoinHandle<()>,
}

// Compile-time assertion that Stream is Send and Sync
crate::assert_stream_send!(Stream);
crate::assert_stream_sync!(Stream);

impl Stream {
    pub fn now(&self) -> StreamInstant {
        // `ASIOTimeInfo::systemTime` is specified by the ASIO SDK as nanoseconds
        // derived from `timeGetTime()`, so calling it here gives a value on the
        // same clock as the `system_time` field delivered to every callback.
        let ms = unsafe { windows::Win32::Media::timeGetTime() };
        self.time_base.to_stream_instant(ms as u64 * 1_000_000)
    }

    pub fn play(&self) -> Result<(), Error> {
        loop {
            match StreamState::load(&self.state, Ordering::Acquire) {
                StreamState::Playing => return Ok(()),
                StreamState::Invalidated => {
                    return Err(Error::with_message(
                        ErrorKind::StreamInvalidated,
                        "ASIO stream must be rebuilt before it can be played again",
                    ));
                }
                StreamState::Paused => {
                    if self
                        .state
                        .compare_exchange(
                            StreamState::Paused as u8,
                            StreamState::Resuming as u8,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        self.continuity_epoch.fetch_add(1, Ordering::Release);
                        if self
                            .state
                            .compare_exchange(
                                StreamState::Resuming as u8,
                                StreamState::Playing as u8,
                                Ordering::AcqRel,
                                Ordering::Acquire,
                            )
                            .is_ok()
                        {
                            return Ok(());
                        }
                    }
                }
                StreamState::Resuming => std::thread::yield_now(),
                StreamState::Starting => {
                    return Err(Error::with_message(
                        ErrorKind::BackendError,
                        "ASIO stream is still starting",
                    ));
                }
            }
        }
    }

    pub fn pause(&self) -> Result<(), Error> {
        loop {
            match StreamState::load(&self.state, Ordering::Acquire) {
                StreamState::Paused => return Ok(()),
                StreamState::Invalidated => {
                    return Err(Error::with_message(
                        ErrorKind::StreamInvalidated,
                        "ASIO stream must be rebuilt before it can be paused",
                    ));
                }
                StreamState::Playing => {
                    if self
                        .state
                        .compare_exchange(
                            StreamState::Playing as u8,
                            StreamState::Paused as u8,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        return Ok(());
                    }
                }
                StreamState::Resuming => std::thread::yield_now(),
                StreamState::Starting => {
                    return Err(Error::with_message(
                        ErrorKind::BackendError,
                        "ASIO stream is still starting",
                    ));
                }
            }
        }
    }

    pub fn buffer_size(&self) -> Result<FrameCount, Error> {
        let streams = self.asio_streams.lock().map_err(|_| {
            Error::with_message(ErrorKind::StreamInvalidated, "Stream lock poisoned")
        })?;
        Ok(streams
            .output
            .as_ref()
            .or(streams.input.as_ref())
            .expect("ASIO stream has neither input nor output")
            .buffer_size as FrameCount)
    }
}

impl Device {
    pub fn build_input_stream_raw<D, E>(
        &self,
        config: StreamConfig,
        sample_format: SampleFormat,
        mut data_callback: D,
        error_callback: E,
        _timeout: Option<Duration>,
    ) -> Result<Stream, Error>
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
        E: FnMut(Error) + Send + 'static,
    {
        crate::validate_stream_config(&config)?;
        com::com_initialized();
        let description = self.description()?;
        let driver = super::GLOBAL_ASIO
            .get()
            .ok_or_else(|| {
                Error::with_message(
                    ErrorKind::DeviceNotAvailable,
                    "ASIO driver is not initialized",
                )
            })?
            .load_driver(description.name())
            .map_err(load_driver_err)?;

        let stream_type = driver.input_data_type().map_err(build_stream_err)?;

        // Ensure that the desired sample type is supported.
        let expected_sample_format = super::device::convert_input_data_type(&stream_type)
            .ok_or_else(|| {
                Error::with_message(
                    ErrorKind::UnsupportedConfig,
                    "Input sample format is not supported",
                )
            })?;
        if sample_format != expected_sample_format {
            return Err(Error::with_message(
                ErrorKind::UnsupportedConfig,
                format!(
                    "Sample format {sample_format} is not supported; expected {expected_sample_format}"
                ),
            ));
        }

        let num_channels = config.channels;
        let buffer_size = self.get_or_create_input_stream(&driver, config, sample_format)?;
        let cpal_num_samples = buffer_size * num_channels as usize;

        // Create the buffer depending on the size of the data type.
        let len_bytes = cpal_num_samples * sample_format.sample_size();
        let mut interleaved = vec![0u8; len_bytes];

        // Query hardware input latency after creating the buffers. The buffer
        // callback reads the shared atomic, and we refresh it once ASIOStart has
        // returned. A runtime latency change invalidates and rebuilds the stream.
        let hardware_input_latency = Arc::new(AtomicU32::new(
            driver
                .latencies()
                .map(|latencies| latencies.input.max(0) as u32)
                .unwrap_or(0),
        ));

        let state = Arc::new(AtomicU8::new(StreamState::Starting as u8));
        let continuity_epoch = Arc::new(AtomicU64::new(0));
        let AsioEventCallbackRegistration {
            callback_id: driver_event_callback_id,
            terminal_error_tx: continuity_error_tx,
            worker_join: error_worker_join,
        } = self
            .add_event_callback(&driver, error_callback, Arc::clone(&state))
            .inspect_err(|_| {
                // Roll back the input stream stored by get_or_create_input_stream.
                if let Ok(mut streams) = self.asio_streams.lock() {
                    streams.input = None;
                }
            })?;

        let state_cb = Arc::clone(&state);
        let continuity_epoch_cb = Arc::clone(&continuity_epoch);
        let asio_streams = self.asio_streams.clone();
        let mut continuity = CallbackContinuity::default();
        let mut observed_continuity_epoch = u64::MAX;

        let time_base = Arc::new(TimeBase::default());
        let time_base_cb = Arc::clone(&time_base);
        let hardware_input_latency_cb = Arc::clone(&hardware_input_latency);

        // Set the input callback.
        // This is most performance critical part of the ASIO bindings.
        let callback_id = driver.add_callback(move |callback_info| unsafe {
            // If not playing, return early.
            if StreamState::load(&state_cb, Ordering::Acquire) != StreamState::Playing {
                return;
            }

            let current_epoch = continuity_epoch_cb.load(Ordering::Acquire);
            if current_epoch != observed_continuity_epoch {
                continuity.reset();
                observed_continuity_epoch = current_epoch;
            }
            match continuity.observe(
                CallbackStamp::from_callback_info(callback_info),
                buffer_size,
                config.sample_rate,
            ) {
                CallbackContinuityResult::Process
                | CallbackContinuityResult::ProcessWithSystemTimeAnomaly => {}
                CallbackContinuityResult::Duplicate => return,
                CallbackContinuityResult::Discontinuity(fault) => {
                    StreamState::Invalidated.store(&state_cb, Ordering::Release);
                    let _ = continuity_error_tx.send(callback_continuity_error("input", fault));
                    return;
                }
            }

            // There is 0% chance of lock contention the host only locks when recreating streams.
            let stream_lock = asio_streams.lock().unwrap();
            let asio_stream = match stream_lock.input {
                Some(ref asio_stream) => asio_stream,
                None => return,
            };

            let hardware_input_latency = hardware_input_latency_cb.load(Ordering::Relaxed) as usize;

            let callback_instant =
                time_base_cb.to_stream_instant(callback_system_time_ns(callback_info));

            /// 1. Write from the ASIO buffer to the interleaved CPAL buffer.
            /// 2. Deliver the CPAL buffer to the user callback.
            #[allow(clippy::too_many_arguments)]
            unsafe fn process_input_callback<A, D, F>(
                data_callback: &mut D,
                interleaved: &mut [u8],
                asio_stream: &sys::AsioStream,
                asio_info: &sys::CallbackInfo,
                sample_rate: SampleRate,
                format: SampleFormat,
                from_endianness: F,
                hardware_latency_frames: usize,
                callback_instant: StreamInstant,
            ) where
                A: Copy,
                D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
                F: Fn(A) -> A,
            {
                // 1. Write the ASIO channels to the CPAL buffer.
                let interleaved: &mut [A] = cast_slice_mut(interleaved);
                let n_frames = asio_stream.buffer_size as usize;
                let n_channels = interleaved.len() / n_frames;
                let buffer_index = asio_info.buffer_index as usize;
                for ch_ix in 0..n_channels {
                    let asio_channel =
                        asio_channel_slice::<A>(asio_stream, buffer_index, ch_ix, None);
                    for (frame, s_asio) in interleaved.chunks_mut(n_channels).zip(asio_channel) {
                        frame[ch_ix] = from_endianness(*s_asio);
                    }
                }

                // 2. Deliver the interleaved buffer to the callback.
                apply_input_callback_to_data::<A, _>(
                    data_callback,
                    interleaved,
                    callback_instant,
                    sample_rate,
                    format,
                    hardware_latency_frames,
                );
            }

            /// Read an ASIO 32-bit container and expose the actual representable CPAL
            /// integer format, rather than claiming that padding bits are valid audio bits.
            #[allow(clippy::too_many_arguments)]
            unsafe fn process_aligned_i32_input_callback<A, D, F>(
                data_callback: &mut D,
                interleaved: &mut [u8],
                asio_stream: &sys::AsioStream,
                asio_info: &sys::CallbackInfo,
                sample_rate: SampleRate,
                format: SampleFormat,
                convert: F,
                hardware_latency_frames: usize,
                callback_instant: StreamInstant,
            ) where
                A: Copy,
                D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
                F: Fn(i32) -> A,
            {
                let interleaved: &mut [A] = cast_slice_mut(interleaved);
                let n_frames = asio_stream.buffer_size as usize;
                let n_channels = interleaved.len() / n_frames;
                let buffer_index = asio_info.buffer_index as usize;
                for ch_ix in 0..n_channels {
                    let asio_channel =
                        asio_channel_slice::<i32>(asio_stream, buffer_index, ch_ix, None);
                    for (frame, s_asio) in interleaved.chunks_mut(n_channels).zip(asio_channel) {
                        frame[ch_ix] = convert(*s_asio);
                    }
                }

                apply_input_callback_to_data::<A, _>(
                    data_callback,
                    interleaved,
                    callback_instant,
                    sample_rate,
                    format,
                    hardware_latency_frames,
                );
            }

            match (&stream_type, sample_format) {
                (&sys::AsioSampleType::ASIOSTInt16LSB, SampleFormat::I16) => {
                    process_input_callback::<i16, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I16,
                        from_le,
                        hardware_input_latency,
                        callback_instant,
                    );
                }
                (&sys::AsioSampleType::ASIOSTInt16MSB, SampleFormat::I16) => {
                    process_input_callback::<i16, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I16,
                        from_be,
                        hardware_input_latency,
                        callback_instant,
                    );
                }

                (&sys::AsioSampleType::ASIOSTFloat32LSB, SampleFormat::F32) => {
                    process_input_callback::<u32, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::F32,
                        from_le,
                        hardware_input_latency,
                        callback_instant,
                    );
                }
                (&sys::AsioSampleType::ASIOSTFloat32MSB, SampleFormat::F32) => {
                    process_input_callback::<u32, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::F32,
                        from_be,
                        hardware_input_latency,
                        callback_instant,
                    );
                }

                (&sys::AsioSampleType::ASIOSTInt32LSB, SampleFormat::I32) => {
                    process_input_callback::<i32, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I32,
                        from_le,
                        hardware_input_latency,
                        callback_instant,
                    );
                }
                (&sys::AsioSampleType::ASIOSTInt32MSB, SampleFormat::I32) => {
                    process_input_callback::<i32, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I32,
                        from_be,
                        hardware_input_latency,
                        callback_instant,
                    );
                }
                (&sys::AsioSampleType::ASIOSTInt32LSB16, SampleFormat::I16) => {
                    process_aligned_i32_input_callback::<i16, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I16,
                        |sample| aligned_asio_i32_to_i16(sample, true),
                        hardware_input_latency,
                        callback_instant,
                    )
                }
                (&sys::AsioSampleType::ASIOSTInt32LSB24, SampleFormat::I24) => {
                    process_aligned_i32_input_callback::<I24, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I24,
                        |sample| aligned_asio_i32_to_i24(sample, true),
                        hardware_input_latency,
                        callback_instant,
                    )
                }
                (&sys::AsioSampleType::ASIOSTInt32MSB16, SampleFormat::I16) => {
                    process_aligned_i32_input_callback::<i16, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I16,
                        |sample| aligned_asio_i32_to_i16(sample, false),
                        hardware_input_latency,
                        callback_instant,
                    )
                }
                (&sys::AsioSampleType::ASIOSTInt32MSB24, SampleFormat::I24) => {
                    process_aligned_i32_input_callback::<I24, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I24,
                        |sample| aligned_asio_i32_to_i24(sample, false),
                        hardware_input_latency,
                        callback_instant,
                    )
                }

                (&sys::AsioSampleType::ASIOSTFloat64LSB, SampleFormat::F64) => {
                    process_input_callback::<u64, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::F64,
                        from_le,
                        hardware_input_latency,
                        callback_instant,
                    );
                }
                (&sys::AsioSampleType::ASIOSTFloat64MSB, SampleFormat::F64) => {
                    process_input_callback::<u64, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::F64,
                        from_be,
                        hardware_input_latency,
                        callback_instant,
                    );
                }

                (&sys::AsioSampleType::ASIOSTInt24LSB, SampleFormat::I24) => {
                    process_input_callback_i24(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        true,
                        hardware_input_latency,
                        callback_instant,
                    );
                }
                (&sys::AsioSampleType::ASIOSTInt24MSB, SampleFormat::I24) => {
                    process_input_callback_i24(
                        &mut data_callback,
                        &mut interleaved,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        false,
                        hardware_input_latency,
                        callback_instant,
                    );
                }

                unsupported_format_pair => unreachable!(
                    "`build_input_stream_raw` should have returned with unsupported \
                     format {:?}",
                    unsupported_format_pair
                ),
            }
        });

        let driver = Arc::new(driver);
        let asio_streams = self.asio_streams.clone();

        if let Err(e) = driver.start() {
            driver.remove_event_callback(driver_event_callback_id);
            driver.remove_callback(callback_id);
            join_asio_error_worker(error_worker_join);
            if let Ok(mut streams) = asio_streams.lock() {
                streams.input = None;
            }
            return Err(build_stream_err(e));
        }

        // Some drivers publish their final latency synchronously from ASIOStart.
        // Query only after ASIOStart has returned and released asio-sys's driver
        // mutex; the event callback itself must never re-enter that lock.
        if let Ok(latencies) = driver.latencies() {
            hardware_input_latency.store(latencies.input.max(0) as u32, Ordering::Relaxed);
        }

        if state
            .compare_exchange(
                StreamState::Starting as u8,
                StreamState::Paused as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            driver.remove_event_callback(driver_event_callback_id);
            driver.remove_callback(callback_id);
            join_asio_error_worker(error_worker_join);
            if let Ok(mut streams) = asio_streams.lock() {
                streams.input = None;
            }
            return Err(Error::with_message(
                ErrorKind::StreamInvalidated,
                "ASIO stream configuration changed while the input stream was starting",
            ));
        }
        Ok(Stream {
            state,
            continuity_epoch,
            driver,
            asio_streams,
            callback_id,
            driver_event_callback_id,
            error_worker_join: Some(error_worker_join),
            time_base: Arc::clone(&time_base),
        })
    }

    pub fn build_output_stream_raw<D, E>(
        &self,
        config: StreamConfig,
        sample_format: SampleFormat,
        mut data_callback: D,
        error_callback: E,
        _timeout: Option<Duration>,
    ) -> Result<Stream, Error>
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
        E: FnMut(Error) + Send + 'static,
    {
        crate::validate_stream_config(&config)?;
        com::com_initialized();
        let description = self.description()?;
        let driver = super::GLOBAL_ASIO
            .get()
            .ok_or_else(|| {
                Error::with_message(
                    ErrorKind::DeviceNotAvailable,
                    "ASIO driver is not initialized",
                )
            })?
            .load_driver(description.name())
            .map_err(load_driver_err)?;

        let stream_type = driver.output_data_type().map_err(build_stream_err)?;

        // Ensure that the desired sample type is supported.
        let expected_sample_format =
            super::device::convert_data_type(&stream_type).ok_or_else(|| {
                Error::with_message(
                    ErrorKind::UnsupportedConfig,
                    "Output sample format is not supported",
                )
            })?;
        if sample_format != expected_sample_format {
            return Err(Error::with_message(
                ErrorKind::UnsupportedConfig,
                format!(
                    "Sample format {sample_format} is not supported; expected {expected_sample_format}"
                ),
            ));
        }

        let num_channels = config.channels;
        let buffer_size = self.get_or_create_output_stream(&driver, config, sample_format)?;
        let cpal_num_samples = buffer_size * num_channels as usize;

        // Create the buffer depending on data type.
        let len_bytes = cpal_num_samples * sample_format.sample_size();
        let mut interleaved = vec![0u8; len_bytes];
        let current_callback_flag = self.current_callback_flag.clone();

        // Query hardware output latency after creating the buffers. The buffer
        // callback reads the shared atomic, and we refresh it once ASIOStart has
        // returned. A runtime latency change invalidates and rebuilds the stream.
        let hardware_output_latency = Arc::new(AtomicU32::new(
            driver
                .latencies()
                .map(|latencies| latencies.output.max(0) as u32)
                .unwrap_or(0),
        ));

        let state = Arc::new(AtomicU8::new(StreamState::Starting as u8));
        let continuity_epoch = Arc::new(AtomicU64::new(0));
        let AsioEventCallbackRegistration {
            callback_id: driver_event_callback_id,
            terminal_error_tx: continuity_error_tx,
            worker_join: error_worker_join,
        } = self
            .add_event_callback(&driver, error_callback, Arc::clone(&state))
            .inspect_err(|_| {
                // Roll back the output stream stored by get_or_create_output_stream.
                if let Ok(mut streams) = self.asio_streams.lock() {
                    streams.output = None;
                }
            })?;

        let state_cb = Arc::clone(&state);
        let continuity_epoch_cb = Arc::clone(&continuity_epoch);
        let asio_streams = self.asio_streams.clone();
        let mut continuity = CallbackContinuity::default();
        let mut observed_continuity_epoch = u64::MAX;

        let time_base = Arc::new(TimeBase::default());
        let time_base_cb = Arc::clone(&time_base);
        let hardware_output_latency_cb = Arc::clone(&hardware_output_latency);

        let callback_id = driver.add_callback(move |callback_info| unsafe {
            // If not playing, return early.
            if StreamState::load(&state_cb, Ordering::Acquire) != StreamState::Playing {
                return;
            }

            let current_epoch = continuity_epoch_cb.load(Ordering::Acquire);
            if current_epoch != observed_continuity_epoch {
                continuity.reset();
                observed_continuity_epoch = current_epoch;
            }
            match continuity.observe(
                CallbackStamp::from_callback_info(callback_info),
                buffer_size,
                config.sample_rate,
            ) {
                CallbackContinuityResult::Process
                | CallbackContinuityResult::ProcessWithSystemTimeAnomaly => {}
                CallbackContinuityResult::Duplicate => return,
                CallbackContinuityResult::Discontinuity(fault) => {
                    StreamState::Invalidated.store(&state_cb, Ordering::Release);
                    let _ = continuity_error_tx.send(callback_continuity_error("output", fault));
                    return;
                }
            }

            // There is 0% chance of lock contention the host only locks when recreating streams.
            let mut stream_lock = asio_streams.lock().unwrap();
            let asio_stream = match stream_lock.output {
                Some(ref mut asio_stream) => asio_stream,
                None => return,
            };

            let hardware_output_latency =
                hardware_output_latency_cb.load(Ordering::Relaxed) as usize;

            let callback_instant =
                time_base_cb.to_stream_instant(callback_system_time_ns(callback_info));

            // Silence the ASIO buffer that is about to be used.
            //
            // Check if any other callbacks have already silenced the buffer associated with
            // the current callback. The flag is updated once per buffer switch.
            let silence =
                current_callback_flag.load(Ordering::Acquire) != callback_info.callback_flag;

            if silence {
                current_callback_flag.store(callback_info.callback_flag, Ordering::Release);
            }

            /// 1. Render the given callback to the given buffer of interleaved samples.
            /// 2. If required, silence the ASIO buffer.
            /// 3. Finally, write the interleaved data to the non-interleaved ASIO buffer,
            ///    performing endianness conversions as necessary.
            #[allow(clippy::too_many_arguments)]
            unsafe fn process_output_callback<A, D, F>(
                data_callback: &mut D,
                interleaved: &mut [u8],
                silence_asio_buffer: bool,
                asio_stream: &mut sys::AsioStream,
                asio_info: &sys::CallbackInfo,
                sample_rate: SampleRate,
                format: SampleFormat,
                mix_samples: F,
                hardware_latency_frames: usize,
                callback_instant: StreamInstant,
            ) where
                A: Copy,
                D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
                F: Fn(A, A) -> A,
            {
                let interleaved: &mut [A] = cast_slice_mut(interleaved);
                apply_output_callback_to_data::<A, _>(
                    data_callback,
                    interleaved,
                    callback_instant,
                    sample_rate,
                    format,
                    hardware_latency_frames,
                );
                let n_channels = interleaved.len() / asio_stream.buffer_size as usize;
                let buffer_index = asio_info.buffer_index as usize;

                // Write interleaved samples to ASIO channels, one channel at a time.
                for ch_ix in 0..n_channels {
                    let asio_channel =
                        asio_channel_slice_mut::<A>(asio_stream, buffer_index, ch_ix, None);
                    if silence_asio_buffer {
                        asio_channel.align_to_mut::<u8>().1.fill(0);
                    }
                    for (frame, s_asio) in interleaved.chunks(n_channels).zip(asio_channel) {
                        *s_asio = mix_samples(*s_asio, frame[ch_ix]);
                    }
                }
            }

            interleaved.fill(0);
            match (sample_format, &stream_type) {
                (SampleFormat::I16, &sys::AsioSampleType::ASIOSTInt16LSB) => {
                    process_output_callback::<i16, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I16,
                        |old_sample, new_sample| {
                            from_le(old_sample).saturating_add(new_sample).to_le()
                        },
                        hardware_output_latency,
                        callback_instant,
                    );
                }
                (SampleFormat::I16, &sys::AsioSampleType::ASIOSTInt16MSB) => {
                    process_output_callback::<i16, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I16,
                        |old_sample, new_sample| {
                            from_be(old_sample).saturating_add(new_sample).to_be()
                        },
                        hardware_output_latency,
                        callback_instant,
                    );
                }
                (SampleFormat::F32, &sys::AsioSampleType::ASIOSTFloat32LSB) => {
                    process_output_callback::<u32, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::F32,
                        |old_sample, new_sample| {
                            (f32::from_bits(from_le(old_sample)) + f32::from_bits(new_sample))
                                .to_bits()
                                .to_le()
                        },
                        hardware_output_latency,
                        callback_instant,
                    );
                }

                (SampleFormat::F32, &sys::AsioSampleType::ASIOSTFloat32MSB) => {
                    process_output_callback::<u32, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::F32,
                        |old_sample, new_sample| {
                            (f32::from_bits(from_be(old_sample)) + f32::from_bits(new_sample))
                                .to_bits()
                                .to_be()
                        },
                        hardware_output_latency,
                        callback_instant,
                    );
                }

                (SampleFormat::I32, &sys::AsioSampleType::ASIOSTInt32LSB) => {
                    process_output_callback::<i32, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I32,
                        |old_sample, new_sample| {
                            from_le(old_sample).saturating_add(new_sample).to_le()
                        },
                        hardware_output_latency,
                        callback_instant,
                    );
                }
                (SampleFormat::I32, &sys::AsioSampleType::ASIOSTInt32MSB) => {
                    process_output_callback::<i32, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::I32,
                        |old_sample, new_sample| {
                            from_be(old_sample).saturating_add(new_sample).to_be()
                        },
                        hardware_output_latency,
                        callback_instant,
                    );
                }

                (SampleFormat::F64, &sys::AsioSampleType::ASIOSTFloat64LSB) => {
                    process_output_callback::<u64, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::F64,
                        |old_sample, new_sample| {
                            (f64::from_bits(from_le(old_sample)) + f64::from_bits(new_sample))
                                .to_bits()
                                .to_le()
                        },
                        hardware_output_latency,
                        callback_instant,
                    );
                }

                (SampleFormat::F64, &sys::AsioSampleType::ASIOSTFloat64MSB) => {
                    process_output_callback::<u64, _, _>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        SampleFormat::F64,
                        |old_sample, new_sample| {
                            (f64::from_bits(from_be(old_sample)) + f64::from_bits(new_sample))
                                .to_bits()
                                .to_be()
                        },
                        hardware_output_latency,
                        callback_instant,
                    );
                }

                (SampleFormat::I24, &sys::AsioSampleType::ASIOSTInt24LSB) => {
                    process_output_callback_i24::<_>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        true,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        hardware_output_latency,
                        callback_instant,
                    );
                }

                (SampleFormat::I24, &sys::AsioSampleType::ASIOSTInt24MSB) => {
                    process_output_callback_i24::<_>(
                        &mut data_callback,
                        &mut interleaved,
                        silence,
                        false,
                        asio_stream,
                        callback_info,
                        config.sample_rate,
                        hardware_output_latency,
                        callback_instant,
                    );
                }

                unsupported_format_pair => unreachable!(
                    "`build_output_stream_raw` should have returned with unsupported \
                     format {unsupported_format_pair:?}"
                ),
            }
        });

        let driver = Arc::new(driver);
        let asio_streams = self.asio_streams.clone();

        if let Err(e) = driver.start() {
            driver.remove_event_callback(driver_event_callback_id);
            driver.remove_callback(callback_id);
            join_asio_error_worker(error_worker_join);
            if let Ok(mut streams) = asio_streams.lock() {
                streams.output = None;
            }
            return Err(build_stream_err(e));
        }

        // Refresh after ASIOStart has released the driver's non-reentrant state
        // lock. See the matching input-stream path above.
        if let Ok(latencies) = driver.latencies() {
            hardware_output_latency.store(latencies.output.max(0) as u32, Ordering::Relaxed);
        }

        if state
            .compare_exchange(
                StreamState::Starting as u8,
                StreamState::Paused as u8,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_err()
        {
            driver.remove_event_callback(driver_event_callback_id);
            driver.remove_callback(callback_id);
            join_asio_error_worker(error_worker_join);
            if let Ok(mut streams) = asio_streams.lock() {
                streams.output = None;
            }
            return Err(Error::with_message(
                ErrorKind::StreamInvalidated,
                "ASIO stream configuration changed while the output stream was starting",
            ));
        }
        Ok(Stream {
            state,
            continuity_epoch,
            driver,
            asio_streams,
            callback_id,
            driver_event_callback_id,
            error_worker_join: Some(error_worker_join),
            time_base: Arc::clone(&time_base),
        })
    }

    /// Create a new CPAL Input Stream.
    ///
    /// If there is no existing ASIO Input Stream it will be created.
    ///
    /// On success, the buffer size of the stream is returned.
    fn get_or_create_input_stream(
        &self,
        driver: &sys::Driver,
        config: StreamConfig,
        sample_format: SampleFormat,
    ) -> Result<usize, Error> {
        let num_asio_channels = self.default_input_config()?.channels;
        check_config(driver, config, sample_format, num_asio_channels)?;
        let num_channels = config.channels as usize;
        let mut streams = self.asio_streams.lock().map_err(|_| {
            Error::with_message(ErrorKind::StreamInvalidated, "Stream lock poisoned")
        })?;

        let buffer_size = match config.buffer_size {
            BufferSize::Fixed(v) => Some(v as i32),
            BufferSize::Default => None,
        };

        // Either create a stream if thers none or had back the
        // size of the current one.
        match streams.input {
            Some(ref input) => Ok(input.buffer_size as usize),
            None => {
                let output = streams.output.take();
                driver
                    .prepare_input_stream(output, num_channels, buffer_size)
                    .map(|new_streams| {
                        let bs = match new_streams.input {
                            Some(ref inp) => inp.buffer_size as usize,
                            None => unreachable!(),
                        };
                        *streams = new_streams;
                        bs
                    })
                    .map_err(build_stream_err)
            }
        }
    }

    /// Create a new CPAL Output Stream.
    ///
    /// If there is no existing ASIO Output Stream it will be created.
    fn get_or_create_output_stream(
        &self,
        driver: &sys::Driver,
        config: StreamConfig,
        sample_format: SampleFormat,
    ) -> Result<usize, Error> {
        let num_asio_channels = self.default_output_config()?.channels;
        check_config(driver, config, sample_format, num_asio_channels)?;
        let num_channels = config.channels as usize;
        let mut streams = self.asio_streams.lock().map_err(|_| {
            Error::with_message(ErrorKind::StreamInvalidated, "Stream lock poisoned")
        })?;

        let buffer_size = match config.buffer_size {
            BufferSize::Fixed(v) => Some(v as i32),
            BufferSize::Default => None,
        };

        // Either create a stream if thers none or had back the
        // size of the current one.
        match streams.output {
            Some(ref output) => Ok(output.buffer_size as usize),
            None => {
                let input = streams.input.take();
                driver
                    .prepare_output_stream(input, num_channels, buffer_size)
                    .map(|new_streams| {
                        let bs = match new_streams.output {
                            Some(ref out) => out.buffer_size as usize,
                            None => unreachable!(),
                        };
                        *streams = new_streams;
                        bs
                    })
                    .map_err(build_stream_err)
            }
        }
    }

    fn add_event_callback<E>(
        &self,
        driver: &sys::Driver,
        error_callback: E,
        state: Arc<AtomicU8>,
    ) -> Result<AsioEventCallbackRegistration, Error>
    where
        E: FnMut(Error) + Send + 'static,
    {
        let error_callback_shared = Arc::new(Mutex::new(error_callback));
        let configured_sample_rate = match driver.sample_rate() {
            Ok(r) if r > 0.0 => Some(r),
            _ => {
                // Some drivers do not report a sample rate before a stream has started.
                None
            }
        };
        // Deliver only the first terminal root cause from a non-driver thread. This keeps
        // DataBaker's blocking fail-closed handler off ASIO callbacks without delaying health
        // publication or emitting a burst of duplicate driver notifications.
        let (error_tx, error_rx) = mpsc::channel::<Error>();
        let error_cb_for_worker = Arc::clone(&error_callback_shared);
        let error_worker_join = std::thread::Builder::new()
            .name("cpal-asio-error-worker".into())
            .spawn(move || run_asio_error_worker(error_rx, error_cb_for_worker))
            .map_err(|e| {
                Error::with_message(
                    ErrorKind::ResourceExhausted,
                    format!("Failed to spawn ASIO error worker: {e}"),
                )
            })?;

        let continuity_error_tx = error_tx.clone();
        let callback_id = driver.add_event_callback(move |event| {
            match event {
                sys::AsioDriverEvent::Message {
                    selector: msg,
                    value,
                } => match msg {
                    sys::AsioMessageSelectors::kAsioSelectorSupported => {
                        // Dynamic buffer resizing requires disposing and recreating the ASIO
                        // buffers, which cannot be done from the driver's event callback. Do not
                        // advertise support for it; an unsolicited request is handled below by
                        // invalidating the stream and requiring a full rebuild.
                        matches!(
                            sys::AsioMessageSelectors::from_i64(value as i64),
                            Some(sys::AsioMessageSelectors::kAsioOverload)
                        )
                    }
                    sys::AsioMessageSelectors::kAsioResetRequest => {
                        // Guard on Starting: some USB ASIO drivers (ASIO4ALL, Focusrite, etc.)
                        // fire spurious reset/resync requests during driver.start().
                        if StreamState::load(&state, Ordering::Acquire) != StreamState::Starting {
                            StreamState::Invalidated.store(&state, Ordering::Release);
                            let _ = error_tx.send(Error::with_message(
                                ErrorKind::StreamInvalidated,
                                "Stream reset was requested by the ASIO driver",
                            ));
                        }
                        true
                    }
                    sys::AsioMessageSelectors::kAsioResyncRequest => {
                        // Per the ASIO spec (and matching JUCE's behavior), kAsioResyncRequest
                        // means the driver needs a full stop/reinit/start. It is *not* a simple
                        // xrun notification.
                        if StreamState::load(&state, Ordering::Acquire) != StreamState::Starting {
                            StreamState::Invalidated.store(&state, Ordering::Release);
                            let _ = error_tx.send(Error::with_message(
                                ErrorKind::StreamInvalidated,
                                "Stream resynchronization was requested by the ASIO driver",
                            ));
                        }
                        true
                    }
                    sys::AsioMessageSelectors::kAsioOverload => {
                        if StreamState::load(&state, Ordering::Acquire) == StreamState::Playing {
                            // The recorder's error callback closes/drains queues and persists
                            // fault evidence. Never execute it synchronously on a driver callback
                            // thread: invalidate now and hand it to the non-real-time worker.
                            StreamState::Invalidated.store(&state, Ordering::Release);
                            let _ = error_tx.send(Error::with_message(
                                ErrorKind::Xrun,
                                "ASIO driver reported an overload",
                            ));
                        }
                        true
                    }
                    sys::AsioMessageSelectors::kAsioLatenciesChanged => {
                        // ASIOStart holds asio-sys's non-reentrant DriverState mutex, and drivers
                        // may send this notification synchronously from ASIOStart. Never call
                        // Driver::latencies here. Startup refreshes after ASIOStart returns;
                        // a runtime change invalidates the stream so it can be safely rebuilt.
                        if StreamState::load(&state, Ordering::Acquire) != StreamState::Starting {
                            StreamState::Invalidated.store(&state, Ordering::Release);
                            let _ = error_tx.send(latency_change_error());
                        }
                        false
                    }
                    sys::AsioMessageSelectors::kAsioBufferSizeChange => {
                        // ASIO buffer pointers are valid only for the size passed to
                        // ASIOCreateBuffers. Mutating AsioStream::buffer_size here would make the
                        // next callback construct slices beyond those allocations. Stop delivery
                        // immediately and require the owner to dispose/recreate the whole stream.
                        StreamState::Invalidated.store(&state, Ordering::Release);
                        let _ = error_tx.send(buffer_size_change_error(value));
                        false
                    }
                    _ => false,
                },
                sys::AsioDriverEvent::SampleRateChanged(new_rate) => {
                    let should_notify = match configured_sample_rate {
                        Some(rate) => (new_rate - rate).abs() >= 1.0,
                        None => {
                            // Unknown baseline: any reported change is treated as invalidating.
                            true
                        }
                    };
                    if should_notify
                        && StreamState::load(&state, Ordering::Acquire) != StreamState::Starting
                    {
                        StreamState::Invalidated.store(&state, Ordering::Release);
                        let _ = error_tx.send(Error::with_message(
                            ErrorKind::StreamInvalidated,
                            format!("Sample rate changed to {new_rate} Hz by the ASIO driver"),
                        ));
                    }
                    false
                }
            }
        });
        Ok(AsioEventCallbackRegistration {
            callback_id,
            terminal_error_tx: continuity_error_tx,
            worker_join: error_worker_join,
        })
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.driver.remove_callback(self.callback_id);
        self.driver
            .remove_event_callback(self.driver_event_callback_id);
        // Removing both callbacks drops every sender. Join the worker so a
        // terminal error already queued for delivery is handled before stream
        // teardown can be reported as clean.
        if let Some(join) = self.error_worker_join.take() {
            join_asio_error_worker(join);
        }
    }
}

fn join_asio_error_worker(join: std::thread::JoinHandle<()>) {
    // A user error callback is allowed to trigger arbitrary ownership changes,
    // including dropping its own Stream through shared application state. The
    // callback runs on this error worker, so joining that same thread would
    // deadlock (or panic on platforms that detect self-join). In that one case
    // the pending error is already being delivered; detaching lets the worker
    // return normally after the callback finishes.
    if join.thread().id() != std::thread::current().id() {
        let _ = join.join();
    }
}

fn run_asio_error_worker<E>(receiver: mpsc::Receiver<Error>, error_callback: Arc<Mutex<E>>)
where
    E: FnMut(Error) + Send + 'static,
{
    // Every item is terminal. FIFO receive preserves the first cause and returning
    // after one callback drops the receiver so later driver chatter is discarded.
    if let Ok(error) = receiver.recv() {
        emit_error(&error_callback, error);
    }
}

/// Check whether or not the desired config is supported by the stream.
///
/// Checks sample rate, data type, number of channels, and buffer size.
fn check_config(
    driver: &sys::Driver,
    config: StreamConfig,
    sample_format: SampleFormat,
    num_asio_channels: u16,
) -> Result<(), Error> {
    let StreamConfig {
        channels,
        sample_rate,
        buffer_size,
        share_mode: _,
    } = config;

    // Validate buffer size if `Fixed` is specified. This is necessary because ASIO's
    // `create_buffers` only validates the upper bound (returns `InvalidBufferSize` if > max) but
    // does NOT validate the lower bound. Passing a buffer size below min would be accepted but
    // behavior is unspecified.
    if let BufferSize::Fixed(requested_size) = buffer_size {
        let range = driver.buffersize_range().map_err(build_stream_err)?;
        let requested_size_i32 = requested_size as i32;
        if !(range.min..=range.max).contains(&requested_size_i32) {
            return Err(Error::with_message(
                ErrorKind::UnsupportedConfig,
                format!(
                    "Buffer size {requested_size} is not in the supported range {min}..={max}",
                    min = range.min,
                    max = range.max
                ),
            ));
        }
        if let sys::BufferPreference::Stepped { step, .. } = range.preferred {
            let offset = requested_size_i32 - range.min;
            if offset % step as i32 != 0 {
                return Err(Error::with_message(
                    ErrorKind::UnsupportedConfig,
                    format!(
                        "Buffer size {requested_size} is not valid; sizes must start at {min} and increment by {step}",
                        min = range.min
                    ),
                ));
            }
        }
    }

    // Try and set the sample rate to what the user selected.
    let sample_rate = sample_rate.into();
    if sample_rate != driver.sample_rate().map_err(build_stream_err)? {
        if driver
            .can_sample_rate(sample_rate)
            .map_err(build_stream_err)?
        {
            driver
                .set_sample_rate(sample_rate)
                .map_err(build_stream_err)?;
        } else {
            return Err(Error::with_message(
                ErrorKind::UnsupportedConfig,
                format!("Sample rate {sample_rate} Hz is not supported"),
            ));
        }
    }
    // unsigned formats are not supported by asio
    match sample_format {
        SampleFormat::I16 | SampleFormat::I24 | SampleFormat::I32 | SampleFormat::F32 => (),
        _ => {
            return Err(Error::with_message(
                ErrorKind::UnsupportedConfig,
                format!("Sample format {sample_format} is not supported"),
            ))
        }
    }
    if channels > num_asio_channels {
        return Err(Error::with_message(
            ErrorKind::UnsupportedConfig,
            format!("Channel count {channels} exceeds the maximum of {num_asio_channels}"),
        ));
    }
    Ok(())
}

/// Cast a byte slice into a mutable slice of desired type.
///
/// Safety: it's up to the caller to ensure that the input slice has valid bit representations.
#[inline]
unsafe fn cast_slice_mut<T>(v: &mut [u8]) -> &mut [T] {
    debug_assert!(v.len() % std::mem::size_of::<T>() == 0);
    std::slice::from_raw_parts_mut(v.as_mut_ptr() as *mut T, v.len() / std::mem::size_of::<T>())
}

/// Helper function to convert from little endianness.
#[inline]
fn from_le<T: PrimInt>(t: T) -> T {
    T::from_le(t)
}

/// Helper function to convert from big endianness.
#[inline]
fn from_be<T: PrimInt>(t: T) -> T {
    T::from_be(t)
}

/// Shorthand for retrieving the asio buffer slice associated with a channel.
///
/// The channel length is automatically inferred from the buffer size or some
/// value can be passed to enforce a certain length (for odd sized sample formats)
#[inline]
unsafe fn asio_channel_slice<T>(
    asio_stream: &sys::AsioStream,
    buffer_index: usize,
    channel_index: usize,
    requested_channel_length: Option<usize>,
) -> &[T] {
    let channel_length = requested_channel_length.unwrap_or(asio_stream.buffer_size as usize);
    let buff_ptr: *const T =
        asio_stream.buffer_infos[channel_index].buffers[buffer_index] as *const _;
    std::slice::from_raw_parts(buff_ptr, channel_length)
}

/// Shorthand for retrieving the asio buffer slice associated with a channel.
///
/// The channel length is automatically inferred from the buffer size or some
/// value can be passed to enforce a certain length (for odd sized sample formats)
#[inline]
unsafe fn asio_channel_slice_mut<T>(
    asio_stream: &mut sys::AsioStream,
    buffer_index: usize,
    channel_index: usize,
    requested_channel_length: Option<usize>,
) -> &mut [T] {
    let channel_length = requested_channel_length.unwrap_or(asio_stream.buffer_size as usize);
    let buff_ptr: *mut T = asio_stream.buffer_infos[channel_index].buffers[buffer_index] as *mut _;
    std::slice::from_raw_parts_mut(buff_ptr, channel_length)
}

fn load_driver_err(e: sys::LoadDriverError) -> Error {
    match e {
        sys::LoadDriverError::LoadDriverFailed | sys::LoadDriverError::DriverAlreadyExists => {
            Error::with_message(ErrorKind::DeviceNotAvailable, e.to_string())
        }
        sys::LoadDriverError::InitializationFailed(asio_err) => build_stream_err(asio_err),
    }
}

fn build_stream_err(e: sys::AsioError) -> Error {
    match e {
        sys::AsioError::NoDrivers | sys::AsioError::HardwareMalfunction => {
            Error::with_message(ErrorKind::DeviceNotAvailable, e.to_string())
        }
        sys::AsioError::InvalidInput | sys::AsioError::BadMode => {
            Error::with_message(ErrorKind::InvalidInput, e.to_string())
        }
        sys::AsioError::InvalidBufferSize | sys::AsioError::NoRate => {
            Error::with_message(ErrorKind::UnsupportedConfig, e.to_string())
        }
        sys::AsioError::HardwareStuck => Error::with_message(ErrorKind::DeviceBusy, e.to_string()),
        err => Error::with_message(ErrorKind::BackendError, err.to_string()),
    }
}

/// Convert i24 bytes to i32
#[inline]
fn i24_bytes_to_i32(i24_bytes: &[u8; 3], little_endian: bool) -> i32 {
    let sample = if little_endian {
        i32::from_le_bytes([i24_bytes[0], i24_bytes[1], i24_bytes[2], 0u8])
    } else {
        i32::from_le_bytes([i24_bytes[2], i24_bytes[1], i24_bytes[0], 0u8])
    };
    if sample & 0x800000 != 0 {
        sample | -0x1000000
    } else {
        sample
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn process_output_callback_i24<D>(
    data_callback: &mut D,
    interleaved: &mut [u8],
    silence_asio_buffer: bool,
    little_endian: bool,
    asio_stream: &mut sys::AsioStream,
    asio_info: &sys::CallbackInfo,
    sample_rate: SampleRate,
    hardware_latency_frames: usize,
    callback_instant: StreamInstant,
) where
    D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
{
    let format = SampleFormat::I24;
    let interleaved: &mut [I24] = cast_slice_mut(interleaved);
    apply_output_callback_to_data::<I24, _>(
        data_callback,
        interleaved,
        callback_instant,
        sample_rate,
        format,
        hardware_latency_frames,
    );

    // Size of samples in the ASIO buffer (has to be 3 in this case)
    let asio_sample_size_bytes = 3;
    let n_channels = interleaved.len() / asio_stream.buffer_size as usize;
    let buffer_index = asio_info.buffer_index as usize;

    // Write interleaved samples to ASIO channels, one channel at a time.
    for ch_ix in 0..n_channels {
        // Take channel as u8 array ([u8; 3] packets to represent i24)
        let asio_channel = asio_channel_slice_mut(
            asio_stream,
            buffer_index,
            ch_ix,
            Some(asio_stream.buffer_size as usize * asio_sample_size_bytes),
        );

        if silence_asio_buffer {
            asio_channel.align_to_mut::<u8>().1.fill(0);
        }

        // Fill in every channel from the interleaved vector
        for (channel_sample, sample_in_buffer) in asio_channel
            .chunks_mut(asio_sample_size_bytes)
            .zip(interleaved.iter().skip(ch_ix).step_by(n_channels))
        {
            // Add samples from buffer if no silence was applied, otherwise just overwrite
            let result = if silence_asio_buffer {
                sample_in_buffer.inner()
            } else {
                let sample = i24_bytes_to_i32(
                    &[channel_sample[0], channel_sample[1], channel_sample[2]],
                    little_endian,
                );
                (sample_in_buffer.inner() + sample).clamp(-8388608, 8388607)
            };
            let bytes = result.to_le_bytes();
            if little_endian {
                channel_sample[0] = bytes[0];
                channel_sample[1] = bytes[1];
                channel_sample[2] = bytes[2];
            } else {
                channel_sample[2] = bytes[0];
                channel_sample[1] = bytes[1];
                channel_sample[0] = bytes[2];
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn process_input_callback_i24<D>(
    data_callback: &mut D,
    interleaved: &mut [u8],
    asio_stream: &sys::AsioStream,
    asio_info: &sys::CallbackInfo,
    sample_rate: SampleRate,
    little_endian: bool,
    hardware_latency_frames: usize,
    callback_instant: StreamInstant,
) where
    D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
{
    let format = SampleFormat::I24;

    // 1. Write the ASIO channels to the CPAL buffer.
    let interleaved: &mut [I24] = cast_slice_mut(interleaved);
    let n_frames = asio_stream.buffer_size as usize;
    let n_channels = interleaved.len() / n_frames;
    let buffer_index = asio_info.buffer_index as usize;
    let asio_sample_size_bytes = 3;

    for ch_ix in 0..n_channels {
        let asio_channel = asio_channel_slice::<u8>(
            asio_stream,
            buffer_index,
            ch_ix,
            Some(n_frames * asio_sample_size_bytes),
        );
        for (channel_sample, sample_in_buffer) in asio_channel
            .chunks(asio_sample_size_bytes)
            .zip(interleaved.iter_mut().skip(ch_ix).step_by(n_channels))
        {
            let sample = i24_bytes_to_i32(
                &[channel_sample[0], channel_sample[1], channel_sample[2]],
                little_endian,
            );
            *sample_in_buffer = I24::new(sample).unwrap();
        }
    }

    // 2. Deliver the interleaved buffer to the callback.
    apply_input_callback_to_data::<I24, _>(
        data_callback,
        interleaved,
        callback_instant,
        sample_rate,
        format,
        hardware_latency_frames,
    );
}

/// Apply the output callback to the interleaved buffer.
#[inline]
unsafe fn apply_output_callback_to_data<A, D>(
    data_callback: &mut D,
    interleaved: &mut [A],
    callback_instant: StreamInstant,
    sample_rate: SampleRate,
    sample_format: SampleFormat,
    hardware_latency_frames: usize,
) where
    A: Copy,
    D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
{
    let mut data = Data::from_parts(
        interleaved.as_mut_ptr() as *mut (),
        interleaved.len(),
        sample_format,
    );
    let delay = frames_to_duration(hardware_latency_frames as FrameCount, sample_rate);
    let playback = callback_instant + delay;
    let timestamp = OutputStreamTimestamp {
        callback: callback_instant,
        playback,
    };
    let info = OutputCallbackInfo { timestamp };
    data_callback(&mut data, &info);
}

/// Apply the input callback to the interleaved buffer.
#[inline]
unsafe fn apply_input_callback_to_data<A, D>(
    data_callback: &mut D,
    interleaved: &mut [A],
    callback_instant: StreamInstant,
    sample_rate: SampleRate,
    format: SampleFormat,
    hardware_latency_frames: usize,
) where
    A: Copy,
    D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
{
    let data = Data::from_parts(
        interleaved.as_mut_ptr() as *mut (),
        interleaved.len(),
        format,
    );
    let delay = frames_to_duration(hardware_latency_frames as FrameCount, sample_rate);
    let capture = callback_instant
        .checked_sub(delay)
        .unwrap_or(StreamInstant::ZERO);
    let timestamp = InputStreamTimestamp {
        callback: callback_instant,
        capture,
    };
    let info = InputCallbackInfo { timestamp };
    data_callback(&data, &info);
}

#[cfg(test)]
mod tests {
    use super::{
        aligned_asio_i32_to_i16, aligned_asio_i32_to_i24, buffer_size_change_error,
        callback_continuity_error, join_asio_error_worker, latency_change_error,
        normalize_aligned_asio_i32, run_asio_error_worker, CallbackContinuity,
        CallbackContinuityResult, CallbackStamp, Error, ErrorKind, TimeBase,
        ASIO_CLOCK_SOURCE_CHANGED_FLAG, ASIO_SAMPLE_RATE_CHANGED_FLAG, TIMEGETIME_WRAP_NS,
    };
    use std::{
        sync::{mpsc, Arc, Mutex},
        time::Duration,
    };

    const BUFFER_FRAMES: usize = 512;
    const SAMPLE_RATE: u32 = 48_000;
    const PERIOD_NS: u64 = 10_666_666;

    fn observe(
        continuity: &mut CallbackContinuity,
        buffer_index: i32,
        system_time: Option<u64>,
        sample_position: Option<u64>,
    ) -> CallbackContinuityResult {
        let time_info_flags =
            i32::from(system_time.is_some()) | (i32::from(sample_position.is_some()) << 1);
        continuity.observe(
            CallbackStamp {
                buffer_index,
                system_time,
                sample_position,
                time_info_flags,
            },
            BUFFER_FRAMES,
            SAMPLE_RATE,
        )
    }

    fn assert_discontinuity(
        result: CallbackContinuityResult,
        expected_kind: ErrorKind,
        expected_subcode: &str,
        expected_delta: Option<u64>,
    ) {
        let CallbackContinuityResult::Discontinuity(fault) = result else {
            panic!("expected discontinuity, got {result:?}");
        };
        assert_eq!(fault.kind, expected_kind);
        assert_eq!(fault.subcode, expected_subcode);
        assert_eq!(fault.frame_delta, expected_delta);
    }

    #[test]
    fn aligned_integer_samples_use_the_full_i32_scale() {
        assert_eq!(
            normalize_aligned_asio_i32(0x007f_ffff, true, 24),
            0x7fff_ff00
        );
        assert_eq!(normalize_aligned_asio_i32(0x0080_0000, true, 24), i32::MIN);
        assert_eq!(
            normalize_aligned_asio_i32(0x0000_7fff, true, 16),
            0x7fff_0000
        );

        let big_endian_positive = i32::from_ne_bytes([0x00, 0x7f, 0xff, 0xff]);
        assert_eq!(
            normalize_aligned_asio_i32(big_endian_positive, false, 24),
            0x7fff_ff00
        );

        assert_eq!(aligned_asio_i32_to_i16(0x0000_7fff, true), i16::MAX);
        assert_eq!(aligned_asio_i32_to_i16(0x0000_8000, true), i16::MIN);
        assert_eq!(
            aligned_asio_i32_to_i24(0x007f_ffff, true).inner(),
            0x007f_ffff
        );
        assert_eq!(
            aligned_asio_i32_to_i24(0x0080_0000, true).inner(),
            -0x0080_0000
        );
    }

    #[test]
    fn asio_configuration_changes_require_stream_rebuild() {
        let error = buffer_size_change_error(1024);
        assert_eq!(error.kind(), ErrorKind::StreamInvalidated);
        assert!(error.message().unwrap().contains("1024"));
        assert!(error.message().unwrap().contains("rebuilt"));

        let latency_error = latency_change_error();
        assert_eq!(latency_error.kind(), ErrorKind::StreamInvalidated);
        assert!(latency_error.message().unwrap().contains("latency"));
        assert!(latency_error.message().unwrap().contains("rebuilt"));
    }

    #[test]
    fn error_worker_delivers_only_the_first_terminal_root_cause_without_delay() {
        let (sender, receiver) = mpsc::channel();
        let (delivered_sender, delivered_receiver) = mpsc::channel();
        let error_callback = Arc::new(Mutex::new(move |error: Error| {
            let _ = delivered_sender.send((
                error.kind(),
                error.message().unwrap_or_default().to_string(),
            ));
        }));
        let worker = std::thread::spawn(move || run_asio_error_worker(receiver, error_callback));

        sender
            .send(Error::with_message(
                ErrorKind::StreamInvalidated,
                "first driver reset",
            ))
            .unwrap();
        // Later chatter may be queued before the worker exits, but it must not
        // replace the first root cause or invoke the user callback twice.
        let _ = sender.send(Error::with_message(
            ErrorKind::Xrun,
            "later proven sample-position gap",
        ));
        let delivered = delivered_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("terminal ASIO error was not delivered promptly off the driver thread");
        assert_eq!(
            delivered,
            (ErrorKind::StreamInvalidated, "first driver reset".into())
        );

        drop(sender);
        worker.join().unwrap();
        assert!(delivered_receiver.try_recv().is_err());
    }

    #[test]
    fn error_callback_can_drop_its_own_stream_without_self_joining() {
        let (terminal_sender, terminal_receiver) = mpsc::channel();
        let (handle_sender, handle_receiver) = mpsc::channel();
        let (finished_sender, finished_receiver) = mpsc::channel();
        let error_callback = Arc::new(Mutex::new(move |_error: Error| {
            // Stream::drop owns this same JoinHandle. Re-entering Drop from the
            // user callback must detach the current worker rather than self-join.
            let own_handle = handle_receiver.recv().unwrap();
            join_asio_error_worker(own_handle);
        }));
        let worker = std::thread::spawn(move || {
            run_asio_error_worker(terminal_receiver, error_callback);
            finished_sender.send(()).unwrap();
        });
        handle_sender.send(worker).unwrap();
        terminal_sender
            .send(Error::with_message(
                ErrorKind::Xrun,
                "terminal ASIO overload",
            ))
            .unwrap();

        finished_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("error callback deadlocked while dropping its own stream");
    }

    #[test]
    fn callback_continuity_uses_valid_sample_position_as_the_audio_clock() {
        let mut continuity = CallbackContinuity::default();
        let start = 1_000_000_000;
        let position = 48_000;
        assert_eq!(
            observe(&mut continuity, 0, Some(start), Some(position)),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            observe(&mut continuity, 0, Some(start), Some(position)),
            CallbackContinuityResult::Duplicate
        );
        assert_eq!(
            observe(
                &mut continuity,
                1,
                Some(start + PERIOD_NS),
                Some(position + BUFFER_FRAMES as u64),
            ),
            CallbackContinuityResult::Process
        );
        // The sample clock proves there was no frame gap, but reusing the same
        // double-buffer slot for a new position violates the ASIO buffer contract.
        assert_discontinuity(
            observe(
                &mut continuity,
                1,
                Some(start + PERIOD_NS * 2),
                Some(position + BUFFER_FRAMES as u64 * 2),
            ),
            ErrorKind::StreamInvalidated,
            "buffer_index_not_alternating",
            Some(BUFFER_FRAMES as u64),
        );
    }

    #[test]
    fn focusrite_system_timestamp_rollback_does_not_invalidate_continuous_pcm() {
        let mut continuity = CallbackContinuity::default();
        let position = 100_000;
        assert_eq!(
            observe(
                &mut continuity,
                0,
                Some(657_861_791_667_566),
                Some(position),
            ),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            observe(
                &mut continuity,
                1,
                Some(657_861_781_000_900),
                Some(position + BUFFER_FRAMES as u64),
            ),
            CallbackContinuityResult::ProcessWithSystemTimeAnomaly
        );
        assert_eq!(
            observe(
                &mut continuity,
                0,
                Some(657_861_801_667_566),
                Some(position + BUFFER_FRAMES as u64 * 2),
            ),
            CallbackContinuityResult::Process
        );
    }

    #[test]
    fn callback_continuity_fails_closed_on_sample_clock_gaps() {
        let start = 1_000_000_000;
        let mut invalid_index = CallbackContinuity::default();
        assert_discontinuity(
            observe(&mut invalid_index, 2, Some(start), Some(0)),
            ErrorKind::StreamInvalidated,
            "invalid_buffer_index",
            None,
        );

        let mut one_missing = CallbackContinuity::default();
        assert_eq!(
            observe(&mut one_missing, 0, Some(start), Some(10_000)),
            CallbackContinuityResult::Process
        );
        assert_discontinuity(
            observe(
                &mut one_missing,
                0,
                Some(start + PERIOD_NS * 2),
                Some(10_000 + BUFFER_FRAMES as u64 * 2),
            ),
            ErrorKind::Xrun,
            "sample_position_gap",
            Some((BUFFER_FRAMES * 2) as u64),
        );

        // Missing an even number of callbacks still produces an apparently
        // correct alternating index; samplePosition is what exposes the gap.
        let mut two_missing = CallbackContinuity::default();
        assert_eq!(
            observe(&mut two_missing, 0, Some(start), Some(20_000)),
            CallbackContinuityResult::Process
        );
        assert_discontinuity(
            observe(
                &mut two_missing,
                1,
                Some(start + PERIOD_NS * 3),
                Some(20_000 + BUFFER_FRAMES as u64 * 3),
            ),
            ErrorKind::Xrun,
            "sample_position_gap",
            Some((BUFFER_FRAMES * 3) as u64),
        );
    }

    #[test]
    fn callback_continuity_rejects_invalid_sample_clock_transitions() {
        let start = 1_000_000_000;
        let mut backwards_position = CallbackContinuity::default();
        assert_eq!(
            observe(&mut backwards_position, 0, Some(start), Some(10_000)),
            CallbackContinuityResult::Process
        );
        assert_discontinuity(
            observe(
                &mut backwards_position,
                1,
                Some(start + PERIOD_NS),
                Some(9_000),
            ),
            ErrorKind::StreamInvalidated,
            "sample_position_backwards",
            None,
        );

        let mut partial_buffer = CallbackContinuity::default();
        assert_eq!(
            observe(&mut partial_buffer, 0, Some(start), Some(20_000)),
            CallbackContinuityResult::Process
        );
        assert_discontinuity(
            observe(
                &mut partial_buffer,
                1,
                Some(start + PERIOD_NS),
                Some(20_100),
            ),
            ErrorKind::StreamInvalidated,
            "sample_position_misaligned",
            Some(100),
        );
    }

    #[test]
    fn system_time_wrap_is_not_reported_as_a_clock_anomaly() {
        let mut wrapping = CallbackContinuity::default();
        let before_wrap = TIMEGETIME_WRAP_NS - PERIOD_NS / 2;
        assert_eq!(
            observe(&mut wrapping, 0, Some(before_wrap), Some(30_000)),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            observe(
                &mut wrapping,
                1,
                Some(PERIOD_NS / 2),
                Some(30_000 + BUFFER_FRAMES as u64),
            ),
            CallbackContinuityResult::Process
        );
    }

    #[test]
    fn invalid_sample_position_flags_fail_closed_without_using_stale_values() {
        let mut continuity = CallbackContinuity::default();
        assert_eq!(
            observe(&mut continuity, 0, Some(1_000_000_000), Some(40_000)),
            CallbackContinuityResult::Process
        );
        // `None` models flags marked invalid even when the raw FFI struct held
        // non-zero stale values. Neither stale field may participate here.
        assert_discontinuity(
            observe(&mut continuity, 1, None, None),
            ErrorKind::StreamInvalidated,
            "sample_position_unavailable",
            None,
        );
    }

    #[test]
    fn sample_position_is_required_even_when_buffer_and_system_time_look_normal() {
        let mut continuity = CallbackContinuity::default();
        assert_discontinuity(
            observe(&mut continuity, 0, Some(2_000_000_000), None),
            ErrorKind::StreamInvalidated,
            "sample_position_unavailable",
            None,
        );
    }

    #[test]
    fn asio_time_info_configuration_changes_invalidate_the_stream() {
        for flag in [
            ASIO_SAMPLE_RATE_CHANGED_FLAG,
            ASIO_CLOCK_SOURCE_CHANGED_FLAG,
        ] {
            let mut continuity = CallbackContinuity::default();
            assert_discontinuity(
                continuity.observe(
                    CallbackStamp {
                        buffer_index: 0,
                        system_time: Some(2_000_000_000),
                        sample_position: Some(0),
                        time_info_flags: 0b11 | flag,
                    },
                    BUFFER_FRAMES,
                    SAMPLE_RATE,
                ),
                ErrorKind::StreamInvalidated,
                "time_info_configuration_changed",
                None,
            );
            assert!(continuity.last.is_none());
        }
    }

    #[test]
    fn continuity_reset_accepts_a_new_driver_clock_baseline() {
        let mut continuity = CallbackContinuity::default();
        assert_eq!(
            observe(&mut continuity, 1, Some(2_000_000_000), Some(50_000)),
            CallbackContinuityResult::Process
        );

        // pause/play increments the stream epoch and calls this reset before the next
        // callback, so an intentional long pause cannot be misclassified as a gap.
        continuity.reset();
        assert_eq!(
            observe(&mut continuity, 0, Some(1_000), Some(0)),
            CallbackContinuityResult::Process
        );
    }

    #[test]
    fn time_base_clamps_small_rollbacks_without_manufacturing_a_full_wrap() {
        let time_base = TimeBase::default();
        let start = 2_000_000_000;
        let first = time_base.to_stream_instant(start);
        let rollback = time_base.to_stream_instant(start - 100_000);
        let recovered = time_base.to_stream_instant(start + PERIOD_NS);

        assert_eq!(rollback, first);
        assert_eq!(
            recovered.duration_since(first),
            Duration::from_nanos(PERIOD_NS)
        );
        assert!(recovered.duration_since(first) < Duration::from_secs(1));
    }

    #[test]
    fn time_base_extends_only_a_real_timegettime_wrap() {
        let time_base = TimeBase::default();
        let before_wrap = TIMEGETIME_WRAP_NS - 500_000_000;
        let first = time_base.to_stream_instant(before_wrap);
        let after = time_base.to_stream_instant(500_000_000);
        assert_eq!(after.duration_since(first), Duration::from_secs(1));
    }

    #[test]
    fn time_base_rejects_a_late_pre_wrap_observation_without_double_advancing_epoch() {
        let time_base = TimeBase::default();
        let before_wrap = TIMEGETIME_WRAP_NS - 500_000_000;
        let first = time_base.to_stream_instant(before_wrap);
        let after_wrap = time_base.to_stream_instant(200_000_000);
        let stale_pre_wrap = time_base.to_stream_instant(TIMEGETIME_WRAP_NS - 400_000_000);
        let next = time_base.to_stream_instant(300_000_000);

        assert_eq!(after_wrap.duration_since(first), Duration::from_millis(700));
        assert_eq!(stale_pre_wrap, after_wrap);
        assert_eq!(next.duration_since(after_wrap), Duration::from_millis(100));
    }

    #[test]
    fn time_base_recognizes_a_wrap_after_a_long_pause() {
        let time_base = TimeBase::default();
        let first = time_base.to_stream_instant(TIMEGETIME_WRAP_NS - 10_000_000_000);
        let after = time_base.to_stream_instant(5_000_000_000);
        assert_eq!(after.duration_since(first), Duration::from_secs(15));
    }

    #[test]
    fn sample_position_gap_maps_to_xrun_with_structured_diagnostics() {
        let mut continuity = CallbackContinuity::default();
        assert_eq!(
            observe(&mut continuity, 0, Some(1_000), Some(60_000)),
            CallbackContinuityResult::Process
        );
        let CallbackContinuityResult::Discontinuity(fault) = observe(
            &mut continuity,
            0,
            Some(1_000 + PERIOD_NS * 2),
            Some(60_000 + BUFFER_FRAMES as u64 * 2),
        ) else {
            panic!("expected sample-position gap");
        };
        let error = callback_continuity_error("input", fault);
        let message = error.message().unwrap();
        assert_eq!(error.kind(), ErrorKind::Xrun);
        assert!(message.contains("subcode=sample_position_gap"));
        assert!(message.contains("previous_sample_position=Some(60000)"));
        assert!(message.contains("frame_delta=Some(1024)"));
        assert!(message.contains("previous_time_info_flags=0x3"));
        assert!(message.contains("buffer_frames=512"));
        assert!(message.contains("sample_rate=48000"));
    }
}
