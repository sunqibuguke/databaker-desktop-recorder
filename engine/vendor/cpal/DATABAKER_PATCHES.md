# DataBaker CPAL patch set

This directory vendors CPAL 0.18.1 so Windows builds do not depend on an
unreleased Git revision or direct GitHub access.

The WASAPI input loop includes the upstream capture-xrun changes from
RustAudio/cpal pull requests #1268 and #1281. It ignores the undefined
`AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY` flag on the first capture packet.
Later flagged packets remain in the stream and emit
`ErrorKind::RecoveredXrun` quality telemetry instead of stopping capture.

The input loop also verifies that each packet's stream-relative
`device_position` starts exactly after the preceding packet. A bounded forward
jump of at most one second is filled with format-correct equilibrium samples,
reported as `ErrorKind::RecoveredXrun`, and capture continues. A larger forward
jump, backward jump, or position overflow remains a terminal `ErrorKind::Xrun`.
This keeps the master timeline aligned while making the affected range audible
and visible instead of silently closing over missing hardware data.
`AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR` means that the time at which a device
position was recorded is uncertain; it does not suppress frame-position
continuity checking, so it cannot hide an unflagged gap.
See Microsoft's packet-position and flag contracts:
https://learn.microsoft.com/windows/win32/api/audioclient/nf-audioclient-iaudiocaptureclient-getbuffer
and
https://learn.microsoft.com/windows/win32/api/audioclient/ne-audioclient-_audclnt_bufferflags

It also synthesizes format-correct equilibrium samples when WASAPI sets
`AUDCLNT_BUFFERFLAGS_SILENT`. Microsoft requires capture clients to ignore the
packet bytes in that case; the packet pointer may not be usable. Passing that
pointer through CPAL could otherwise record unspecified data or construct a
Rust slice from a null pointer. See Microsoft's `Capturing a Stream` example:
https://learn.microsoft.com/windows/win32/coreaudio/capturing-a-stream

WASAPI streams created from an explicitly enumerated endpoint also register an
`IMMNotificationClient` for that stable endpoint ID. A matching disabled,
not-present, unplugged, or removed notification is handed off to the audio run
thread as `ErrorKind::DeviceNotAvailable`; the notification thread never calls
user code and the stream never switches to another endpoint. The notification
event is reference-counted across COM callbacks and owned by the run context so
dropping a stream from its error callback cannot race a live HANDLE wait.
Because Windows does not AddRef/Release registered notification clients, an
indeterminate unregister failure deliberately retains one callback reference
(and its event) for the process lifetime; successful unregister and the
documented E_NOTFOUND result release it normally.

WASAPI can open event-driven exclusive capture. `StreamConfig.share_mode`
selects `AUDCLNT_SHAREMODE_EXCLUSIVE` and `supported_input_configs_for(true)`
probes hardware-accepted exclusive formats without treating `GetMixFormat` as a
precision upgrade. Exclusive `Initialize` uses equal buffer and periodicity
durations and retries once after `AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED`. Shared
enumeration and open paths are unchanged.

Remove this vendor only after a released CPAL version containing both upstream
fixes, equivalent silent-packet handling, and equivalent explicit-endpoint
disconnect notification has been adopted, and the Windows hardware fault suite
passes again.
