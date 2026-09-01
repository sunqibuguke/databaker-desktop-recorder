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
    host::{
        com,
        error_emit::{emit_error, try_emit_error},
        frames_to_duration,
    },
    BufferSize, Data, Error, ErrorKind, FrameCount, InputCallbackInfo, InputStreamTimestamp,
    OutputCallbackInfo, OutputStreamTimestamp, SampleFormat, SampleRate, StreamConfig,
    StreamInstant, I24,
};

/// Shared state for extending the 32-bit `timeGetTime()` millisecond counter into a
/// monotonic 64-bit nanosecond value, shared between `now()` and audio callbacks.
#[derive(Default)]
struct TimeBase {
    last_ns: AtomicU64,
    epoch_ns: AtomicU64,
}

/// Nanosecond span of one full `timeGetTime()` wrap period (~49.7 days).
const TIMEGETIME_WRAP_NS: u64 = (u32::MAX as u64 + 1) * 1_000_000;

impl TimeBase {
    /// Convert a nanosecond timestamp to a monotonic `StreamInstant`.
    fn to_stream_instant(&self, ns: u64) -> StreamInstant {
        // `Relaxed` is sufficient: callbacks run on a single ASIO thread. The only
        // cross-thread caller is `now()`, which may race at wrap time (~1µs every 49.7 days).
        let prev = self.last_ns.swap(ns, Ordering::Relaxed);
        let epoch = if ns < prev {
            self.epoch_ns
                .fetch_add(TIMEGETIME_WRAP_NS, Ordering::Relaxed)
                + TIMEGETIME_WRAP_NS
        } else {
            self.epoch_ns.load(Ordering::Relaxed)
        };
        StreamInstant::from_nanos(epoch + ns)
    }
}

/// Matches the `startTimer(500)` call JUCE uses for debouncing ASIO driver event notifications.
const ASIO_EVENT_DEBOUNCE: Duration = Duration::from_millis(500);

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum StreamState {
    Starting = 0,
    Paused = 1,
    Playing = 2,
    Invalidated = 3,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CallbackStamp {
    buffer_index: i32,
    system_time: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CallbackContinuityResult {
    Process,
    Duplicate,
    Discontinuity(&'static str),
}

#[derive(Default)]
struct CallbackContinuity {
    // asio-sys 0.3 keeps ASIOTimeInfo::samplePosition inside its private callback
    // bridge and exposes only buffer_index/system_time here. Use both exposed signals;
    // exact frame-position continuity will require an asio-sys API extension.
    last: Option<CallbackStamp>,
}

impl CallbackContinuity {
    fn reset(&mut self) {
        self.last = None;
    }

    fn observe(
        &mut self,
        buffer_index: i32,
        system_time: u64,
        buffer_frames: usize,
        sample_rate: SampleRate,
    ) -> CallbackContinuityResult {
        if !matches!(buffer_index, 0 | 1) {
            return CallbackContinuityResult::Discontinuity(
                "driver returned an invalid double-buffer index",
            );
        }

        // A zero timestamp (or an unusable configuration) cannot establish timing
        // continuity. Keep suppressing exact duplicate buffer indices, but reset the
        // timing baseline rather than manufacturing a gap from invalid timing data.
        let current_time =
            (system_time != 0 && buffer_frames != 0 && sample_rate != 0).then_some(system_time);
        let current = CallbackStamp {
            buffer_index,
            system_time: current_time,
        };
        let Some(previous) = self.last else {
            self.last = Some(current);
            return CallbackContinuityResult::Process;
        };

        let Some(current_time) = current.system_time else {
            self.last = Some(current);
            return if buffer_index == previous.buffer_index {
                CallbackContinuityResult::Duplicate
            } else {
                CallbackContinuityResult::Process
            };
        };
        let Some(previous_time) = previous.system_time else {
            self.last = Some(current);
            return if buffer_index == previous.buffer_index {
                CallbackContinuityResult::Duplicate
            } else {
                CallbackContinuityResult::Process
            };
        };

        let elapsed = if current_time >= previous_time {
            current_time - previous_time
        } else if previous_time >= TIMEGETIME_WRAP_NS.saturating_sub(1_000_000_000)
            && current_time <= 1_000_000_000
        {
            current_time + TIMEGETIME_WRAP_NS - previous_time
        } else {
            return CallbackContinuityResult::Discontinuity("ASIO system time moved backwards");
        };

        let expected_period_ns = ((buffer_frames as u128 * 1_000_000_000u128) / sample_rate as u128)
            .min(u64::MAX as u128) as u64;
        // ASIO system time is commonly derived from timeGetTime(), whose resolution is
        // only one millisecond. Add both a fixed two-millisecond allowance and 25% of a
        // period before deciding that a whole callback went missing.
        let tolerance_ns = 2_000_000u64.max(expected_period_ns / 4);

        if buffer_index == previous.buffer_index {
            let one_missed_callback_threshold = expected_period_ns
                .saturating_mul(3)
                .saturating_div(2)
                .saturating_add(tolerance_ns);
            if elapsed > one_missed_callback_threshold {
                return CallbackContinuityResult::Discontinuity(
                    "ASIO double-buffer index did not alternate",
                );
            }
            // Some drivers issue the same callback more than once for a single buffer
            // period. Do not advance the timing baseline for those duplicates.
            return CallbackContinuityResult::Duplicate;
        }

        let multiple_missed_callbacks_threshold = expected_period_ns
            .saturating_mul(5)
            .saturating_div(2)
            .saturating_add(tolerance_ns);
        if elapsed > multiple_missed_callbacks_threshold {
            return CallbackContinuityResult::Discontinuity(
                "ASIO callback timing skipped multiple buffer periods",
            );
        }

        self.last = Some(current);
        CallbackContinuityResult::Process
    }
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

impl StreamState {
    fn load(atom: &AtomicU8, order: Ordering) -> Self {
        match atom.load(order) {
            1 => Self::Paused,
            2 => Self::Playing,
            3 => Self::Invalidated,
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
    event_timer_join: Option<std::thread::JoinHandle<()>>,
    time_base: Arc<TimeBase>,
}

struct AsioEventCallbackRegistration {
    callback_id: sys::DriverEventCallbackId,
    terminal_error_tx: mpsc::Sender<Error>,
    timer_join: std::thread::JoinHandle<()>,
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
                    self.continuity_epoch.fetch_add(1, Ordering::Release);
                    if self
                        .state
                        .compare_exchange(
                            StreamState::Paused as u8,
                            StreamState::Playing as u8,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        return Ok(());
                    }
                }
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

        // Query hardware input latency (order matters: needs buffers created above).
        // Wrapped in Arc<AtomicUsize> so the message callback can update it on
        // kAsioLatenciesChanged without touching the buffer callback.
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
            timer_join: event_timer_join,
        } = self
            .add_event_callback(
                &driver,
                error_callback,
                Arc::clone(&hardware_input_latency),
                true,
                Arc::clone(&state),
            )
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
                callback_info.buffer_index,
                callback_info.system_time,
                buffer_size,
                config.sample_rate,
            ) {
                CallbackContinuityResult::Process => {}
                CallbackContinuityResult::Duplicate => return,
                CallbackContinuityResult::Discontinuity(reason) => {
                    StreamState::Invalidated.store(&state_cb, Ordering::Release);
                    let _ = continuity_error_tx.send(Error::with_message(
                        ErrorKind::StreamInvalidated,
                        format!(
                            "ASIO input callback continuity was lost: {reason} \
                             (buffer index {}, system time {} ns)",
                            callback_info.buffer_index, callback_info.system_time
                        ),
                    ));
                    return;
                }
            }

            // There is 0% chance of lock contention the host only locks when recreating streams.
            let stream_lock = asio_streams.lock().unwrap();
            let asio_stream = match stream_lock.input {
                Some(ref asio_stream) => asio_stream,
                None => return,
            };

            let hardware_input_latency = hardware_input_latency.load(Ordering::Relaxed) as usize;

            let callback_instant = time_base_cb.to_stream_instant(callback_info.system_time);

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
            join_asio_event_timer(event_timer_join);
            if let Ok(mut streams) = asio_streams.lock() {
                streams.input = None;
            }
            return Err(build_stream_err(e));
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
            join_asio_event_timer(event_timer_join);
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
            event_timer_join: Some(event_timer_join),
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

        // Query hardware output latency (order matters: needs buffers created above).
        // Wrapped in Arc<AtomicUsize> so the message callback can update it on
        // kAsioLatenciesChanged without touching the buffer callback.
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
            timer_join: event_timer_join,
        } = self
            .add_event_callback(
                &driver,
                error_callback,
                Arc::clone(&hardware_output_latency),
                false,
                Arc::clone(&state),
            )
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
                callback_info.buffer_index,
                callback_info.system_time,
                buffer_size,
                config.sample_rate,
            ) {
                CallbackContinuityResult::Process => {}
                CallbackContinuityResult::Duplicate => return,
                CallbackContinuityResult::Discontinuity(reason) => {
                    StreamState::Invalidated.store(&state_cb, Ordering::Release);
                    let _ = continuity_error_tx.send(Error::with_message(
                        ErrorKind::StreamInvalidated,
                        format!(
                            "ASIO output callback continuity was lost: {reason} \
                             (buffer index {}, system time {} ns)",
                            callback_info.buffer_index, callback_info.system_time
                        ),
                    ));
                    return;
                }
            }

            // There is 0% chance of lock contention the host only locks when recreating streams.
            let mut stream_lock = asio_streams.lock().unwrap();
            let asio_stream = match stream_lock.output {
                Some(ref mut asio_stream) => asio_stream,
                None => return,
            };

            let hardware_output_latency = hardware_output_latency.load(Ordering::Relaxed) as usize;

            let callback_instant = time_base_cb.to_stream_instant(callback_info.system_time);

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
            join_asio_event_timer(event_timer_join);
            if let Ok(mut streams) = asio_streams.lock() {
                streams.output = None;
            }
            return Err(build_stream_err(e));
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
            join_asio_event_timer(event_timer_join);
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
            event_timer_join: Some(event_timer_join),
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
        hardware_latency: Arc<AtomicU32>,
        is_input: bool,
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
        let driver_for_latency = driver.clone();

        // Debounce timer: wait for ASIO_EVENT_DEBOUNCE of silence after the most recent event
        // before delivering to the user. Stream teardown removes both ASIO callbacks, drops every
        // sender, flushes any pending terminal error, and joins this worker.
        let (timer_tx, timer_rx) = mpsc::channel::<Error>();
        let error_cb_for_timer = Arc::clone(&error_callback_shared);
        let event_timer_join = std::thread::Builder::new()
            .name("cpal-asio-event-timer".into())
            .spawn(move || {
                run_asio_event_debounce(timer_rx, ASIO_EVENT_DEBOUNCE, error_cb_for_timer)
            })
            .map_err(|e| {
                Error::with_message(
                    ErrorKind::ResourceExhausted,
                    format!("Failed to spawn event timer thread: {e}"),
                )
            })?;

        let continuity_error_tx = timer_tx.clone();
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
                            let _ = timer_tx.send(Error::with_message(
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
                            let _ = timer_tx.send(Error::with_message(
                                ErrorKind::StreamInvalidated,
                                "Stream resynchronization was requested by the ASIO driver",
                            ));
                        }
                        true
                    }
                    sys::AsioMessageSelectors::kAsioOverload => {
                        if StreamState::load(&state, Ordering::Acquire) == StreamState::Playing {
                            let _ =
                                try_emit_error(&error_callback_shared, Error::new(ErrorKind::Xrun));
                        }
                        true
                    }
                    sys::AsioMessageSelectors::kAsioLatenciesChanged => {
                        if let Ok(latencies) = driver_for_latency.latencies() {
                            let latency = if is_input {
                                latencies.input
                            } else {
                                latencies.output
                            };
                            hardware_latency.store(latency.max(0) as u32, Ordering::Relaxed);
                        }
                        false
                    }
                    sys::AsioMessageSelectors::kAsioBufferSizeChange => {
                        // ASIO buffer pointers are valid only for the size passed to
                        // ASIOCreateBuffers. Mutating AsioStream::buffer_size here would make the
                        // next callback construct slices beyond those allocations. Stop delivery
                        // immediately and require the owner to dispose/recreate the whole stream.
                        StreamState::Invalidated.store(&state, Ordering::Release);
                        let _ = timer_tx.send(buffer_size_change_error(value));
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
                        let _ = timer_tx.send(Error::with_message(
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
            timer_join: event_timer_join,
        })
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.driver.remove_callback(self.callback_id);
        self.driver
            .remove_event_callback(self.driver_event_callback_id);
        // Removing both callbacks drops every sender. Join the worker so a
        // terminal error already queued during the debounce window is delivered
        // before stream teardown can be reported as clean.
        if let Some(join) = self.event_timer_join.take() {
            join_asio_event_timer(join);
        }
    }
}

fn join_asio_event_timer(join: std::thread::JoinHandle<()>) {
    // A user error callback is allowed to trigger arbitrary ownership changes,
    // including dropping its own Stream through shared application state. The
    // callback runs on this timer worker, so joining that same thread would
    // deadlock (or panic on platforms that detect self-join). In that one case
    // the pending error is already being delivered; detaching lets the worker
    // return normally after the callback finishes.
    if join.thread().id() != std::thread::current().id() {
        let _ = join.join();
    }
}

fn run_asio_event_debounce<E>(
    receiver: mpsc::Receiver<Error>,
    debounce: Duration,
    error_callback: Arc<Mutex<E>>,
) where
    E: FnMut(Error) + Send + 'static,
{
    let mut pending: Option<Error> = None;
    loop {
        // Use recv() when idle (no timeout needed) so we don't spin.
        let result = if pending.is_some() {
            receiver.recv_timeout(debounce)
        } else {
            receiver
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
        };
        match result {
            Ok(err) => {
                // A later event supersedes the diagnostic detail, but the
                // invalidated state remains latched from the first one.
                pending = Some(err);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(err) = pending.take() {
                    emit_error(&error_callback, err);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Stream teardown removes both ASIO callbacks and therefore all
                // senders. Do not let that normal lifecycle edge erase an
                // invalidation that arrived less than one debounce interval ago.
                if let Some(err) = pending.take() {
                    emit_error(&error_callback, err);
                }
                return;
            }
        }
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
        join_asio_event_timer, normalize_aligned_asio_i32, run_asio_event_debounce,
        CallbackContinuity, CallbackContinuityResult, Error, ErrorKind, TIMEGETIME_WRAP_NS,
    };
    use std::{
        sync::{mpsc, Arc, Mutex},
        time::Duration,
    };

    const BUFFER_FRAMES: usize = 512;
    const SAMPLE_RATE: u32 = 48_000;
    const PERIOD_NS: u64 = 10_666_666;

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
    fn buffer_size_changes_require_stream_rebuild() {
        let error = buffer_size_change_error(1024);
        assert_eq!(error.kind(), ErrorKind::StreamInvalidated);
        assert!(error.message().unwrap().contains("1024"));
        assert!(error.message().unwrap().contains("rebuilt"));
    }

    #[test]
    fn pending_terminal_error_is_delivered_once_when_stream_tears_down_before_debounce() {
        let (sender, receiver) = mpsc::channel();
        let delivered = Arc::new(Mutex::new(Vec::<(ErrorKind, String)>::new()));
        let delivered_for_callback = Arc::clone(&delivered);
        let error_callback = Arc::new(Mutex::new(move |error: Error| {
            delivered_for_callback.lock().unwrap().push((
                error.kind(),
                error.message().unwrap_or_default().to_string(),
            ));
        }));
        let worker = std::thread::spawn(move || {
            run_asio_event_debounce(receiver, Duration::from_secs(60), error_callback)
        });

        sender
            .send(Error::with_message(
                ErrorKind::StreamInvalidated,
                "terminal ASIO invalidation",
            ))
            .unwrap();
        // Dropping the final sender models Stream::drop removing both ASIO
        // callbacks before the normal 500 ms debounce expires.
        drop(sender);
        worker.join().unwrap();

        let delivered = delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].0, ErrorKind::StreamInvalidated);
        assert_eq!(delivered[0].1, "terminal ASIO invalidation");
    }

    #[test]
    fn event_callback_can_drop_its_own_stream_without_self_joining() {
        let (handle_sender, handle_receiver) = mpsc::channel();
        let (finished_sender, finished_receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let own_handle = handle_receiver.recv().unwrap();
            join_asio_event_timer(own_handle);
            finished_sender.send(()).unwrap();
        });
        handle_sender.send(worker).unwrap();

        finished_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("self-owned event timer handle must be detached instead of joined");
    }

    #[test]
    fn callback_continuity_accepts_normal_timing_and_suppresses_driver_duplicates() {
        let mut continuity = CallbackContinuity::default();
        let start = 1_000_000_000;
        assert_eq!(
            continuity.observe(0, start, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            continuity.observe(0, start, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Duplicate
        );
        assert_eq!(
            continuity.observe(1, start + PERIOD_NS, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            continuity.observe(0, start + PERIOD_NS * 2, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
    }

    #[test]
    fn callback_continuity_fails_closed_when_one_or_more_callbacks_are_missing() {
        let start = 1_000_000_000;
        let mut invalid_index = CallbackContinuity::default();
        assert_eq!(
            invalid_index.observe(2, start, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Discontinuity(
                "driver returned an invalid double-buffer index"
            )
        );

        let mut one_missing = CallbackContinuity::default();
        assert_eq!(
            one_missing.observe(0, start, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            one_missing.observe(0, start + PERIOD_NS * 2, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Discontinuity("ASIO double-buffer index did not alternate")
        );

        let mut two_missing = CallbackContinuity::default();
        assert_eq!(
            two_missing.observe(0, start, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            two_missing.observe(1, start + PERIOD_NS * 3, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Discontinuity(
                "ASIO callback timing skipped multiple buffer periods"
            )
        );
    }

    #[test]
    fn callback_continuity_rejects_backwards_time_but_accepts_timer_wrap() {
        let mut backwards = CallbackContinuity::default();
        assert_eq!(
            backwards.observe(0, 2_000_000_000, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            backwards.observe(1, 1_000_000_000, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Discontinuity("ASIO system time moved backwards")
        );

        let mut wrapping = CallbackContinuity::default();
        let before_wrap = TIMEGETIME_WRAP_NS - PERIOD_NS / 2;
        assert_eq!(
            wrapping.observe(0, before_wrap, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            wrapping.observe(1, PERIOD_NS / 2, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
    }

    #[test]
    fn callback_continuity_resets_timing_when_driver_timestamp_is_unavailable() {
        let mut continuity = CallbackContinuity::default();
        assert_eq!(
            continuity.observe(0, 0, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            continuity.observe(0, 0, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Duplicate
        );
        assert_eq!(
            continuity.observe(1, 0, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
        assert_eq!(
            continuity.observe(0, 1_000_000_000, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );

        // pause/play increments the stream epoch and calls this reset before the next
        // callback, so an intentional long pause cannot be misclassified as a gap.
        continuity.reset();
        assert_eq!(
            continuity.observe(0, 60_000_000_000, BUFFER_FRAMES, SAMPLE_RATE),
            CallbackContinuityResult::Process
        );
    }
}
