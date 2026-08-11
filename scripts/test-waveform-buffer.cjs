const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'waveform-buffer.ts');
  const waveform = await import(pathToFileURL(modulePath).href);

  assert.equal(waveform.WAVEFORM_WINDOW_SECONDS, 20);
  assert.equal(waveform.waveformWindowBinCount(44_100), 13_782);
  assert.equal(waveform.waveformWindowBinCount(48_000), 15_000);
  assert.equal(waveform.waveformWindowBinCount(96_000), 30_000);

  assert.equal(waveform.waveformWindowSampleCount(48_000), 960_000);
  assert.equal(
    waveform.advanceWaveformPlayhead(48_000, 52_800, 50, 48_000),
    50_400,
    'the visual playhead advances at the exact PCM sample rate toward a received capture cursor',
  );
  assert.equal(
    waveform.advanceWaveformPlayhead(50_400, 52_800, 100, 48_000),
    52_800,
    'the playhead must stop at the authoritative capture cursor',
  );
  assert.equal(
    waveform.advanceWaveformPlayhead(52_800, 52_800, 2_000, 48_000),
    52_800,
    'wall time alone must never extrapolate beyond captured audio',
  );
  assert.equal(
    waveform.advanceWaveformPlayhead(48_000, 96_000, 16, 48_000),
    96_000,
    'a telemetry stall must snap to the capture cursor instead of replaying stale data quickly',
  );

  for (const sampleRate of [44_100, 48_000, 96_000, 192_000]) {
    const markerSample = sampleRate;
    const markerAtLiveEdge = waveform.waveformSampleHorizontalPosition(
      markerSample,
      markerSample,
      sampleRate,
    );
    const markerAfterOneSecond = waveform.waveformSampleHorizontalPosition(
      markerSample,
      markerSample + sampleRate,
      sampleRate,
    );
    const expectedLiveEdge = 1
      - 2 * waveform.WAVEFORM_LIVE_EDGE_GUTTER_SECONDS / waveform.WAVEFORM_WINDOW_SECONDS;
    assert(Math.abs(markerAtLiveEdge - expectedLiveEdge) < 1e-12);
    assert(
      Math.abs(markerAfterOneSecond - (expectedLiveEdge - 2 / waveform.WAVEFORM_WINDOW_SECONDS))
        < 1e-12,
    );
    assert(
      Math.abs(
        (markerAtLiveEdge - markerAfterOneSecond) / 2
        - 1 / waveform.WAVEFORM_WINDOW_SECONDS,
      ) < 1e-12,
      `${sampleRate} Hz must move exactly one window fraction per second`,
    );
  }

  // Reproduce the observable studio scenario instead of checking only the
  // isolated coordinate formula. The engine publishes about every 80 ms and
  // the renderer paints on the next animation frame. A consonant in the newest
  // packet must therefore be visible on the right within one packet + one
  // frame, rather than spending seconds in a second playback queue.
  {
    const sampleRate = 48_000;
    const packetDurationMs = 80;
    const frameDurationMs = 16;
    const helloSample = sampleRate * 2;
    const packetEndSample = helloSample + sampleRate * packetDurationMs / 1_000;
    const timelineSample = waveform.reconcileWaveformTimelineSample(
      packetEndSample,
      packetEndSample,
      helloSample,
    );
    const firstPaintPlayhead = waveform.advanceWaveformPlayhead(
      helloSample,
      timelineSample,
      frameDurationMs,
      sampleRate,
    );
    const helloPositionOnFirstPaint = waveform.waveformSampleHorizontalPosition(
      helloSample + waveform.WAVEFORM_BIN_SAMPLES / 2,
      firstPaintPlayhead,
      sampleRate,
    );
    const helloViewportRatio = (helloPositionOnFirstPaint + 1) / 2;
    assert(
      helloViewportRatio >= 0.85 && helloViewportRatio <= 0.92,
      'the newest speech packet must be clearly visible in the live lane on its first paint (<= 96 ms)',
    );
  }

  // Drive the same helpers with a deterministic 60-ish FPS clock and 80 ms
  // capture packets. After two real seconds, a marker must be about two seconds
  // old on the 20-second viewport. Allow only the current telemetry packet of
  // lag; never permit accelerated catch-up or multi-second visual latency.
  {
    const sampleRate = 48_000;
    const packetDurationMs = 80;
    const frameDurationMs = 16;
    const elapsedMs = 2_000;
    const markerSample = sampleRate * 3;
    let latestTimelineSample = markerSample;
    let playheadSample = markerSample;
    for (let now = frameDurationMs; now <= elapsedMs; now += frameDurationMs) {
      if (now % packetDurationMs === 0) {
        const receivedSample = markerSample + sampleRate * now / 1_000;
        latestTimelineSample = waveform.reconcileWaveformTimelineSample(
          receivedSample,
          receivedSample,
          latestTimelineSample,
        );
        playheadSample = waveform.advanceWaveformPlayhead(
          playheadSample,
          latestTimelineSample,
          0,
          sampleRate,
        );
      }
      playheadSample = waveform.advanceWaveformPlayhead(
        playheadSample,
        latestTimelineSample,
        frameDurationMs,
        sampleRate,
      );
    }
    const displayedMarkerAgeMs = (playheadSample - markerSample) / sampleRate * 1_000;
    assert(
      displayedMarkerAgeMs >= elapsedMs - packetDurationMs
        && displayedMarkerAgeMs <= elapsedMs,
      `two seconds of real time must move the waveform by two seconds, within one ${packetDurationMs} ms packet; got ${displayedMarkerAgeMs} ms`,
    );
    const startPosition = waveform.waveformSampleHorizontalPosition(
      markerSample,
      markerSample,
      sampleRate,
    );
    const endPosition = waveform.waveformSampleHorizontalPosition(
      markerSample,
      playheadSample,
      sampleRate,
    );
    const displayedViewportSeconds = (startPosition - endPosition) / 2
      * waveform.WAVEFORM_WINDOW_SECONDS;
    assert(
      Math.abs(displayedViewportSeconds - displayedMarkerAgeMs / 1_000) < 1e-12,
      'viewport motion must remain coupled 1:1 to the authoritative PCM clock',
    );
  }

  assert.equal(
    waveform.reconcileWaveformTimelineSample(192_000, 48_000, null),
    192_000,
    'the live capture cursor must keep a delayed waveform packet off the live edge',
  );
  assert.equal(
    waveform.reconcileWaveformTimelineSample(96_000, 192_000, null),
    96_000,
    'waveform metadata must never move the timeline beyond a valid capture watermark',
  );
  assert.equal(
    waveform.reconcileWaveformTimelineSample(96_000, 96_000, 192_000),
    192_000,
    'stale telemetry must never move the live timeline backwards',
  );
  const delayedPacketPosition = waveform.waveformSampleHorizontalPosition(
    48_000,
    waveform.reconcileWaveformTimelineSample(192_000, 48_000, null),
    48_000,
  );
  assert(
    delayedPacketPosition < 0.8,
    'a waveform packet delayed by three seconds must be drawn at its historical time, not enter from the right',
  );

  const first = waveform.reconcileWaveformBatch(['a', 'b'], 1_128, null);
  assert.deepEqual(first, { bins: ['a', 'b'], endSample: 1_128, reset: false });
  assert.deepEqual(
    waveform.reconcileWaveformBatch(['old'], 1_064, first.endSample),
    { bins: [], endSample: 1_128, reset: false },
    'stale preview packets are ignored',
  );
  assert.deepEqual(
    waveform.reconcileWaveformBatch(['b', 'c'], 1_192, first.endSample),
    { bins: ['c'], endSample: 1_192, reset: false },
    'overlapping preview packets are de-duplicated by sample endpoint',
  );
  assert.deepEqual(
    waveform.reconcileWaveformBatch(['z'], 2_064, 1_192),
    { bins: ['z'], endSample: 2_064, reset: true },
    'a dropped preview packet resets only the disposable visualization',
  );

  console.log('waveform buffer tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
