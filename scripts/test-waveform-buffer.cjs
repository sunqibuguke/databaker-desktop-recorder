const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'waveform-buffer.ts');
  const waveform = await import(pathToFileURL(modulePath).href);

  assert.equal(waveform.waveformWindowBinCount(44_100), 8_269);
  assert.equal(waveform.waveformWindowBinCount(48_000), 9_000);
  assert.equal(waveform.waveformWindowBinCount(96_000), 18_000);

  assert.equal(waveform.waveformWindowSampleCount(48_000), 576_000);
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
    assert(Math.abs(markerAtLiveEdge - (1 - 1 / 12)) < 1e-12);
    assert(Math.abs(markerAfterOneSecond - 0.75) < 1e-12);
    assert(
      Math.abs(
        (markerAtLiveEdge - markerAfterOneSecond) / 2
        - 1 / waveform.WAVEFORM_WINDOW_SECONDS,
      ) < 1e-12,
      `${sampleRate} Hz must move exactly one twelfth of the viewport per second`,
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
