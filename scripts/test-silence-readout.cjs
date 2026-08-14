const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const {
    actualHeadSilenceMs,
    canFinishSpokenTake,
    itemSilenceMarks,
    liveSilenceProgress,
    takeStartSample,
    liveSilenceHint,
    liveSilencePair,
    peakFromWaveformBins,
    peakNoteFromLevel,
    recordedMonitorSentenceLabel,
    reviewSilencePair,
    shouldUseRecordedSilencePair,
    takeReviewPeak,
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
  assert.equal(pendingPair.headStatus, 'unknown');
  assert.equal(pendingPair.tailStatus, 'unknown');

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
  assert.equal(spokenEarly.headStatus, 'short');
  assert.equal(spokenEarly.tailStatus, 'short');
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
  assert.equal(tailReady.headStatus, 'met');
  assert.equal(tailReady.tailStatus, 'met');

  assert.equal(peakFromWaveformBins([[-0.2, 0.31], [-0.05, 0.08]]), 0.31);
  assert.equal(takeReviewPeak({ livePeak: 0.02, waveformBins: [[-0.2, 0.31]] }), 0.31);
  assert.ok(
    takeReviewPeak({ livePeak: 0.02, waveformBins: [[-0.2, 0.31]] }) >= 0.04,
    'a decaying live meter must not override the take’s true peak',
  );

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
  assert.equal(bill.headStatus, 'short');
  assert.equal(bill.tailStatus, 'short');
  assert.match(bill.hint, /首尾都短于 1.0 s/);
  assert.equal(bill.extra, '');

  const reviewHeadMetTailShort = reviewSilencePair({
    attempt: {
      attempt_id: '001-a5',
      start_sample: 0,
      recording_started_sample: 0,
      content_started_sample: 48_000,
      end_sample: 96_000,
      tail_silence_samples: 9_600,
      required_tail_silence_samples: 48_000,
      status: 'recorded',
      created_at: '2026-08-13T00:00:00Z',
    },
    sampleRate: 48_000,
    requiredMs: 1_000,
    peak: 0.3,
  });
  assert.equal(reviewHeadMetTailShort.headStatus, 'met');
  assert.equal(reviewHeadMetTailShort.tailStatus, 'short');
  assert.equal(reviewHeadMetTailShort.headWarn, false);
  assert.equal(reviewHeadMetTailShort.tailMet, false);

  const quietDecayed = reviewSilencePair({
    attempt: {
      attempt_id: '001-a3',
      start_sample: 0,
      recording_started_sample: 0,
      content_started_sample: 4_800,
      end_sample: 48_000,
      tail_silence_samples: 48_000,
      status: 'recorded',
      created_at: '2026-08-13T00:00:00Z',
    },
    sampleRate: 48_000,
    requiredMs: 1_000,
    peak: 0.02,
  });
  assert.equal(quietDecayed.extra, '', 'almost-silent is off unless the operator enables the rule');

  const quietEnabled = reviewSilencePair({
    attempt: {
      attempt_id: '001-a3',
      start_sample: 0,
      recording_started_sample: 0,
      content_started_sample: 4_800,
      end_sample: 48_000,
      tail_silence_samples: 48_000,
      status: 'recorded',
      created_at: '2026-08-13T00:00:00Z',
    },
    sampleRate: 48_000,
    requiredMs: 1_000,
    peak: 0.02,
    showAlmostSilent: true,
  });
  assert.equal(quietEnabled.extra, '几乎无声');

  const hiddenHeadTail = reviewSilencePair({
    attempt: {
      attempt_id: '001-a4',
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
    showHeadTailHints: false,
  });
  assert.equal(hiddenHeadTail.headWarn, false);
  assert.equal(hiddenHeadTail.hint, '');
  assert.equal(hiddenHeadTail.headStatus, 'short');
  assert.equal(hiddenHeadTail.tailStatus, 'short');

  const missingTail = reviewSilencePair({
    attempt: {
      attempt_id: '001-legacy',
      start_sample: 0,
      recording_started_sample: 0,
      content_started_sample: 4_800,
      end_sample: 48_000,
      status: 'recorded',
      created_at: '2026-08-13T00:00:00Z',
    },
    sampleRate: 48_000,
    requiredMs: 1_000,
  });
  assert.equal(missingTail.headStatus, 'short');
  assert.equal(missingTail.tailStatus, 'unknown');

  function scriptItem(overrides) {
    return {
      id: '001',
      text: '你好',
      label: '',
      status: 'review',
      selected_attempt_id: null,
      attempts: [],
      ...overrides,
    };
  }

  const shortHeadAttempt = {
    attempt_id: '001-a2',
    start_sample: 2_400_000,
    recording_started_sample: 2_400_000,
    content_started_sample: 2_409_600,
    end_sample: 2_496_000,
    tail_silence_samples: 48_000,
    required_tail_silence_samples: 48_000,
    status: 'recorded',
    created_at: '2026-08-13T00:00:00Z',
  };
  const forcedTailAttempt = {
    ...shortHeadAttempt,
    attempt_id: '001-a6',
    content_started_sample: 2_448_000,
    tail_silence_samples: 9_600,
    forced_without_tail_silence: true,
  };
  const goodAttempt = {
    ...shortHeadAttempt,
    attempt_id: '001-a7',
    content_started_sample: 2_448_000,
    tail_silence_samples: 48_000,
  };

  const pendingMarks = itemSilenceMarks(scriptItem({ status: 'pending', attempts: [shortHeadAttempt] }), 48_000, 1_000);
  assert.equal(pendingMarks.headShort, false);
  assert.equal(pendingMarks.tailShort, false);
  assert.equal(pendingMarks.title, '');

  const skippedMarks = itemSilenceMarks(scriptItem({ status: 'skipped', attempts: [shortHeadAttempt] }), 48_000, 1_000);
  assert.equal(skippedMarks.headShort, false);
  assert.equal(skippedMarks.tailShort, false);

  const noTakeMarks = itemSilenceMarks(scriptItem({ status: 'review' }), 48_000, 1_000);
  assert.equal(noTakeMarks.headShort, false);

  const headOnlyMarks = itemSilenceMarks(scriptItem({ attempts: [shortHeadAttempt] }), 48_000, 1_000);
  assert.equal(headOnlyMarks.headShort, true);
  assert.equal(headOnlyMarks.tailShort, false);
  assert.match(headOnlyMarks.title, /首静音 200 ms/);

  const forcedTailMarks = itemSilenceMarks(scriptItem({
    status: 'accepted',
    selected_attempt_id: forcedTailAttempt.attempt_id,
    attempts: [goodAttempt, forcedTailAttempt],
  }), 48_000, 1_000);
  assert.equal(forcedTailMarks.headShort, false);
  assert.equal(forcedTailMarks.tailShort, true);

  const goodMarks = itemSilenceMarks(scriptItem({
    status: 'accepted',
    selected_attempt_id: goodAttempt.attempt_id,
    attempts: [goodAttempt],
  }), 48_000, 1_000);
  assert.equal(goodMarks.headShort, false);
  assert.equal(goodMarks.tailShort, false);
  assert.equal(goodMarks.title, '');

  const legacyTailMarks = itemSilenceMarks(scriptItem({
    attempts: [{
      attempt_id: '001-legacy',
      start_sample: 0,
      recording_started_sample: 0,
      content_started_sample: 48_000,
      end_sample: 96_000,
      status: 'recorded',
      created_at: '2026-08-13T00:00:00Z',
    }],
  }), 48_000, 1_000);
  assert.equal(legacyTailMarks.headShort, false);
  assert.equal(legacyTailMarks.tailShort, false);

  const rising = liveSilenceHint({ liveMs: 320, requiredMs: 1_000 });
  assert.equal(rising.text, '静音 320 / 1000 ms');
  assert.equal(rising.met, false);
  assert.equal(rising.progress, 0.32);

  const ready = liveSilenceHint({ liveMs: 1_000, requiredMs: 1_000 });
  assert.equal(ready.text, '静音 1000 / 1000 ms');
  assert.equal(ready.met, true);
  assert.equal(ready.progress, 1);

  const over = liveSilenceHint({ liveMs: 1_480, requiredMs: 1_000 });
  assert.equal(over.met, true);
  assert.equal(over.progress, 1);

  const unset = liveSilenceHint({ liveMs: 800, requiredMs: 0 });
  assert.equal(unset.met, false);
  assert.equal(unset.progress, 0);

  const acceptedAttempt = {
    attempt_id: '001-a1',
    start_sample: 0,
    recording_started_sample: 0,
    content_started_sample: 4_800,
    end_sample: 48_000,
    tail_silence_samples: 9_600,
    status: 'accepted',
    created_at: '2026-08-13T00:00:00Z',
  };
  assert.equal(shouldUseRecordedSilencePair(true, acceptedAttempt), false);
  assert.equal(shouldUseRecordedSilencePair(false, undefined), false);
  assert.equal(shouldUseRecordedSilencePair(false, acceptedAttempt), true);

  assert.equal(recordedMonitorSentenceLabel({
    liveCue: 'idle',
    itemStatus: 'accepted',
    liveLabel: '请等待开始',
  }), '已确认');
  assert.equal(recordedMonitorSentenceLabel({
    liveCue: 'idle',
    itemStatus: 'skipped',
    liveLabel: '请等待开始',
  }), '已跳过');
  assert.equal(recordedMonitorSentenceLabel({
    liveCue: 'review',
    itemStatus: 'review',
    liveLabel: '本句已录制',
  }), '本句已录制');
  assert.equal(recordedMonitorSentenceLabel({
    liveCue: 'idle',
    itemStatus: 'pending',
    liveLabel: '请等待开始',
  }), '请等待开始');
  assert.equal(recordedMonitorSentenceLabel({
    liveCue: 'recording',
    itemStatus: 'accepted',
    liveLabel: '请朗读',
  }), '请朗读');
  assert.equal(recordedMonitorSentenceLabel({
    liveCue: 'fault',
    itemStatus: 'accepted',
    liveLabel: '立即停止朗读 · 输入中断',
  }), '立即停止朗读 · 输入中断');

  assert.equal(canFinishSpokenTake({ enforce: true, pending: true, spoken: false, tailMet: false }), true);
  assert.equal(canFinishSpokenTake({ enforce: true, pending: false, spoken: false, tailMet: false }), true);
  assert.equal(canFinishSpokenTake({ enforce: true, pending: false, spoken: true, tailMet: false }), false);
  assert.equal(canFinishSpokenTake({ enforce: true, pending: false, spoken: true, tailMet: true }), true);
  assert.equal(canFinishSpokenTake({ enforce: false, pending: false, spoken: true, tailMet: false }), true);

  assert.equal(takeStartSample({
    enforce: true,
    recordingStartedSample: 0,
    headSilencePassedSample: 48_000,
  }), 48_000);
  assert.equal(takeStartSample({
    enforce: false,
    recordingStartedSample: 0,
    headSilencePassedSample: 48_000,
  }), 0);

  const headProgress = liveSilenceProgress({
    pending: true,
    spoken: false,
    pendingRemainingMs: 250,
    liveSilenceMs: 0,
    requiredMs: 500,
  });
  assert.equal(headProgress, 0.5);
  const tailProgress = liveSilenceProgress({
    pending: false,
    spoken: true,
    pendingRemainingMs: 0,
    liveSilenceMs: 400,
    requiredMs: 500,
  });
  assert.equal(tailProgress, 0.8);

  console.log('silence readout tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
