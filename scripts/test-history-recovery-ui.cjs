const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const modulePath = path.join(__dirname, '..', 'src', 'history-recovery.ts');
  const {
    effectiveCaptureFaultKind,
    engineRecoveryFailure,
    isReconciliableInactiveStopError,
    isBenignJournalReplayWarning,
    planHistoryRecovery,
    planTaskListEntry,
    splitRecoveryWarnings,
  } = await import(pathToFileURL(modulePath).href);
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
    { canResume: false, canSeal: true, primary: 'seal', secondary: null },
    'overflowed audio must keep offline sealing reachable without offering resume',
  );
  assert.deepEqual(
    planHistoryRecovery({ ...base, status: 'faulted', pending_items: 2 }),
    { canResume: false, canSeal: true, primary: 'seal', secondary: null },
    'faulted audio must keep offline sealing reachable without offering resume',
  );
  assert.deepEqual(
    planHistoryRecovery({ ...base, is_active: true }),
    { canResume: false, canSeal: false, primary: null, secondary: null },
    'an active session uses the dedicated return-to-recording action',
  );

  assert.deepEqual(
    planTaskListEntry({ ...base, is_active: true, status: 'recording' }),
    { kind: 'return' },
    'an active session keeps a single return-to-recording action',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, is_active: true, status: 'stopping' }),
    { kind: 'continue-stop' },
    'an active safe-stop keeps the dedicated continue-stop action',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped', pending_items: 2 }),
    { kind: 'view-record', viewPrimary: false, recordEnabled: true },
    'an unfinished stopped task offers record as the primary row action',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped' }),
    { kind: 'view-record', viewPrimary: true, recordEnabled: true },
    'a completed stopped task offers view as the primary row action',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'recording', pending_items: 2 }),
    { kind: 'view-only', recordDisabledReason: 'fault' },
    'an interrupted unfinished task must be sealed before record can arm capture',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'faulted', pending_items: 2 }),
    { kind: 'view-only', recordDisabledReason: 'fault' },
    'faulted audio stays viewable but cannot jump into capture',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped', history_issue: 'snapshot unreadable' }),
    { kind: 'view-only', recordDisabledReason: 'issue' },
    'a history issue blocks record even when the row looks complete',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped', data_health: 'readonly' }),
    { kind: 'view-only', recordDisabledReason: 'readonly' },
    'readonly health keeps view available and disables record',
  );

  const healthy = { faulted: false, overflow_samples: 0, storage_status: 'healthy' };
  assert.equal(
    effectiveCaptureFaultKind(true, 'ready', healthy),
    null,
    'a connected healthy capture keeps normal recording controls',
  );
  assert.equal(
    effectiveCaptureFaultKind(true, 'connecting', healthy),
    'engine_recovering',
    'engine recovery must immediately replace every normal read cue',
  );
  assert.equal(
    effectiveCaptureFaultKind(true, 'offline', healthy),
    'engine_offline',
    'an offline engine must immediately replace every normal read cue',
  );
  assert.equal(
    effectiveCaptureFaultKind(true, 'ready', { ...healthy, overflow_samples: 1 }),
    'capture',
    'write overflow must block renderer mutations even without faulted=true',
  );
  assert.equal(
    effectiveCaptureFaultKind(true, 'ready', { ...healthy, storage_status: 'critical' }),
    'capture',
    'critical storage must block renderer mutations even without faulted=true',
  );
  assert.equal(
    effectiveCaptureFaultKind(false, 'offline', healthy),
    null,
    'home/setup connectivity state is not a live capture fault',
  );

  assert.equal(isReconciliableInactiveStopError('NO_ACTIVE_SESSION: current session missing'), true);
  assert.equal(isReconciliableInactiveStopError('当前没有进行中的录制'), true);
  assert.equal(
    isReconciliableInactiveStopError('metadata journal durability failure: disk sync failed'),
    true,
    'a terminal metadata seal failure may use an authoritative inactive-state reconciliation',
  );
  assert.equal(
    isReconciliableInactiveStopError('录音引擎响应超时：stop_session'),
    false,
    'a timeout is not proof that capture stopped',
  );
  assert.equal(
    isReconciliableInactiveStopError('请先结束当前句，再结束整次录制'),
    false,
    'an active-attempt rejection must never be synthesized as a stopped session',
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

  assert.equal(
    isBenignJournalReplayWarning('最终快照不可用或不是最新，已从 journal line 1 恢复 journal_seq 23。'),
    true,
  );
  assert.equal(
    isBenignJournalReplayWarning('identity conflict: directory belongs to another session'),
    false,
  );
  assert.deepEqual(
    splitRecoveryWarnings([
      '最终快照不可用或不是最新，已从 journal line 1 恢复 journal_seq 23。',
      'directory identity mismatch',
    ]),
    {
      benign: ['最终快照不可用或不是最新，已从 journal line 1 恢复 journal_seq 23。'],
      serious: ['directory identity mismatch'],
    },
  );

  console.log('history recovery UI policy tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
