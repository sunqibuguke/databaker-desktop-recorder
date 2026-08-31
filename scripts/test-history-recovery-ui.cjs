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
    { kind: 'record' },
    'an unfinished stopped task has one direct record action',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped', pending_items: 2, review_items: 1 }),
    { kind: 'issues' },
    'a task with an unresolved take routes to issue handling before reopening hardware',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped' }),
    { kind: 'inspect', reason: 'blocked' },
    'a legacy task without delivery readiness must be checked instead of looking complete',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'recording', pending_items: 2 }),
    { kind: 'repair' },
    'an interrupted unfinished task exposes repair directly instead of hiding it in overflow',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'faulted', pending_items: 2 }),
    { kind: 'repair' },
    'faulted audio exposes the one safe repair action',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped', history_issue: 'snapshot unreadable' }),
    { kind: 'inspect', reason: 'issue' },
    'a history issue routes directly to inspection',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped', data_health: 'readonly' }),
    { kind: 'inspect', reason: 'readonly' },
    'readonly health routes directly to inspection',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped', data_health: 'needs_repair' }),
    { kind: 'repair' },
    'an explicit repairable data-health state exposes repair directly',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped', blocker_items: 1 }),
    { kind: 'inspect', reason: 'blocked' },
    'a completed-looking task with delivery blockers cannot claim export readiness',
  );
  assert.deepEqual(
    planTaskListEntry({ ...base, status: 'stopped', warning_items: 1 }),
    { kind: 'inspect', reason: 'warning' },
    'a task with warnings routes to review before delivery',
  );
  assert.deepEqual(
    planTaskListEntry({
      ...base,
      status: 'stopped',
      complete_task_readiness: { ready: true, health: 'clear', included_items: 2, excluded_items: 0, blocker_count: 0, warning_count: 0 },
    }),
    { kind: 'export' },
    'a clean completed task with no current cuts exposes export directly',
  );
  assert.deepEqual(
    planTaskListEntry({
      ...base,
      status: 'stopped',
      complete_task_readiness: { ready: true, health: 'clear', included_items: 2, excluded_items: 0, blocker_count: 0, warning_count: 0 },
      export_artifacts: { cuts_zip: { artifact: 'cuts_zip', state: 'current', warnings: [] } },
    }),
    { kind: 'deliver' },
    'a current internal artifact is still pending delivery until its receipt is verified',
  );
  assert.deepEqual(
    planTaskListEntry({
      ...base,
      status: 'stopped',
      complete_task_readiness: { ready: true, health: 'clear', included_items: 2, excluded_items: 0, blocker_count: 0, warning_count: 0 },
      export_artifacts: { cuts_zip: { artifact: 'cuts_zip', state: 'current', warnings: [] } },
      delivery_verifications: { cuts_zip: 'verified' },
      verified_delivery_directories: { cuts_zip: '/external/delivery' },
    }),
    { kind: 'delivered' },
    'only a current artifact with a verified delivery receipt and its external directory is shown as delivered',
  );
  assert.deepEqual(
    planTaskListEntry({
      ...base,
      status: 'stopped',
      complete_task_readiness: { ready: true, health: 'clear', included_items: 2, excluded_items: 0, blocker_count: 0, warning_count: 0 },
      export_artifacts: { cuts_zip: { artifact: 'cuts_zip', state: 'current', warnings: [] } },
      delivery_verifications: { cuts_zip: 'verified' },
    }),
    { kind: 'deliver' },
    'a verified status without the verified external directory must not open the internal export as delivery',
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
