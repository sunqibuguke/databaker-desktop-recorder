const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'recording-workflow.ts');
  const {
    areAllItemsHandled,
    executeSafePause,
    findNextActionableItemIndex,
    idlePrimaryAction,
    isFinalReview,
    workflowShortcutAction,
  } = await import(pathToFileURL(modulePath).href);

  const item = (status) => ({ status });

  const threeComplete = [item('accepted'), item('skipped'), item('accepted')];
  assert.equal(areAllItemsHandled(threeComplete), true, 'three handled rows must enter the terminal state');
  assert.equal(idlePrimaryAction(threeComplete, 2), 'finish', 'the last handled row must offer finish, not another take');
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
