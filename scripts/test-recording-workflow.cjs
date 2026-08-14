const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'recording-workflow.ts');
  const inputQualityModulePath = path.join(__dirname, '..', 'src', 'input-quality.ts');
  const captureConfigurationModulePath = path.join(__dirname, '..', 'src', 'capture-configuration.ts');
  const {
    areAllItemsHandled,
    captureExitAction,
    captureExitDialog,
    continuationAfterAccept,
    executeSafePause,
    findNextActionableItemIndex,
    idlePrimaryAction,
    isCurrentSessionNoiseCheckOperation,
    isFinalReview,
    noiseCheckShortcutAction,
    noiseLevelPercent,
    noiseWindowState,
    resolveRunningItemIndex,
    sessionNoiseGate,
    shouldAutoRunSessionNoiseCheck,
    shouldShowSessionNoiseCheckDialog,
    previewShortcutAction,
    shouldAutoStartAfterAccept,
    viewShortcutAction,
    workflowShortcutAction,
    workspacePosture,
  } = await import(pathToFileURL(modulePath).href);
  const {
    DIGITAL_SILENCE_WARNING,
    inputQualityWarning,
    shouldHandleLiveMeter,
  } = await import(pathToFileURL(inputQualityModulePath).href);
  const {
    captureFormatsSupportBitDepth,
    captureSampleFormatFromBitDepth,
    captureSampleFormatLabel,
    captureSampleFormatsForConfiguration,
    captureShareModeLabel,
    configurationsForShareMode,
    deliveryBitDepthForCaptureFormat,
    inputSampleFormatRepresentationBits,
    minimumInputRepresentationBits,
    normalizeCaptureSampleFormat,
    normalizeCaptureShareMode,
    preferredCaptureSampleFormat,
  } = await import(pathToFileURL(captureConfigurationModulePath).href);

  const item = (status) => ({ status });

  assert.equal(sessionNoiseGate(null, false), 'pending');
  assert.equal(sessionNoiseGate(null, true), 'checking');
  assert.equal(sessionNoiseGate({ passed: false }, false), 'failed');
  assert.equal(sessionNoiseGate({ passed: true }, false), 'ready');
  assert.equal(
    shouldAutoRunSessionNoiseCheck(null, true),
    true,
    'a newly created or resumed activation must run one ambient-noise check',
  );
  assert.equal(
    shouldAutoRunSessionNoiseCheck(null, false),
    false,
    'a renderer reconnect must not duplicate an in-flight or already requested check',
  );
  assert.equal(
    shouldAutoRunSessionNoiseCheck({ passed: false }, true),
    false,
    'a failed completed check waits for an explicit retry instead of auto-looping',
  );
  assert.equal(
    shouldAutoRunSessionNoiseCheck({ passed: true }, true),
    false,
    'a persisted pass keeps every later sentence and retake open',
  );
  assert.equal(sessionNoiseGate(null, false, false), 'ready');
  assert.equal(sessionNoiseGate({ passed: false }, true, false), 'ready');
  assert.equal(
    shouldAutoRunSessionNoiseCheck(null, true, false),
    false,
    'a disabled room-noise rule must not auto-run the gate',
  );
  const firstNoiseOperation = { activation: 1, request: 1, sessionDir: '/recordings/session-a' };
  const retryNoiseOperation = { activation: 1, request: 2, sessionDir: '/recordings/session-a' };
  const recoveredNoiseOperation = { activation: 2, request: 3, sessionDir: '/recordings/session-a' };
  assert.equal(
    isCurrentSessionNoiseCheckOperation(firstNoiseOperation, firstNoiseOperation, 1, '/recordings/session-a'),
    true,
    'the active request may settle its own activation',
  );
  assert.equal(
    isCurrentSessionNoiseCheckOperation(retryNoiseOperation, firstNoiseOperation, 1, '/recordings/session-a'),
    false,
    'an older promise must not settle a newer request in the same activation',
  );
  assert.equal(
    isCurrentSessionNoiseCheckOperation(recoveredNoiseOperation, firstNoiseOperation, 2, '/recordings/session-a'),
    false,
    'an older promise must not settle a recovered activation that reuses the same directory',
  );
  assert.equal(
    isCurrentSessionNoiseCheckOperation(firstNoiseOperation, firstNoiseOperation, 1, '/recordings/session-b'),
    false,
    'a request must not settle after the active session directory changes',
  );
  assert.equal(
    shouldShowSessionNoiseCheckDialog(true, false),
    true,
    'a blocked ambient-noise gate must keep the modal until the room passes',
  );
  assert.equal(
    shouldShowSessionNoiseCheckDialog(true, false, true),
    false,
    'the leave-confirm dialog must replace the noise modal so the operator can exit',
  );
  assert.equal(shouldShowSessionNoiseCheckDialog(true, true), false);
  assert.equal(shouldShowSessionNoiseCheckDialog(false, false), false);
  assert.equal(noiseCheckShortcutAction('Escape', 'Escape', false), 'leave');
  assert.equal(noiseCheckShortcutAction('Escape', 'Escape', true), 'leave');
  assert.equal(noiseCheckShortcutAction(' ', 'Space', false), 'retry');
  assert.equal(
    noiseCheckShortcutAction(' ', 'Space', true),
    'none',
    'space must not restart an in-flight room check',
  );

  assert.equal(noiseWindowState([], 0, -42).state, 'sampling');
  assert.equal(noiseWindowState([-50, -50, -50, -50, -50], 0, -42).state, 'passed');
  assert.equal(noiseWindowState([-50, -30, -50, -50, -50], 0, -42).state, 'failed');
  assert.equal(noiseWindowState([-42, -50, -50, -50, -50], 0, -42).state, 'failed');
  assert.equal(noiseWindowState(Array(10).fill(-55).concat([-30, -55, -55, -55, -55]), 2, -42).state, 'failed');
  assert.equal(noiseLevelPercent(-72), 0);
  assert.equal(noiseLevelPercent(-6), 100);

  assert.equal(
    inputQualityWarning(true, false, true),
    DIGITAL_SILENCE_WARNING,
    'a live exact-digital-silence run must produce the explicit operator warning',
  );
  assert.equal(
    inputQualityWarning(true, true, true),
    '',
    'a capture fault must take visual priority over the non-terminal input-quality warning',
  );
  assert.equal(
    inputQualityWarning(false, false, true),
    '',
    'a stopped task must not retain a late input-quality warning',
  );
  assert.equal(shouldHandleLiveMeter('running'), true);
  assert.equal(shouldHandleLiveMeter('home'), false);
  assert.equal(shouldHandleLiveMeter('setup'), false);

  assert.equal(minimumInputRepresentationBits(16), 16);
  assert.equal(minimumInputRepresentationBits(24), 24);
  assert.equal(minimumInputRepresentationBits(32), 24);
  assert.equal(inputSampleFormatRepresentationBits('F32'), 24);
  assert.equal(normalizeCaptureShareMode(undefined), 'exclusive');
  assert.equal(normalizeCaptureShareMode('shared'), 'shared');
  assert.equal(captureShareModeLabel('exclusive'), '独占');
  assert.equal(captureShareModeLabel('shared'), '系统混音');
  const dualModeDevice = {
    configurations: [
      { min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 2, sample_format: 'i24', share_mode: 'exclusive' },
      { min_sample_rate: 44_100, max_sample_rate: 48_000, channels: 2, sample_format: 'f32', share_mode: 'shared' },
    ],
  };
  assert.deepEqual(
    configurationsForShareMode(dualModeDevice, 'exclusive').map((configuration) => configuration.sample_format),
    ['i24'],
  );
  assert.deepEqual(
    configurationsForShareMode(dualModeDevice, 'shared').map((configuration) => configuration.min_sample_rate),
    [44_100],
  );
  assert.equal(configurationsForShareMode({ configurations: [{ min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 1, sample_format: 'f32' }] }, 'exclusive').length, 0);
  assert.equal(configurationsForShareMode({ configurations: [{ min_sample_rate: 48_000, max_sample_rate: 48_000, channels: 1, sample_format: 'f32' }] }, 'shared').length, 1);
  assert.equal(captureFormatsSupportBitDepth(['I16'], 16), true);
  assert.equal(
    captureFormatsSupportBitDepth(['I16'], 24),
    false,
    'an I16-only input must not be presented as valid for 24-bit delivery',
  );
  assert.equal(
    captureFormatsSupportBitDepth(['I16'], 32),
    false,
    'an I16-only input must not enable 32-bit delivery',
  );
  assert.equal(captureFormatsSupportBitDepth(['I16', 'I24'], 24), true);
  assert.equal(captureFormatsSupportBitDepth(['F32'], 32), true);
  assert.equal(normalizeCaptureSampleFormat('I24'), 'i24');
  assert.equal(normalizeCaptureSampleFormat('pcm24'), null);
  assert.equal(captureSampleFormatFromBitDepth(16), 'i16');
  assert.equal(captureSampleFormatFromBitDepth(32), 'f32');
  assert.equal(deliveryBitDepthForCaptureFormat('i24'), 24);
  assert.equal(deliveryBitDepthForCaptureFormat('i32'), 32);
  assert.equal(preferredCaptureSampleFormat(['f32', 'i16']), 'i16');
  assert.deepEqual(
    captureSampleFormatsForConfiguration(dualModeDevice.configurations, 48_000, 1),
    ['i24', 'f32'],
  );
  assert.deepEqual(
    captureSampleFormatsForConfiguration(
      dualModeDevice.configurations.filter((configuration) => configuration.share_mode === 'exclusive'),
      48_000,
      1,
    ),
    ['i24'],
  );
  assert.match(captureSampleFormatLabel('i32'), /32/);

  const threeComplete = [item('accepted'), item('skipped'), item('accepted')];
  assert.equal(captureExitAction(threeComplete, false), 'complete');
  assert.equal(captureExitAction([item('accepted'), item('pending')], false), 'pause');
  assert.equal(captureExitAction(threeComplete, true), 'fault');
  assert.equal(
    captureExitDialog(true, false, 'complete'),
    'pause',
    'a live retake in an otherwise complete task must remain safely pausable',
  );
  assert.equal(captureExitDialog(false, false, 'complete'), 'finish');
  assert.equal(captureExitDialog(true, true, 'fault'), 'finish');
  assert.equal(areAllItemsHandled(threeComplete), true, 'three handled rows must enter the terminal state');
  assert.equal(idlePrimaryAction(threeComplete, 2), 'finish', 'the last handled row must offer finish, not another take');
  assert.equal(
    idlePrimaryAction(threeComplete, -1),
    'finish',
    'a completed task may clear the row selection without losing its finish action',
  );
  assert.equal(
    workflowShortcutAction('Space', ' ', idlePrimaryAction(threeComplete, -1), false),
    'finish',
    'Space must still finish after the terminal row selection is cleared',
  );
  assert.equal(
    workflowShortcutAction('Space', ' ', idlePrimaryAction(threeComplete, 2), true),
    'finish',
    'Space in the terminal state must open the existing finish confirmation',
  );
  assert.equal(
    workflowShortcutAction('KeyR', 'r', idlePrimaryAction(threeComplete, 2), true),
    'retake',
    'R must remain an explicit way to reopen a handled row from the terminal state',
  );

  const pendingReview = [item('accepted'), item('review'), item('accepted')];
  assert.equal(
    findNextActionableItemIndex(pendingReview, 0),
    1,
    'navigation must not skip a review row',
  );
  assert.equal(isFinalReview(pendingReview, 1), true, 'the final review must say it completes the task');
  assert.equal(
    isFinalReview([item('review'), item('interrupted')], 0),
    false,
    'an unknown or interrupted row must not be silently counted as handled',
  );
  assert.deepEqual(
    continuationAfterAccept([item('accepted'), item('pending'), item('accepted')], 0),
    { kind: 'start', nextIndex: 1 },
    'accepting a sentence names the next pending sentence as the start candidate',
  );
  assert.equal(
    shouldAutoStartAfterAccept({ kind: 'start', nextIndex: 1 }, true),
    true,
  );
  assert.equal(
    shouldAutoStartAfterAccept({ kind: 'start', nextIndex: 1 }, false),
    false,
    'the auto-start rule must be able to keep confirm from arming the next take',
  );
  assert.equal(
    shouldAutoStartAfterAccept({ kind: 'review', nextIndex: 1 }, true),
    false,
  );
  assert.deepEqual(
    continuationAfterAccept([item('accepted'), item('review'), item('pending')], 0),
    { kind: 'review', nextIndex: 1 },
    'an existing review must be shown instead of being silently re-recorded',
  );
  assert.deepEqual(
    continuationAfterAccept(threeComplete, 2),
    { kind: 'finish' },
    'the final accepted sentence must enter the existing finish state',
  );
  assert.deepEqual(
    continuationAfterAccept([item('accepted'), item('interrupted')], 0),
    { kind: 'blocked' },
    'an unexpected item state must not be skipped or started',
  );

  const acceptedBeforePending = [item('accepted'), item('pending'), item('skipped')];
  assert.equal(
    idlePrimaryAction(acceptedBeforePending, 0),
    'retake-only',
    'an accepted row must never make the ordinary primary button start a new take',
  );
  assert.equal(
    workflowShortcutAction('Space', ' ', 'retake-only', true),
    'none',
    'Space must not re-record an accepted or skipped row',
  );
  assert.equal(
    workflowShortcutAction('KeyR', 'r', 'retake-only', true),
    'retake',
    'R remains an explicit retake action',
  );

  assert.equal(workspacePosture('running', false), 'view');
  assert.equal(workspacePosture('running', true), 'record');
  assert.equal(workspacePosture('home', false), 'home');
  assert.equal(viewShortcutAction('Space', ' '), 'preview');
  assert.equal(viewShortcutAction('KeyP', 'p'), 'preview');
  assert.equal(viewShortcutAction('KeyR', 'r'), 'enter-capture');
  assert.equal(viewShortcutAction('KeyS', 's'), 'none');
  assert.equal(previewShortcutAction('Space', ' '), 'confirm');
  assert.equal(previewShortcutAction('Escape', 'Escape'), 'close');
  assert.equal(previewShortcutAction('KeyP', 'p'), 'pause');
  assert.equal(previewShortcutAction('ArrowLeft', 'ArrowLeft'), 'nudge-left');
  assert.equal(
    resolveRunningItemIndex(
      [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'accepted' }, { id: 'c', status: 'accepted' }],
      null,
      'c',
    ),
    2,
    'entering capture from view must keep the sentence the operator was inspecting',
  );
  assert.equal(
    resolveRunningItemIndex(
      [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'pending' }],
      null,
      null,
    ),
    1,
    'arming from the list without a kept sentence still lands on the first pending row',
  );
  assert.equal(
    resolveRunningItemIndex(
      [{ id: 'a', status: 'accepted' }, { id: 'b', status: 'accepted' }],
      'b',
      'a',
    ),
    1,
    'a live attempt wins over a kept inspect sentence',
  );

  const wrappedReview = [item('review'), item('accepted'), item('accepted')];
  assert.equal(
    findNextActionableItemIndex(wrappedReview, 2),
    0,
    'navigation must wrap to an earlier review row',
  );

  const successfulPauseCalls = [];
  const stoppedState = { snapshot: { status: 'stopped' } };
  assert.equal(
    await executeSafePause({
      hasActiveAttempt: true,
      closeActiveAttempt: async () => { successfulPauseCalls.push('attempt'); return true; },
      stopSession: async () => { successfulPauseCalls.push('session'); return stoppedState; },
      closePrompter: async () => { successfulPauseCalls.push('prompter'); },
    }),
    stoppedState,
    'safe pause must return the durable stop result',
  );
  assert.deepEqual(
    successfulPauseCalls,
    ['attempt', 'session', 'prompter'],
    'an active sentence must close before the continuous session is sealed',
  );

  const failedAttemptCalls = [];
  assert.equal(
    await executeSafePause({
      hasActiveAttempt: true,
      closeActiveAttempt: async () => { failedAttemptCalls.push('attempt'); return false; },
      stopSession: async () => { failedAttemptCalls.push('session'); return null; },
      closePrompter: async () => { failedAttemptCalls.push('prompter'); },
    }),
    null,
    'a healthy session that still rejects stop must keep the UI in place',
  );
  assert.deepEqual(
    failedAttemptCalls,
    ['attempt', 'session'],
    'safe pause must try the authoritative session seal after a sentence-close failure',
  );

  const faultFallbackCalls = [];
  assert.equal(
    await executeSafePause({
      hasActiveAttempt: true,
      closeActiveAttempt: async () => { faultFallbackCalls.push('attempt'); return false; },
      stopSession: async () => { faultFallbackCalls.push('session'); return stoppedState; },
      closePrompter: async () => { faultFallbackCalls.push('prompter'); },
    }),
    stoppedState,
    'a fault seal may safely stop the session even when the take cannot mutate',
  );
  assert.deepEqual(faultFallbackCalls, ['attempt', 'session', 'prompter']);

  const failedStopCalls = [];
  assert.equal(
    await executeSafePause({
      hasActiveAttempt: false,
      closeActiveAttempt: async () => { failedStopCalls.push('attempt'); return true; },
      stopSession: async () => { failedStopCalls.push('session'); return null; },
      closePrompter: async () => { failedStopCalls.push('prompter'); },
    }),
    null,
    'a failed session seal must not report a successful pause',
  );
  assert.deepEqual(failedStopCalls, ['session'], 'the UI must stay put and keep the prompter when stop_session fails');

  console.log('recording workflow policy tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
