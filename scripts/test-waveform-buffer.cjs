const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'waveform-buffer.ts');
  const waveform = await import(pathToFileURL(modulePath).href);

  assert.equal(waveform.waveformWindowBinCount(44_100), 5_513);
  assert.equal(waveform.waveformWindowBinCount(48_000), 6_000);
  assert.equal(waveform.waveformWindowBinCount(96_000), 12_000);

  const latencyBins = waveform.waveformLatencyBinCount(48_000);
  assert.equal(latencyBins, 90);
  assert.equal(latencyBins * 64 / 48_000 * 1_000, 120);
  assert.equal(waveform.waveformCatchUpCount(750, 48_000), 660);
  assert(
    (750 - waveform.waveformCatchUpCount(750, 48_000)) * 64 / 48_000 * 1_000 <= 200,
    'a one-second renderer pause must catch up to within 200 ms immediately',
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
