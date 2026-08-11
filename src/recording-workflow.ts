import type { ItemState } from './types';

type WorkflowItem = Pick<ItemState, 'status'>;

export type IdlePrimaryAction = 'finish' | 'accept' | 'start' | 'retake-only' | 'none';
export type WorkflowShortcutAction = 'finish' | 'accept' | 'start' | 'retake' | 'none';

export type SafePauseOperations<T> = {
  hasActiveAttempt: boolean;
  closeActiveAttempt: () => Promise<boolean>;
  stopSession: () => Promise<T | null>;
  closePrompter: () => Promise<unknown>;
};

function needsHandling(item: WorkflowItem): boolean {
  return item.status === 'pending' || item.status === 'review';
}

export function areAllItemsHandled(items: readonly WorkflowItem[]): boolean {
  return items.length > 0 && items.every((item) => (
    item.status === 'accepted' || item.status === 'skipped'
  ));
}

export function findNextActionableItemIndex(
  items: readonly WorkflowItem[],
  currentIndex: number,
): number {
  const after = items.findIndex((item, index) => index > currentIndex && needsHandling(item));
  if (after >= 0) return after;
  return items.findIndex(needsHandling);
}

export function isFinalReview(items: readonly WorkflowItem[], currentIndex: number): boolean {
  return items[currentIndex]?.status === 'review'
    && items.every((item, index) => (
      index === currentIndex || item.status === 'accepted' || item.status === 'skipped'
    ));
}

export function idlePrimaryAction(
  items: readonly WorkflowItem[],
  currentIndex: number,
): IdlePrimaryAction {
  const currentItem = items[currentIndex];
  if (!currentItem) return 'none';
  if (currentItem.status === 'review') return 'accept';
  if (areAllItemsHandled(items)) return 'finish';
  if (currentItem.status === 'pending') return 'start';
  return 'retake-only';
}

export function workflowShortcutAction(
  code: string,
  key: string,
  primaryAction: IdlePrimaryAction,
  hasCurrentItem: boolean,
): WorkflowShortcutAction {
  if (key.toLowerCase() === 'r' && hasCurrentItem) return 'retake';
  if (code !== 'Space') return 'none';
  if (primaryAction === 'finish' || primaryAction === 'accept' || primaryAction === 'start') {
    return primaryAction;
  }
  return 'none';
}

export async function executeSafePause<T>(operations: SafePauseOperations<T>): Promise<T | null> {
  if (operations.hasActiveAttempt) {
    // A sentence-close command can fail after the engine has already sealed
    // the take (for example, a renderer refresh error), or because a capture /
    // metadata fault forbids further attempt mutations. Always let the
    // authoritative stop_session path try its safe fallback. A healthy engine
    // with a genuinely active take rejects that stop without changing state.
    await operations.closeActiveAttempt();
  }
  const stopped = await operations.stopSession();
  if (!stopped) return null;
  try {
    await operations.closePrompter();
  } catch {
    // The session is already durably stopped. A stale auxiliary window must not
    // turn a successful audio seal into an unsafe or retryable stop operation.
  }
  return stopped;
}
