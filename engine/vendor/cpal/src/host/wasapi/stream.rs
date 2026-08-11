use std::{
    mem,
    ops::ControlFlow,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{channel, Receiver, SendError, Sender},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use windows::Win32::{
    Foundation::{self, PROPERTYKEY, WAIT_OBJECT_0},
    Media::Audio,
    System::{Performance, SystemServices, Threading},
};

use crate::{
    host::{
        com::ComString, emit_error, equilibrium::fill_equilibrium, frames_to_duration,
        latch::Latch, ErrorCallbackArc,
    },
    traits::StreamTrait,
    Data, Error, ErrorKind, FrameCount, InputCallbackInfo, InputStreamTimestamp,
    OutputCallbackInfo, OutputStreamTimestamp, ResultExt, SampleFormat, SampleRate, StreamConfig,
    StreamInstant,
};

/// Returns the current default audio endpoint for `flow`, or `None` if none exists.
///
/// Used by `OnDeviceStateChanged` and `OnDeviceRemoved` to cover the edge case where the
/// default device becomes unavailable with no replacement: in that situation Windows does
/// not fire `OnDefaultDeviceChanged`, so these callbacks must signal the run loop instead.
/// When a replacement *does* exist this returns `Some` and we skip signalling, letting
/// `OnDefaultDeviceChanged` fire as the sole notifier and avoiding a double wakeup.
fn get_current_default(flow: Audio::EDataFlow) -> Option<Audio::IMMDevice> {
    super::device::current_default_endpoint(flow)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DeviceMonitorEvent {
    DefaultDeviceChanged,
    SpecificDeviceUnavailable,
}

impl DeviceMonitorEvent {
    fn error(self) -> Error {
        match self {
            Self::DefaultDeviceChanged => {
                Error::with_message(ErrorKind::DeviceChanged, "Default audio device changed")
            }
            Self::SpecificDeviceUnavailable => Error::with_message(
                ErrorKind::DeviceNotAvailable,
                "Selected audio device is no longer available",
            ),
        }
    }

    fn is_terminal(self) -> bool {
        self == Self::SpecificDeviceUnavailable
    }
}

// `IMMDeviceEnumerator::UnregisterEndpointNotificationCallback` documents
// E_NOTFOUND as the benign "not registered" result. The SDK does not expose
// that mmdeviceapi spelling directly, so derive the same HRESULT from
// ERROR_NOT_FOUND rather than duplicating its numeric representation.
const ENDPOINT_NOTIFICATION_E_NOTFOUND: windows::core::HRESULT =
    windows::core::HRESULT::from_win32(Foundation::ERROR_NOT_FOUND.0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NotificationUnregisterOutcome {
    Unregistered,
    AlreadyAbsent,
    IndeterminateFailure,
}

fn classify_notification_unregister(
    result: &windows::core::Result<()>,
) -> NotificationUnregisterOutcome {
    match result {
        Ok(()) => NotificationUnregisterOutcome::Unregistered,
        Err(error) if error.code() == ENDPOINT_NOTIFICATION_E_NOTFOUND => {
            NotificationUnregisterOutcome::AlreadyAbsent
        }
        Err(_) => NotificationUnregisterOutcome::IndeterminateFailure,
    }
}

/// Owns the Windows auto-reset event shared by the notification client and the
/// audio run loop. The final `Arc` closes the HANDLE, so an in-progress COM
/// callback can never race a close/reuse even if unregistering fails.
struct NotificationSignal {
    event: Foundation::HANDLE,
    pending_after_set_failure: AtomicBool,
}

// SAFETY: Windows event HANDLEs support concurrent SetEvent/wait operations.
unsafe impl Send for NotificationSignal {}
unsafe impl Sync for NotificationSignal {}

impl NotificationSignal {
    fn new() -> Result<Arc<Self>, Error> {
        let event =
            unsafe { Threading::CreateEventW(None, false, false, None) }.map_err(Error::from)?;
        Ok(Arc::new(Self {
            event,
            pending_after_set_failure: AtomicBool::new(false),
        }))
    }

    fn notify(&self) {
        // SAFETY: every callback owns an Arc to this object, so the HANDLE is
        // live for the complete SetEvent call.
        unsafe {
            if Threading::SetEvent(self.event).is_err() {
                self.pending_after_set_failure
                    .store(true, Ordering::Release);
            }
        }
    }
}

impl Drop for NotificationSignal {
    fn drop(&mut self) {
        unsafe {
            let _ = Foundation::CloseHandle(self.event);
        }
    }
}

/// Registration for either a default-device stream or one explicitly bound to
/// a stable endpoint ID. Notification callbacks only signal an event; the
/// audio run thread owns this monitor and invokes the user callback.
pub(crate) struct DeviceMonitor {
    enumerator: Audio::IMMDeviceEnumerator,
    client: Audio::IMMNotificationClient,
    signal: Arc<NotificationSignal>,
    event_kind: DeviceMonitorEvent,
}

// SAFETY: `IMMDeviceEnumerator` and `IMMNotificationClient` are COM objects used only for
// register/unregister. Notification callbacks own their own Arc<NotificationSignal>.
unsafe impl Send for DeviceMonitor {}
unsafe impl Sync for DeviceMonitor {}

impl DeviceMonitor {
    pub fn new_default(
        enumerator: Audio::IMMDeviceEnumerator,
        flow: Audio::EDataFlow,
    ) -> Result<Self, Error> {
        let signal = NotificationSignal::new()?;
        let client: Audio::IMMNotificationClient = DefaultDeviceNotificationImpl {
            flow,
            signal: signal.clone(),
        }
        .into();

        Self::register(
            enumerator,
            client,
            signal,
            DeviceMonitorEvent::DefaultDeviceChanged,
        )
    }

    pub fn new_specific(
        enumerator: Audio::IMMDeviceEnumerator,
        device: Audio::IMMDevice,
    ) -> Result<Self, Error> {
        let endpoint_id = unsafe {
            let raw = device.GetId().map_err(Error::from)?;
            let _guard = ComString(raw);
            raw.to_string().map_err(|error| {
                Error::with_message(
                    ErrorKind::BackendError,
                    format!("Failed to read selected endpoint ID: {error}"),
                )
            })?
        };
        let signal = NotificationSignal::new()?;
        let client: Audio::IMMNotificationClient = SpecificDeviceNotificationImpl {
            endpoint_id,
            signal: signal.clone(),
            unavailable_notified: AtomicBool::new(false),
        }
        .into();

        let monitor = Self::register(
            enumerator,
            client,
            signal,
            DeviceMonitorEvent::SpecificDeviceUnavailable,
        )?;

        // Register first, then inspect current state. A transition before the
        // registration is visible here; a transition after it is delivered by
        // IMMNotificationClient, closing the construction race.
        let state = unsafe { device.GetState().map_err(Error::from)? };
        if is_endpoint_unavailable_state(state) {
            monitor.signal.notify();
        }
        Ok(monitor)
    }

    fn register(
        enumerator: Audio::IMMDeviceEnumerator,
        client: Audio::IMMNotificationClient,
        signal: Arc<NotificationSignal>,
        event_kind: DeviceMonitorEvent,
    ) -> Result<Self, Error> {
        unsafe {
            enumerator
                .RegisterEndpointNotificationCallback(&client)
                .map_err(Error::from)?;
        }

        Ok(Self {
            enumerator,
            client,
            signal,
            event_kind,
        })
    }

    fn event(&self) -> Foundation::HANDLE {
        self.signal.event
    }

    fn take_pending_after_set_failure(&self) -> bool {
        self.signal
            .pending_after_set_failure
            .swap(false, Ordering::AcqRel)
    }
}

impl Drop for DeviceMonitor {
    fn drop(&mut self) {
        // Ensure COM is initialised on this thread before making COM calls. Drop can run on
        // any thread (e.g. the audio run thread), which may not have called CoInitialize.
        crate::host::com::com_initialized();
        let unregister_result = unsafe {
            // Synchronous on success: waits for in-progress callbacks. Those
            // callbacks do not invoke user code, avoiding a drop-from-callback
            // deadlock.
            self.enumerator
                .UnregisterEndpointNotificationCallback(&self.client)
        };
        if classify_notification_unregister(&unregister_result)
            == NotificationUnregisterOutcome::IndeterminateFailure
        {
            // Microsoft explicitly documents that Register/Unregister do not
            // AddRef/Release the application-owned callback. A non-E_NOTFOUND
            // failure therefore leaves registration state unknown: dropping
            // our final COM reference could let Windows call a freed object.
            // Leak one strong COM reference deliberately. The callback owns an
            // Arc<NotificationSignal>, so this also keeps its event HANDLE
            // valid for every possible late notification.
            let retained_client = self.client.clone();
            mem::forget(retained_client);
            if let Err(error) = unregister_result {
                eprintln!(
                    "failed to unregister WASAPI endpoint notification callback; retaining callback for process lifetime: {error}"
                );
            }
        }
    }
}

#[windows::core::implement(Audio::IMMNotificationClient)]
struct DefaultDeviceNotificationImpl {
    flow: Audio::EDataFlow,
    signal: Arc<NotificationSignal>,
}

impl Audio::IMMNotificationClient_Impl for DefaultDeviceNotificationImpl_Impl {
    fn OnDefaultDeviceChanged(
        &self,
        flow: Audio::EDataFlow,
        role: Audio::ERole,
        _pwstrdefaultdeviceid: &windows::core::PCWSTR,
    ) -> windows::core::Result<()> {
        if flow == self.flow && role == Audio::eConsole {
            self.signal.notify();
        }
        Ok(())
    }

    fn OnDeviceStateChanged(
        &self,
        _pwstrdeviceid: &windows::core::PCWSTR,
        dwnewstate: Audio::DEVICE_STATE,
    ) -> windows::core::Result<()> {
        // `DEVICE_STATE_UNPLUGGED`: physical jack disconnected; endpoint still exists in the
        // collection but produces no audio. `OnDeviceRemoved` does *not* fire for this state.
        // `DEVICE_STATE_NOTPRESENT`: hardware absent; endpoint may persist as a ghost record.
        // `DEVICE_STATE_DISABLED`: device was manually disabled by the user.
        //
        // Only signal when there is no replacement default; if one exists `OnDefaultDeviceChanged`
        // will fire instead, avoiding a double wakeup.
        let is_unavailable = dwnewstate == Audio::DEVICE_STATE_DISABLED
            || dwnewstate == Audio::DEVICE_STATE_NOTPRESENT
            || dwnewstate == Audio::DEVICE_STATE_UNPLUGGED;
        if is_unavailable && get_current_default(self.flow).is_none() {
            self.signal.notify();
        }
        Ok(())
    }

    fn OnDeviceAdded(&self, _pwstrdeviceid: &windows::core::PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnDeviceRemoved(&self, _pwstrdeviceid: &windows::core::PCWSTR) -> windows::core::Result<()> {
        // Only signal when there is no replacement default; if one exists `OnDefaultDeviceChanged`
        // will fire instead, avoiding a double wakeup.
        if get_current_default(self.flow).is_none() {
            self.signal.notify();
        }
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _pwstrdeviceid: &windows::core::PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SpecificEndpointNotification {
    StateChanged(Audio::DEVICE_STATE),
    Removed,
}

fn is_endpoint_unavailable_state(state: Audio::DEVICE_STATE) -> bool {
    state == Audio::DEVICE_STATE_DISABLED
        || state == Audio::DEVICE_STATE_NOTPRESENT
        || state == Audio::DEVICE_STATE_UNPLUGGED
}

fn specific_endpoint_became_unavailable(
    selected_endpoint_id: &str,
    notified_endpoint_id: &str,
    notification: SpecificEndpointNotification,
) -> bool {
    if !selected_endpoint_id.eq_ignore_ascii_case(notified_endpoint_id) {
        return false;
    }
    match notification {
        SpecificEndpointNotification::StateChanged(state) => is_endpoint_unavailable_state(state),
        SpecificEndpointNotification::Removed => true,
    }
}

#[windows::core::implement(Audio::IMMNotificationClient)]
struct SpecificDeviceNotificationImpl {
    endpoint_id: String,
    signal: Arc<NotificationSignal>,
    unavailable_notified: AtomicBool,
}

impl SpecificDeviceNotificationImpl {
    fn notify_if_unavailable(
        &self,
        notified_endpoint_id: &windows::core::PCWSTR,
        notification: SpecificEndpointNotification,
    ) {
        let Ok(notified_endpoint_id) = (unsafe { notified_endpoint_id.to_string() }) else {
            return;
        };
        if specific_endpoint_became_unavailable(
            &self.endpoint_id,
            &notified_endpoint_id,
            notification,
        ) && !self.unavailable_notified.swap(true, Ordering::AcqRel)
        {
            self.signal.notify();
        }
    }
}

impl Audio::IMMNotificationClient_Impl for SpecificDeviceNotificationImpl_Impl {
    fn OnDefaultDeviceChanged(
        &self,
        _flow: Audio::EDataFlow,
        _role: Audio::ERole,
        _pwstrdefaultdeviceid: &windows::core::PCWSTR,
    ) -> windows::core::Result<()> {
        // A stream explicitly bound to an endpoint never follows the default.
        Ok(())
    }

    fn OnDeviceStateChanged(
        &self,
        pwstrdeviceid: &windows::core::PCWSTR,
        dwnewstate: Audio::DEVICE_STATE,
    ) -> windows::core::Result<()> {
        self.notify_if_unavailable(
            pwstrdeviceid,
            SpecificEndpointNotification::StateChanged(dwnewstate),
        );
        Ok(())
    }

    fn OnDeviceAdded(&self, _pwstrdeviceid: &windows::core::PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnDeviceRemoved(&self, pwstrdeviceid: &windows::core::PCWSTR) -> windows::core::Result<()> {
        self.notify_if_unavailable(pwstrdeviceid, SpecificEndpointNotification::Removed);
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _pwstrdeviceid: &windows::core::PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

pub struct Stream {
    /// The high-priority audio processing thread calling callbacks.
    /// Option used for moving out in destructor.
    ///
    /// TODO: Actually set the thread priority.
    thread: Option<JoinHandle<()>>,

    // Commands processed by the `run()` method that is currently running.
    // `pending_scheduled_event` must be signalled whenever a command is added here, so that it
    // will get picked up.
    commands: Sender<Command>,

    // This event is signalled after a new entry is added to `commands`, so that the `run()`
    // method can be notified.
    pending_scheduled_event: Foundation::HANDLE,

    // Callback size in frames.
    period_frames: FrameCount,

    // QueryPerformanceFrequency result, cached at construction (constant for the system lifetime).
    qpc_frequency: u64,

    // Latch that ensures no callbacks fire before the caller receives the `Stream` handle.
    latch: Latch,
}

// SAFETY: Windows Event HANDLEs are safe to send between threads - they are designed for
// synchronization. All fields of Stream are Send:
// - JoinHandle<()> is Send
// - Sender<Command> is Send
// - Foundation::HANDLE is Send (Windows synchronization primitive)
// - Latch is Send
// See: https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createeventa
unsafe impl Send for Stream {}

// SAFETY: Windows Event HANDLEs are safe to access from multiple threads simultaneously.
// All synchronization operations (SetEvent, WaitForSingleObject) are thread-safe.
// All fields of Stream are Sync:
// - JoinHandle<()> is Sync
// - Sender<Command> is Sync (uses internal synchronization)
// - Foundation::HANDLE for event objects supports concurrent access
// - Latch is Sync
// The audio thread owns all COM objects, so no cross-thread COM access occurs.
unsafe impl Sync for Stream {}

// Compile-time assertion that Stream is Send and Sync
crate::assert_stream_send!(Stream);
crate::assert_stream_sync!(Stream);

struct RunContext {
    // Streams that have been created in this event loop.
    stream: StreamInner,

    // Handles corresponding to the `event` field of each element of `voices`. Must always be in
    // sync with `voices`, except that the first element is always `pending_scheduled_event`.
    handles: Vec<Foundation::HANDLE>,

    commands: Receiver<Command>,

    // Owned by the run loop so dropping a Stream from its own error callback
    // cannot close a notification HANDLE that this thread may still inspect.
    device_monitor: Option<DeviceMonitor>,

    // Owned here so the worker thread closes it on exit in a self-join case.
    pending_scheduled_event: Foundation::HANDLE,
}

impl Drop for RunContext {
    fn drop(&mut self) {
        unsafe {
            let _ = Foundation::CloseHandle(self.pending_scheduled_event);
        }
    }
}

// Once we start running the eventloop, the RunContext will not be moved.
unsafe impl Send for RunContext {}

pub enum Command {
    PlayStream,
    PauseStream,
    Terminate,
}

pub enum AudioClientFlow {
    Render {
        render_client: Audio::IAudioRenderClient,
    },
    Capture {
        capture_client: Audio::IAudioCaptureClient,
    },
}

pub struct StreamInner {
    pub audio_client: Audio::IAudioClient,
    pub audio_clock: Audio::IAudioClock,
    pub client_flow: AudioClientFlow,
    // Event that is signalled by WASAPI whenever audio data must be written.
    pub event: Foundation::HANDLE,
    // True if the stream is currently playing. False if paused.
    pub playing: bool,
    // Number of frames of audio data in the underlying buffer allocated by WASAPI.
    pub max_frames_in_buffer: FrameCount,
    // Callback size in frames.
    pub period_frames: FrameCount,
    // Number of bytes that each frame occupies.
    pub bytes_per_frame: u16,
    // The configuration with which the stream was created.
    pub config: StreamConfig,
    // The sample format with which the stream was created.
    pub sample_format: SampleFormat,
    // Hardware pipeline latency.
    pub stream_latency: Duration,
}

impl Stream {
    pub(crate) fn new_input<D>(
        stream_inner: StreamInner,
        mut data_callback: D,
        error_callback: ErrorCallbackArc,
        device_monitor: Option<DeviceMonitor>,
    ) -> Result<Stream, Error>
    where
        D: FnMut(&Data, &InputCallbackInfo) + Send + 'static,
    {
        let pending_scheduled_event = unsafe {
            Threading::CreateEventA(None, false, false, windows::core::PCSTR(ptr::null()))
        }
        .expect("cpal: could not create input stream event");
        let (tx, rx) = channel();

        let period_frames = stream_inner.period_frames;
        let mut qpc_frequency: i64 = 0;
        unsafe {
            Performance::QueryPerformanceFrequency(&mut qpc_frequency)
                .expect("QueryPerformanceFrequency failed");
            debug_assert_ne!(qpc_frequency, 0, "QueryPerformanceFrequency returned zero");
        }

        let mut handles = vec![pending_scheduled_event, stream_inner.event];
        if let Some(ref monitor) = device_monitor {
            handles.push(monitor.event());
        }

        let run_context = RunContext {
            handles,
            stream: stream_inner,
            commands: rx,
            device_monitor,
            pending_scheduled_event,
        };

        // The latch is released just before the `Stream` is returned so the worker cannot fire any
        // callbacks before the caller has the handle.
        let mut latch = Latch::new();
        let waiter = latch.waiter();

        let thread = thread::Builder::new()
            .name("cpal_wasapi_in".to_owned())
            .spawn(move || {
                waiter.wait();
                run_input(run_context, &mut data_callback, &error_callback)
            })
            .map_err(|e| {
                Error::with_message(
                    ErrorKind::ResourceExhausted,
                    format!("Failed to create audio thread: {e}"),
                )
            })?;

        latch.add_thread(thread.thread().clone());
        let stream = Stream {
            thread: Some(thread),
            commands: tx,
            pending_scheduled_event,
            period_frames,
            qpc_frequency: qpc_frequency as u64,
            latch,
        };
        Ok(stream)
    }

    pub(crate) fn new_output<D>(
        stream_inner: StreamInner,
        mut data_callback: D,
        error_callback: ErrorCallbackArc,
        device_monitor: Option<DeviceMonitor>,
    ) -> Result<Stream, Error>
    where
        D: FnMut(&mut Data, &OutputCallbackInfo) + Send + 'static,
    {
        let pending_scheduled_event = unsafe {
            Threading::CreateEventA(None, false, false, windows::core::PCSTR(ptr::null()))
        }
        .expect("cpal: could not create output stream event");
        let (tx, rx) = channel();

        let period_frames = stream_inner.period_frames;
        let mut qpc_frequency: i64 = 0;
        unsafe {
            Performance::QueryPerformanceFrequency(&mut qpc_frequency)
                .expect("QueryPerformanceFrequency failed");
            debug_assert_ne!(qpc_frequency, 0, "QueryPerformanceFrequency returned zero");
        }

        let mut handles = vec![pending_scheduled_event, stream_inner.event];
        if let Some(ref monitor) = device_monitor {
            handles.push(monitor.event());
        }

        let run_context = RunContext {
            handles,
            stream: stream_inner,
            commands: rx,
            device_monitor,
            pending_scheduled_event,
        };

        // The latch is released just before the `Stream` is returned so the worker cannot fire any
        // callbacks before the caller has the handle.
        let mut latch = Latch::new();
        let waiter = latch.waiter();

        let thread = thread::Builder::new()
            .name("cpal_wasapi_out".to_owned())
            .spawn(move || {
                waiter.wait();
                run_output(run_context, &mut data_callback, &error_callback)
            })
            .map_err(|e| {
                Error::with_message(
                    ErrorKind::ResourceExhausted,
                    format!("Failed to create audio thread: {e}"),
                )
            })?;

        latch.add_thread(thread.thread().clone());
        let stream = Stream {
            thread: Some(thread),
            commands: tx,
            pending_scheduled_event,
            period_frames,
            qpc_frequency: qpc_frequency as u64,
            latch,
        };
        Ok(stream)
    }

    /// Releases the latch so the worker thread can begin processing audio callbacks.
    pub(crate) fn signal_ready(&self) {
        self.latch.release();
    }

    fn push_command(&self, command: Command) -> Result<(), SendError<Command>> {
        self.commands.send(command)?;
        unsafe {
            Threading::SetEvent(self.pending_scheduled_event).unwrap();
        }
        Ok(())
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        // Release the latch in case the stream is dropped before signal_ready() was called.
        self.signal_ready();

        let _ = self.push_command(Command::Terminate);
        if let Some(handle) = self.thread.take() {
            // Prevent self-join: Terminate was sent; the thread exits after the current callback
            // returns. pending_scheduled_event is closed by RunContext::drop on the worker thread,
            // covering both the self-join case (where we cannot join here) and the normal case
            // (where the thread exits and drops RunContext before join() returns).
            if handle.thread().id() != std::thread::current().id() {
                let _ = handle.join();
            }
        }
    }
}

impl StreamTrait for Stream {
    fn play(&self) -> Result<(), Error> {
        self.push_command(Command::PlayStream).map_err(|_| {
            Error::with_message(
                ErrorKind::StreamInvalidated,
                "Stream command channel closed",
            )
        })?;
        Ok(())
    }

    fn pause(&self) -> Result<(), Error> {
        self.push_command(Command::PauseStream).map_err(|_| {
            Error::with_message(
                ErrorKind::StreamInvalidated,
                "Stream command channel closed",
            )
        })?;
        Ok(())
    }

    fn now(&self) -> StreamInstant {
        let mut counter: i64 = 0;
        unsafe {
            Performance::QueryPerformanceCounter(&mut counter)
                .expect("QueryPerformanceCounter failed");
        }
        // Convert to 100-nanosecond units first, matching the precision of WASAPI QPCPosition
        // values delivered to callbacks. This keeps `now()` on the same 100 ns grid as
        // callback/capture/playback instants, avoiding false sub-100 ns deltas.
        let units_100ns = counter as u128 * 10_000_000 / self.qpc_frequency as u128;
        let nanos = units_100ns * 100;
        StreamInstant::new(
            (nanos / 1_000_000_000) as u64,
            (nanos % 1_000_000_000) as u32,
        )
    }

    fn buffer_size(&self) -> Result<FrameCount, Error> {
        Ok(self.period_frames)
    }
}

impl Drop for StreamInner {
    fn drop(&mut self) {
        unsafe {
            let _ = Foundation::CloseHandle(self.event);
        }
    }
}

// Process any pending commands that are queued within the `RunContext`.
// Returns `true` if the loop should continue running, `false` if it should terminate.
fn process_commands(run_context: &mut RunContext) -> Result<bool, Error> {
    // Process the pending commands.
    for command in run_context.commands.try_iter() {
        match command {
            Command::PlayStream => unsafe {
                if !run_context.stream.playing {
                    run_context
                        .stream
                        .audio_client
                        .Start()
                        .context("Failed to start audio client")?;
                    run_context.stream.playing = true;
                }
            },
            Command::PauseStream => unsafe {
                if run_context.stream.playing {
                    run_context
                        .stream
                        .audio_client
                        .Stop()
                        .context("Failed to stop audio client")?;
                    run_context.stream.playing = false;
                }
            },
            Command::Terminate => {
                return Ok(false);
            }
        }
    }

    Ok(true)
}
// Wait for any of the given handles to be signalled.
//
// Returns the index of the `handle` that was signalled, or an `Err` if
// `WaitForMultipleObjectsEx` fails.
//
// This is called when the `run` thread is ready to wait for the next event. The
// next event might be some command submitted by the user (the first handle) or
// might indicate that one of the streams is ready to deliver or receive audio.
fn wait_for_handle_signal(handles: &[Foundation::HANDLE]) -> Result<usize, Error> {
    debug_assert!(handles.len() <= SystemServices::MAXIMUM_WAIT_OBJECTS as usize);
    let result = unsafe {
        Threading::WaitForMultipleObjectsEx(
            handles,
            false,               // Don't wait for all, just wait for the first
            Threading::INFINITE, // TODO: allow setting a timeout
            false,               // irrelevant parameter here
        )
    };
    if result == Foundation::WAIT_FAILED {
        return Err(Error::with_message(
            ErrorKind::StreamInvalidated,
            "Failed to wait for audio event",
        ));
    }
    // Notifying the corresponding task handler.
    let handle_idx = (result.0 - WAIT_OBJECT_0.0) as usize;
    Ok(handle_idx)
}

// Get the number of available frames that are available for writing/reading.
#[inline]
fn get_available_frames(stream: &StreamInner) -> Result<FrameCount, Error> {
    unsafe {
        let padding = stream
            .audio_client
            .GetCurrentPadding()
            .context("Failed to get current padding")?;
        Ok(stream.max_frames_in_buffer - padding)
    }
}

fn run_input(
    mut run_ctxt: RunContext,
    data_callback: &mut dyn FnMut(&Data, &InputCallbackInfo),
    error_callback: &ErrorCallbackArc,
) {
    #[cfg(feature = "realtime")]
    if let Err(err) = boost_current_thread_priority(
        run_ctxt.stream.period_frames,
        run_ctxt.stream.config.sample_rate,
    ) {
        emit_error(error_callback, err);
    }

    // WASAPI may represent a silent capture packet with no usable data
    // pointer. Keep one aligned scratch allocation for those packets and reuse
    // it for the lifetime of the input thread.
    let mut silent_buffer = Vec::<u64>::new();
    let mut first_packet_seen = false;
    let mut previous_capture_packet = None;
    loop {
        match process_commands_and_await_signal(&mut run_ctxt, error_callback) {
            ControlFlow::Break(()) => break,
            ControlFlow::Continue(false) => continue,
            ControlFlow::Continue(true) => {}
        }
        let capture_client = match run_ctxt.stream.client_flow {
            AudioClientFlow::Capture { ref capture_client } => capture_client.clone(),
            _ => unreachable!(),
        };
        if let Err(err) = process_input(
            &run_ctxt.stream,
            capture_client,
            data_callback,
            &mut silent_buffer,
            &mut first_packet_seen,
            &mut previous_capture_packet,
        ) {
            emit_error(error_callback, err);
            break;
        }
    }
}

fn prepare_silent_capture_buffer(
    storage: &mut Vec<u64>,
    byte_count: usize,
    sample_format: SampleFormat,
) -> *mut () {
    let words = byte_count.div_ceil(mem::size_of::<u64>());
    storage.resize(words, 0);
    // A `Vec<u64>` provides sufficient alignment for every WASAPI sample type
    // supported by this backend, including f64/i64 and CPAL's i32-backed I24.
    let bytes =
        unsafe { std::slice::from_raw_parts_mut(storage.as_mut_ptr().cast::<u8>(), byte_count) };
    fill_equilibrium(bytes, sample_format);
    storage.as_mut_ptr().cast::<()>()
}

fn run_output(
    mut run_ctxt: RunContext,
    data_callback: &mut dyn FnMut(&mut Data, &OutputCallbackInfo),
    error_callback: &ErrorCallbackArc,
) {
    #[cfg(feature = "realtime")]
    if let Err(err) = boost_current_thread_priority(
        run_ctxt.stream.period_frames,
        run_ctxt.stream.config.sample_rate,
    ) {
        emit_error(error_callback, err);
    }

    loop {
        match process_commands_and_await_signal(&mut run_ctxt, error_callback) {
            ControlFlow::Break(()) => break,
            ControlFlow::Continue(false) => continue,
            ControlFlow::Continue(true) => {}
        }
        let render_client = match run_ctxt.stream.client_flow {
            AudioClientFlow::Render { ref render_client } => render_client.clone(),
            _ => unreachable!(),
        };
        if let Err(err) = process_output(&run_ctxt.stream, render_client, data_callback) {
            emit_error(error_callback, err);
            break;
        }
    }
}

/// Attempts to elevate the current thread to real-time or high-priority scheduling.
#[cfg(feature = "realtime")]
fn boost_current_thread_priority(
    period_frames: FrameCount,
    sample_rate: SampleRate,
) -> Result<(), Error> {
    match audio_thread_priority::promote_current_thread_to_real_time(period_frames, sample_rate) {
        Ok(_) => Ok(()),
        Err(_) => unsafe {
            let thread_handle = Threading::GetCurrentThread();
            Threading::SetThreadPriority(thread_handle, Threading::THREAD_PRIORITY_TIME_CRITICAL)
                .context("Failed to promote audio thread to real-time priority")
        },
    }
}

fn process_commands_and_await_signal(
    run_context: &mut RunContext,
    error_callback: &ErrorCallbackArc,
) -> ControlFlow<(), bool> {
    // Process queued commands.
    match process_commands(run_context) {
        Ok(true) => (),
        Ok(false) => return ControlFlow::Break(()),
        Err(err) => {
            emit_error(error_callback, err);
            return ControlFlow::Break(());
        }
    };

    if let Some(ref monitor) = run_context.device_monitor {
        if monitor.take_pending_after_set_failure() {
            let event = monitor.event_kind;
            emit_error(error_callback, event.error());
            if event.is_terminal() {
                return ControlFlow::Break(());
            }
        }
    }

    // Wait for any of the handles to be signalled.
    let handle_idx = match wait_for_handle_signal(&run_context.handles) {
        Ok(idx) => idx,
        Err(err) => {
            emit_error(error_callback, err);
            return ControlFlow::Break(());
        }
    };

    // Handle layout: 0 = pending_scheduled_event (commands), 1 = WASAPI audio event,
    // 2+ = endpoint-monitor event (at most one per stream).
    // Continue(true)  = audio event fired, proceed to process audio this iteration.
    // Continue(false) = command or device-change event, loop around and wait again.
    if handle_idx >= 2 {
        let event = run_context
            .device_monitor
            .as_ref()
            .expect("notification handle without its device monitor")
            .event_kind;
        emit_error(error_callback, event.error());
        if event.is_terminal() {
            return ControlFlow::Break(());
        }
        return ControlFlow::Continue(false);
    }
    ControlFlow::Continue(handle_idx != 0)
}

// The loop for processing pending input data.
fn process_input(
    stream: &StreamInner,
    capture_client: Audio::IAudioCaptureClient,
    data_callback: &mut dyn FnMut(&Data, &InputCallbackInfo),
    silent_buffer: &mut Vec<u64>,
    first_packet_seen: &mut bool,
    previous_capture_packet: &mut Option<(u64, FrameCount)>,
) -> Result<(), Error> {
    unsafe {
        // Get the available data in the shared buffer.
        let mut buffer: *mut u8 = ptr::null_mut();
        let mut flags = mem::MaybeUninit::uninit();
        loop {
            let mut frames_available = match capture_client.GetNextPacketSize() {
                Ok(0) => return Ok(()),
                Ok(f) => f,
                Err(err) => return Err(Error::from(err)),
            };
            let mut qpc_position: u64 = 0;
            let mut device_position: u64 = 0;
            let result = capture_client.GetBuffer(
                &mut buffer,
                &mut frames_available,
                flags.as_mut_ptr(),
                Some(&mut device_position),
                Some(&mut qpc_position),
            );

            match result {
                // TODO: Can this happen?
                Err(e) if e.code() == Audio::AUDCLNT_S_BUFFER_EMPTY => continue,
                Err(e) => return Err(Error::from(e)),
                Ok(_) => (),
            }

            let flags = flags.assume_init();
            // Windows documents the discontinuity flag as unreliable on the
            // first capture packet. Track the actual first successful GetBuffer
            // instead of guessing from device_position: an endpoint clock can
            // already be non-zero on startup and can later reset to zero after
            // a real glitch.
            let driver_discontinuity =
                capture_packet_has_reportable_discontinuity(first_packet_seen, flags);

            // `DATA_DISCONTINUITY` is a useful but driver-reported signal.
            // Check the stream-relative positions as well so a capture gap
            // that is shorter than the engine's stalled-input timeout cannot
            // be silently accepted when a driver omits that flag. The first
            // packet has no predecessor, and therefore establishes the
            // baseline regardless of its initial device position.
            let unflagged_position_discontinuity =
                capture_packet_has_unflagged_position_discontinuity(
                    previous_capture_packet,
                    flags,
                    device_position,
                    frames_available,
                );
            if driver_discontinuity || unflagged_position_discontinuity {
                // A successful GetBuffer must be paired with ReleaseBuffer
                // before leaving this iteration. This error is returned to
                // the run loop (rather than best-effort emitted here), which
                // guarantees delivery through the stream error callback and
                // ends this WASAPI input worker.
                let message = if driver_discontinuity {
                    "WASAPI capture packet has DATA_DISCONTINUITY"
                } else {
                    "WASAPI capture device position jumped without DATA_DISCONTINUITY"
                };
                capture_client
                    .ReleaseBuffer(frames_available)
                    .map_err(|release_error| {
                        Error::with_message(
                            ErrorKind::Xrun,
                            format!(
                                "{message}; additionally failed to release capture buffer: {release_error}"
                            ),
                        )
                    })?;
                return Err(Error::with_message(ErrorKind::Xrun, message));
            }

            let byte_count = frames_available as usize * stream.bytes_per_frame as usize;
            let sample_size = stream.sample_format.sample_size();
            debug_assert_eq!(byte_count % sample_size, 0);
            let len = byte_count / sample_size;
            let data = if flags & Audio::AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                // Microsoft requires clients to ignore the packet's actual
                // bytes when SILENT is set. The pointer may be null, and even a
                // non-null buffer does not contain values that may be captured.
                prepare_silent_capture_buffer(silent_buffer, byte_count, stream.sample_format)
            } else if buffer.is_null() {
                // Never construct CPAL Data from a null non-empty pointer: its
                // typed callback wrapper creates a Rust slice immediately.
                capture_client
                    .ReleaseBuffer(frames_available)
                    .context("Failed to release invalid capture buffer")?;
                return Err(Error::with_message(
                    ErrorKind::BackendError,
                    "WASAPI returned a null capture buffer without the SILENT flag",
                ));
            } else {
                buffer.cast::<()>()
            };
            let data = Data::from_parts(data, len, stream.sample_format);

            // The `qpc_position` is in 100 nanosecond units. Convert it to nanoseconds.
            let timestamp = input_timestamp(stream, qpc_position)?;
            let info = InputCallbackInfo { timestamp };
            data_callback(&data, &info);

            // Release the buffer.
            capture_client
                .ReleaseBuffer(frames_available)
                .context("Failed to release capture buffer")?;
        }
    }
}

fn capture_packet_has_reportable_discontinuity(first_packet_seen: &mut bool, flags: u32) -> bool {
    let is_first_packet = !*first_packet_seen;
    *first_packet_seen = true;
    !is_first_packet && capture_packet_has_data_discontinuity(flags)
}

fn capture_packet_has_data_discontinuity(flags: u32) -> bool {
    flags & Audio::AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0
}

/// Returns whether the current capture packet fails to follow the preceding packet.
///
/// `IAudioCaptureClient::GetBuffer` reports the stream-relative device position
/// of the first frame in each packet. Consecutive packets must therefore begin
/// exactly after the previous packet's frame count. Treat a checked-add overflow
/// as discontinuous too: losing the baseline would make the check fail-open.
fn capture_packet_has_position_discontinuity(
    previous_packet: &mut Option<(u64, FrameCount)>,
    device_position: u64,
    frames_available: FrameCount,
) -> bool {
    let discontinuity = previous_packet.is_some_and(|(previous_position, previous_frames)| {
        previous_position.checked_add(previous_frames as u64) != Some(device_position)
    });
    *previous_packet = Some((device_position, frames_available));
    discontinuity
}

/// A driver-reported discontinuity is handled as its own terminal error. A
/// timestamp error only says that the instant at which the device position was
/// recorded is uncertain; it does not make the stream-relative frame position
/// unusable for this adjacency check. Keep checking it so that flag cannot
/// mask an unreported capture gap.
fn capture_packet_has_unflagged_position_discontinuity(
    previous_packet: &mut Option<(u64, FrameCount)>,
    flags: u32,
    device_position: u64,
    frames_available: FrameCount,
) -> bool {
    capture_packet_has_position_discontinuity(previous_packet, device_position, frames_available)
        && !capture_packet_has_data_discontinuity(flags)
}

// The loop for writing output data.
fn process_output(
    stream: &StreamInner,
    render_client: Audio::IAudioRenderClient,
    data_callback: &mut dyn FnMut(&mut Data, &OutputCallbackInfo),
) -> Result<(), Error> {
    // The number of frames available for writing.
    let frames_available = match get_available_frames(stream)? {
        0 => return Ok(()), // TODO: Can this happen?
        n => n,
    };

    unsafe {
        let buffer = render_client
            .GetBuffer(frames_available)
            .map_err(Error::from)?;

        debug_assert!(!buffer.is_null());

        let byte_count = frames_available as usize * stream.bytes_per_frame as usize;
        let buffer_slice = std::slice::from_raw_parts_mut(buffer, byte_count);
        fill_equilibrium(buffer_slice, stream.sample_format);

        let data = buffer as *mut ();
        let len = byte_count / stream.sample_format.sample_size();
        let mut data = Data::from_parts(data, len, stream.sample_format);
        let sample_rate = stream.config.sample_rate;
        let timestamp = output_timestamp(stream, frames_available, sample_rate)?;
        let info = OutputCallbackInfo { timestamp };
        data_callback(&mut data, &info);

        render_client
            .ReleaseBuffer(frames_available, 0)
            .map_err(Error::from)?;
    }

    Ok(())
}

/// Use the stream's `IAudioClock` to produce the current stream instant.
///
/// Uses the QPC position produced via the `GetPosition` method.
#[inline]
fn stream_instant(stream: &StreamInner) -> Result<StreamInstant, Error> {
    let mut position: u64 = 0;
    let mut qpc_position: u64 = 0;
    unsafe {
        stream
            .audio_clock
            .GetPosition(&mut position, Some(&mut qpc_position))
            .context("Failed to get clock position")?;
    };
    // The `qpc_position` is in 100-nanosecond units.
    let nanos = qpc_position as u128 * 100;
    let instant = StreamInstant::new(
        (nanos / 1_000_000_000) as u64,
        (nanos % 1_000_000_000) as u32,
    );
    Ok(instant)
}

/// Produce the input stream timestamp.
///
/// `buffer_qpc_position` is the `qpc_position` returned via the `GetBuffer` call on the capture
/// client. It represents the instant at which the first sample of the retrieved buffer was
/// captured.
#[inline]
fn input_timestamp(
    stream: &StreamInner,
    buffer_qpc_position: u64,
) -> Result<InputStreamTimestamp, Error> {
    // The `qpc_position` is in 100-nanosecond units.
    let nanos = buffer_qpc_position as u128 * 100;
    let capture = StreamInstant::new(
        (nanos / 1_000_000_000) as u64,
        (nanos % 1_000_000_000) as u32,
    );
    let callback = stream_instant(stream)?;
    Ok(InputStreamTimestamp { capture, callback })
}

/// Produce the output stream timestamp.
///
/// `frames_available` is the number of frames available for writing as reported by subtracting the
/// result of `GetCurrentPadding` from the maximum buffer size.
///
/// `sample_rate` is the rate at which audio frames are processed by the device.
#[inline]
fn output_timestamp(
    stream: &StreamInner,
    frames_available: FrameCount,
    sample_rate: SampleRate,
) -> Result<OutputStreamTimestamp, Error> {
    let callback = stream_instant(stream)?;
    // `padding` is the number of frames already queued in the endpoint buffer ahead of the
    // frames we are about to write. Those frames must drain before ours are heard.
    let padding = stream.max_frames_in_buffer - frames_available;
    let playback = callback + (frames_to_duration(padding, sample_rate) + stream.stream_latency);
    Ok(OutputStreamTimestamp { callback, playback })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SELECTED_ENDPOINT: &str = "{0.0.1.00000000}.{ABCDEF01-2345-6789-ABCD-EF0123456789}";

    #[test]
    fn specific_endpoint_unavailable_states_match_only_the_selected_id() {
        for state in [
            Audio::DEVICE_STATE_DISABLED,
            Audio::DEVICE_STATE_NOTPRESENT,
            Audio::DEVICE_STATE_UNPLUGGED,
        ] {
            assert!(specific_endpoint_became_unavailable(
                SELECTED_ENDPOINT,
                SELECTED_ENDPOINT,
                SpecificEndpointNotification::StateChanged(state),
            ));
            assert!(specific_endpoint_became_unavailable(
                SELECTED_ENDPOINT,
                &SELECTED_ENDPOINT.to_ascii_lowercase(),
                SpecificEndpointNotification::StateChanged(state),
            ));
        }

        assert!(!specific_endpoint_became_unavailable(
            SELECTED_ENDPOINT,
            "{0.0.1.00000000}.{00000000-0000-0000-0000-000000000000}",
            SpecificEndpointNotification::StateChanged(Audio::DEVICE_STATE_UNPLUGGED),
        ));
        assert!(!specific_endpoint_became_unavailable(
            SELECTED_ENDPOINT,
            SELECTED_ENDPOINT,
            SpecificEndpointNotification::StateChanged(Audio::DEVICE_STATE_ACTIVE),
        ));
    }

    #[test]
    fn specific_endpoint_removed_matches_only_the_selected_id() {
        assert!(specific_endpoint_became_unavailable(
            SELECTED_ENDPOINT,
            SELECTED_ENDPOINT,
            SpecificEndpointNotification::Removed,
        ));
        assert!(!specific_endpoint_became_unavailable(
            SELECTED_ENDPOINT,
            "another-endpoint",
            SpecificEndpointNotification::Removed,
        ));
    }

    #[test]
    fn specific_device_loss_is_terminal_but_default_change_is_not() {
        assert!(DeviceMonitorEvent::SpecificDeviceUnavailable.is_terminal());
        assert!(!DeviceMonitorEvent::DefaultDeviceChanged.is_terminal());
        assert_eq!(
            DeviceMonitorEvent::SpecificDeviceUnavailable.error().kind(),
            ErrorKind::DeviceNotAvailable,
        );
        assert_eq!(
            DeviceMonitorEvent::DefaultDeviceChanged.error().kind(),
            ErrorKind::DeviceChanged,
        );
    }

    #[test]
    fn notification_unregister_result_releases_only_known_safe_outcomes() {
        let success = Ok(());
        assert_eq!(
            classify_notification_unregister(&success),
            NotificationUnregisterOutcome::Unregistered,
        );

        let already_absent = Err(windows::core::Error::from_hresult(
            ENDPOINT_NOTIFICATION_E_NOTFOUND,
        ));
        assert_eq!(
            classify_notification_unregister(&already_absent),
            NotificationUnregisterOutcome::AlreadyAbsent,
        );

        let unknown_failure = Err(windows::core::Error::from_hresult(windows::core::HRESULT(
            0x8000_4005_u32 as i32,
        )));
        assert_eq!(
            classify_notification_unregister(&unknown_failure),
            NotificationUnregisterOutcome::IndeterminateFailure,
        );
    }

    #[test]
    fn silent_capture_buffer_is_aligned_and_uses_sample_equilibrium() {
        let mut storage = Vec::<u64>::new();

        let pointer = prepare_silent_capture_buffer(&mut storage, 7, SampleFormat::U8);
        assert_eq!((pointer as usize) % mem::align_of::<u64>(), 0);
        let data = unsafe { Data::from_parts(pointer, 7, SampleFormat::U8) };
        assert_eq!(data.as_slice::<u8>().unwrap(), &[0x80; 7]);

        let pointer = prepare_silent_capture_buffer(
            &mut storage,
            4 * mem::size_of::<i16>(),
            SampleFormat::I16,
        );
        let data = unsafe { Data::from_parts(pointer, 4, SampleFormat::I16) };
        assert_eq!(data.as_slice::<i16>().unwrap(), &[0; 4]);

        let pointer = prepare_silent_capture_buffer(
            &mut storage,
            3 * mem::size_of::<f64>(),
            SampleFormat::F64,
        );
        let data = unsafe { Data::from_parts(pointer, 3, SampleFormat::F64) };
        assert_eq!(data.as_slice::<f64>().unwrap(), &[0.0; 3]);
    }

    #[test]
    fn capture_discontinuity_ignores_only_the_actual_first_packet() {
        let discontinuity = Audio::AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32;
        let mut first_packet_seen = false;

        assert!(!capture_packet_has_reportable_discontinuity(
            &mut first_packet_seen,
            discontinuity,
        ));
        assert!(first_packet_seen);
        assert!(!capture_packet_has_reportable_discontinuity(
            &mut first_packet_seen,
            0,
        ));
        assert!(capture_packet_has_reportable_discontinuity(
            &mut first_packet_seen,
            discontinuity,
        ));
    }

    #[test]
    fn capture_position_discontinuity_ignores_first_packet_and_detects_short_gap() {
        let mut previous_packet = None;

        // A stream may begin at a non-zero device position.
        assert!(!capture_packet_has_position_discontinuity(
            &mut previous_packet,
            4_096,
            480,
        ));
        assert!(!capture_packet_has_position_discontinuity(
            &mut previous_packet,
            4_576,
            480,
        ));

        // At 48 kHz this is a 10 ms gap: much shorter than the engine's
        // five-second stalled-input watchdog, but still an unrecoverable gap.
        assert!(capture_packet_has_position_discontinuity(
            &mut previous_packet,
            5_536,
            480,
        ));
    }

    #[test]
    fn capture_position_discontinuity_detects_backward_jump_and_overflow() {
        let mut previous_packet = Some((1_000, 480));
        assert!(capture_packet_has_position_discontinuity(
            &mut previous_packet,
            999,
            480,
        ));

        let mut previous_packet = Some((u64::MAX - 10, 11));
        assert!(capture_packet_has_position_discontinuity(
            &mut previous_packet,
            0,
            480,
        ));
    }

    #[test]
    fn timestamp_error_does_not_mask_an_unflagged_position_gap() {
        let timestamp_error = Audio::AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32;
        let mut previous_packet = None;

        assert!(!capture_packet_has_unflagged_position_discontinuity(
            &mut previous_packet,
            timestamp_error,
            2_000,
            480,
        ));
        assert!(capture_packet_has_unflagged_position_discontinuity(
            &mut previous_packet,
            timestamp_error,
            2_960,
            480,
        ));
    }

    #[test]
    fn position_guard_defers_to_reportable_data_discontinuity() {
        let data_discontinuity = Audio::AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32;
        let mut previous_packet = Some((1_000, 480));

        assert!(!capture_packet_has_unflagged_position_discontinuity(
            &mut previous_packet,
            data_discontinuity,
            1_960,
            480,
        ));

        let mut first_packet_seen = true;
        assert!(capture_packet_has_reportable_discontinuity(
            &mut first_packet_seen,
            data_discontinuity,
        ));
    }
}
