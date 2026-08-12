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
    sessionNoiseGate,
    shouldAutoRunSessionNoiseCheck,
    workflowShortcutAction,
  } = await import(pathToFileURL(modulePath).href);
  const {
    DIGITAL_SILENCE_WARNING,
    inputQualityWarning,
    shouldHandleLiveMeter,
  } = await import(pathToFileURL(inputQualityModulePath).href);
  const {
    captureFormatsSupportBitDepth,
    inputSampleFormatRepresentationBits,
    minimumInputRepresentationBits,
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
    'accepting a sentence must immediately start the next pending sentence',
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
