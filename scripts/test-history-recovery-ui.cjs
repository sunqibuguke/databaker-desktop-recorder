const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'history-recovery.ts');
  const { engineRecoveryFailure, planHistoryRecovery } = await import(pathToFileURL(modulePath).href);
  const base = {
    is_active: false,
    overflow_samples: 0,
    pending_items: 0,
    review_items: 0,
    status: 'recording',
  };

  assert.deepEqual(
    planHistoryRecovery(base),
    { canResume: false, canSeal: true, primary: 'seal', secondary: null },
    'an interrupted task with every item handled must keep a primary seal action',
  );
  assert.deepEqual(
    planHistoryRecovery({ ...base, pending_items: 2 }),
    { canResume: true, canSeal: true, primary: 'resume', secondary: 'seal' },
    'an interrupted unfinished task must offer resume and seal simultaneously',
  );
  assert.deepEqual(
    planHistoryRecovery({ ...base, status: 'stopping', pending_items: 2 }),
    { canResume: true, canSeal: true, primary: 'resume', secondary: 'seal' },
    'a process that exited during bounded safe-stop must remain resumable and sealable',
  );
  assert.deepEqual(
    planHistoryRecovery({ ...base, status: 'stopping' }),
    { canResume: false, canSeal: true, primary: 'seal', secondary: null },
    'a stopping task with no unfinished rows must still expose offline sealing',
  );
  assert.deepEqual(
    planHistoryRecovery({ ...base, status: 'stopped', review_items: 1 }),
    { canResume: true, canSeal: false, primary: 'resume', secondary: null },
    'a normally stopped unfinished task should remain resumable',
  );
  assert.deepEqual(
    planHistoryRecovery({ ...base, overflow_samples: 1 }),
    { canResume: false, canSeal: false, primary: null, secondary: null },
    'overflowed audio must not be presented as a routine recovery',
  );
  assert.deepEqual(
    planHistoryRecovery({ ...base, is_active: true }),
    { canResume: false, canSeal: false, primary: null, secondary: null },
    'an active session uses the dedicated return-to-recording action',
  );

  assert.deepEqual(
    engineRecoveryFailure({
      protocol_version: 1,
      event: 'engine_recovery_failed',
      payload: { session_dir: '/recordings/task-a', error: 'device unavailable' },
    }),
    { session_dir: '/recordings/task-a', error: 'device unavailable' },
    'the renderer must recognize the structured terminal recovery event',
  );
  assert.equal(
    engineRecoveryFailure({ protocol_version: 1, event: 'engine_recovery_failed', payload: {} }),
    null,
    'malformed recovery events must not trigger a destructive UI transition',
  );
  assert.equal(
    engineRecoveryFailure({ protocol_version: 1, event: 'meter', payload: {} }),
    null,
    'unrelated events must not trigger recovery-failure handling',
  );

  console.log('history recovery UI policy tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
