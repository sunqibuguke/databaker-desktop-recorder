import type { EngineEvent, EngineRecoveryFailedPayload, RecordingHistoryEntry } from './types';

export type CaptureEngineStatus = 'connecting' | 'ready' | 'offline';
export type EffectiveCaptureFaultKind = 'capture' | 'engine_recovering' | 'engine_offline';

type CaptureHealthFields = {
  faulted: boolean;
  overflow_samples: number;
  storage_status: 'healthy' | 'warning' | 'critical';
};

type HistoryRecoveryFields = Pick<
  RecordingHistoryEntry,
  'is_active' | 'overflow_samples' | 'pending_items' | 'review_items' | 'status'
>;

type TaskListFields = HistoryRecoveryFields & Pick<
  RecordingHistoryEntry,
  | 'history_issue'
  | 'data_health'
  | 'blocker_items'
  | 'warning_items'
  | 'complete_task_readiness'
  | 'export_artifacts'
  | 'delivery_verifications'
  | 'verified_delivery_directories'
>;

export type TaskListEntry =
  | { kind: 'return' }
  | { kind: 'continue-stop' }
  | { kind: 'repair' }
  | { kind: 'record' }
  | { kind: 'issues' }
  | { kind: 'export' }
  | { kind: 'deliver' }
  | { kind: 'delivered' }
  | { kind: 'inspect'; reason: 'issue' | 'readonly' | 'blocked' | 'warning' };

export type HistoryRecoveryPlan = {
  canResume: boolean;
  canSeal: boolean;
  primary: 'resume' | 'seal' | null;
  secondary: 'seal' | null;
};

/**
 * The renderer must stop presenting any read/accept/skip affordance whenever
 * the live capture path cannot be proven healthy. Engine connectivity is part
 * of that proof: stale meter values must not leave a green cue on screen while
 * Electron is recovering or has lost the sidecar.
 */
export function effectiveCaptureFaultKind(
  isRunning: boolean,
  engineStatus: CaptureEngineStatus,
  health: CaptureHealthFields,
): EffectiveCaptureFaultKind | null {
  if (!isRunning) return null;
  if (health.faulted || health.overflow_samples > 0 || health.storage_status === 'critical') {
    return 'capture';
  }
  if (engineStatus === 'connecting') return 'engine_recovering';
  if (engineStatus === 'offline') return 'engine_offline';
  return null;
}

/**
 * A failed stop command may be reconciled into a faulted, offline-seal-needed
 * result only for errors which themselves mean capture already stopped (or no
 * active session exists). Arbitrary IPC, permission, timeout, or protocol
 * failures keep the operator on the recording page even if a follow-up query
 * happens to fail.
 */
export function isReconciliableInactiveStopError(message: string): boolean {
  return /NO_ACTIVE_SESSION|\u5f53\u524d\u6ca1\u6709\u8fdb\u884c\u4e2d\u7684\u5f55\u5236|recording capture resources are already stopped|metadata journal durability failure|\u5143\u6570\u636e\u65e5\u5fd7\u65e0\u6cd5\u5b89\u5168\u5c01\u5b58|\u5b89\u5168\u505c\u6b62\u5df2\u5b8c\u6210/i.test(message);
}

/**
 * Keeps recovery reachability independent from how many script rows remain.
 * A clean interrupted task must be sealed even when every row was already
 * accepted/skipped, otherwise it can never become exportable.
 */
export function planHistoryRecovery(recording: HistoryRecoveryFields): HistoryRecoveryPlan {
  if (recording.is_active) {
    return { canResume: false, canSeal: false, primary: null, secondary: null };
  }

  // Faulted/overflowed tasks must never resume or enter the normal export
  // path, but the operator still needs the non-destructive offline seal that
  // repairs WAV headers and preserves the durable fault marker.
  if (recording.status === 'faulted' || recording.overflow_samples > 0) {
    return { canResume: false, canSeal: true, primary: 'seal', secondary: null };
  }

  const hasUnfinishedItems = recording.pending_items + recording.review_items > 0;
  if (recording.status === 'recording' || recording.status === 'stopping') {
    return hasUnfinishedItems
      ? { canResume: true, canSeal: true, primary: 'resume', secondary: 'seal' }
      : { canResume: false, canSeal: true, primary: 'seal', secondary: null };
  }

  if (recording.status === 'stopped' && hasUnfinishedItems) {
    return { canResume: true, canSeal: false, primary: 'resume', secondary: null };
  }

  return { canResume: false, canSeal: false, primary: null, secondary: null };
}

/**
 * Every home row has one primary next step. Secondary inspection remains
 * available by clicking the task name, but the action column never asks the
 * operator to choose between two equally prominent doors.
 */
export function planTaskListEntry(recording: TaskListFields): TaskListEntry {
  if (recording.is_active) {
    return recording.status === 'stopping' ? { kind: 'continue-stop' } : { kind: 'return' };
  }
  if (recording.history_issue) {
    return { kind: 'inspect', reason: 'issue' };
  }
  if (recording.data_health === 'readonly') {
    return { kind: 'inspect', reason: 'readonly' };
  }
  if (recording.data_health === 'needs_repair') {
    return { kind: 'repair' };
  }
  const recovery = planHistoryRecovery(recording);
  if (recovery.canSeal) {
    return { kind: 'repair' };
  }
  if (recording.review_items > 0) return { kind: 'issues' };
  if (recording.pending_items > 0) return { kind: 'record' };
  if ((recording.blocker_items ?? 0) > 0
    || recording.complete_task_readiness?.health === 'blocked') {
    return { kind: 'inspect', reason: 'blocked' };
  }
  if ((recording.warning_items ?? 0) > 0
    || recording.complete_task_readiness?.health === 'warning') {
    return { kind: 'inspect', reason: 'warning' };
  }
  if (!recording.complete_task_readiness) {
    return { kind: 'inspect', reason: 'blocked' };
  }
  const cuts = recording.export_artifacts?.cuts_zip;
  if (recording.complete_task_readiness?.ready && (!cuts || cuts.state === 'never' || cuts.state === 'stale' || cuts.state === 'failed')) {
    return { kind: 'export' };
  }
  if (recording.complete_task_readiness.ready && cuts?.state === 'current') {
    return recording.delivery_verifications?.cuts_zip === 'verified'
      && Boolean(recording.verified_delivery_directories?.cuts_zip)
      ? { kind: 'delivered' }
      : { kind: 'deliver' };
  }
  return { kind: 'inspect', reason: 'blocked' };
}

export function engineRecoveryFailure(message: EngineEvent): EngineRecoveryFailedPayload | null {
  if (message.event !== 'engine_recovery_failed'
    || !message.payload
    || typeof message.payload !== 'object') return null;

  const payload = message.payload as Partial<EngineRecoveryFailedPayload>;
  if (typeof payload.session_dir !== 'string'
    || payload.session_dir.trim() === ''
    || typeof payload.error !== 'string'
    || payload.error.trim() === '') return null;

  return { session_dir: payload.session_dir, error: payload.error };
}

export function isBenignJournalReplayWarning(warning: string): boolean {
  return /最终快照不可用或不是最新/.test(warning) && /journal_seq/.test(warning);
}

export function splitRecoveryWarnings(warnings: string[] | undefined): {
  benign: string[];
  serious: string[];
} {
  const list = warnings?.filter((warning) => warning.trim()) ?? [];
  return {
    benign: list.filter(isBenignJournalReplayWarning),
    serious: list.filter((warning) => !isBenignJournalReplayWarning(warning)),
  };
}
