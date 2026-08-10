# DataBaker CPAL patch set

This directory vendors CPAL 0.18.1 so Windows builds do not depend on an
unreleased Git revision or direct GitHub access.

The WASAPI input loop includes the upstream capture-xrun changes from
RustAudio/cpal pull requests #1268 and #1281. They report
`AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY` through CPAL's error callback while
ignoring the undefined flag on the first capture packet. The recorder treats
that error as a fail-closed recording fault.

Remove this vendor only after a released CPAL version containing both upstream
fixes has been adopted and the Windows hardware fault suite passes again.
