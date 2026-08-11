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
    waveform.advanceWaveformPlayhead(48_000, 48_000, 100, 48_000),
    52_800,
    'the visual playhead advances at the exact PCM sample rate between packets',
  );
  assert.equal(
    waveform.advanceWaveformPlayhead(52_800, 52_800, 0, 48_000),
    52_800,
    'a newly received packet must not move the playhead backwards',
  );
  assert.equal(
    waveform.advanceWaveformPlayhead(52_800, 52_800, 2_000, 48_000),
    62_400,
    'a telemetry stall must stop visual extrapolation after 200 ms',
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
