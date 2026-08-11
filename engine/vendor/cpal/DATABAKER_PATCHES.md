# DataBaker CPAL patch set

This directory vendors CPAL 0.18.1 so Windows builds do not depend on an
unreleased Git revision or direct GitHub access.

The WASAPI input loop includes the upstream capture-xrun changes from
RustAudio/cpal pull requests #1268 and #1281. They report
`AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY` through CPAL's error callback while
ignoring the undefined flag on the first capture packet. The recorder treats
that error as a fail-closed recording fault.

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

Remove this vendor only after a released CPAL version containing both upstream
fixes, equivalent silent-packet handling, and equivalent explicit-endpoint
disconnect notification has been adopted, and the Windows hardware fault suite
passes again.
