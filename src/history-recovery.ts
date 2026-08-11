import type { EngineEvent, EngineRecoveryFailedPayload, RecordingHistoryEntry } from './types';

type HistoryRecoveryFields = Pick<
  RecordingHistoryEntry,
  'is_active' | 'overflow_samples' | 'pending_items' | 'review_items' | 'status'
>;

export type HistoryRecoveryPlan = {
  canResume: boolean;
  canSeal: boolean;
  primary: 'resume' | 'seal' | null;
  secondary: 'seal' | null;
};

/**
 * Keeps recovery reachability independent from how many script rows remain.
 * A clean interrupted task must be sealed even when every row was already
 * accepted/skipped, otherwise it can never become exportable.
 */
export function planHistoryRecovery(recording: HistoryRecoveryFields): HistoryRecoveryPlan {
  if (recording.is_active || recording.overflow_samples > 0) {
    return { canResume: false, canSeal: false, primary: null, secondary: null };
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
