const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const {
    actualHeadSilenceMs,
    liveSilencePair,
    peakNoteFromLevel,
    reviewSilencePair,
  } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'silence-readout.ts')).href);

  assert.equal(actualHeadSilenceMs(1_000, 1_480, 48_000), 10);
  assert.equal(actualHeadSilenceMs(1_000, 0, 48_000), null);
  assert.equal(peakNoteFromLevel(0.96), 'clip');
  assert.equal(peakNoteFromLevel(0.02), 'quiet');
  assert.equal(peakNoteFromLevel(0.4), null);

  const pendingPair = liveSilencePair({
    recording: true,
    pending: true,
    spoken: false,
    pendingRemainingMs: 600,
    requiredMs: 1_000,
    liveSilenceMs: 80,
    headMs: null,
  });
  assert.equal(pendingPair.headText, '等待 0.6 s');
  assert.equal(pendingPair.tailText, '尾 —');

  const spokenEarly = liveSilencePair({
    recording: true,
    pending: true,
    spoken: true,
    pendingRemainingMs: 400,
    requiredMs: 1_000,
    liveSilenceMs: 50,
    headMs: 120,
  });
  assert.equal(spokenEarly.headText, '首 120 ms');
  assert.equal(spokenEarly.headWarn, true);
  assert.match(spokenEarly.tailText, /尾 50 ms \/ 1000 ms/);

  const tailReady = liveSilencePair({
    recording: true,
    pending: false,
    spoken: true,
    pendingRemainingMs: 0,
    requiredMs: 1_000,
    liveSilenceMs: 1_000,
    headMs: 1_050,
  });
  assert.equal(tailReady.tailText, '尾已够 · 1000 ms');
  assert.equal(tailReady.tailMet, true);

  const bill = reviewSilencePair({
    attempt: {
      attempt_id: '001-a2',
      start_sample: 2_400_000,
      recording_started_sample: 2_400_000,
      content_started_sample: 2_409_600,
      end_sample: 2_496_000,
      tail_silence_samples: 9_600,
      required_tail_silence_samples: 48_000,
      forced_without_tail_silence: true,
      status: 'recorded',
      created_at: '2026-08-13T00:00:00Z',
    },
    sampleRate: 48_000,
    requiredMs: 1_000,
    peak: 0.3,
  });
  assert.equal(bill.headText, '首 200 ms');
  assert.equal(bill.tailText, '尾 200 ms');
  assert.equal(bill.headWarn, true);
  assert.equal(bill.tailMet, false);
  assert.match(bill.hint, /首尾都短于 1.0 s/);
  assert.equal(bill.extra, '');

  console.log('silence readout tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
