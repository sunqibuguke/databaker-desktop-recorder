import type { ItemState } from './types';

export type WorkflowAttempt = Pick<ItemState['attempts'][number], 'attempt_id' | 'status'>;
export type WorkflowItem = Pick<ItemState, 'status'>
  & Partial<Pick<ItemState, 'label' | 'selected_attempt_id'>>
  & { attempts?: readonly WorkflowAttempt[] };
export type LabelTransition = {
  changed: boolean;
  fromLabel: string;
  toLabel: string;
};
type PersistedNoiseCheck = { passed: boolean } | null | undefined;

export type IdlePrimaryAction = 'finish' | 'accept' | 'start' | 'retake-only' | 'none';
export type WorkflowShortcutAction = 'finish' | 'accept' | 'start' | 'retake' | 'none';
export type ViewShortcutAction = 'preview' | 'enter-capture' | 'none';
export type WorkflowShortcutTarget = Readonly<{
  modalOpen: boolean;
  formControl: boolean;
  button: boolean;
  professionalItem: boolean;
}>;
export type WorkspacePosture = 'home' | 'setup' | 'view' | 'record';
export type CaptureExitAction = 'pause' | 'complete' | 'fault';
export type CaptureExitDialog = 'pause' | 'finish';
export type CaptureStopDestination = 'home' | 'inspect';
export type InspectorFooterLeaveKind = 'view' | 'task' | 'fault';
export type InspectorFooterModel = {
  showEnterCapture: boolean;
  showPauseCapture: boolean;
  leaveKind: InspectorFooterLeaveKind;
};
export type SessionNoiseGate = 'pending' | 'checking' | 'failed' | 'ready';
export type NoiseCheckShortcutAction = 'leave' | 'retry' | 'none';
export type AcceptContinuation =
  | { kind: 'start'; nextIndex: number }
  | { kind: 'review'; nextIndex: number }
  | { kind: 'finish' }
  | { kind: 'blocked' };
export type SessionNoiseCheckOperation = Readonly<{
  activation: number;
  request: number;
  sessionDir: string;
}>;

export const NOISE_CHECK_STEPS = 15;
export const NOISE_WINDOW_COUNT = 3;
export const NOISE_WINDOW_SIZE = 5;

export function noiseLevelPercent(dbfs: number): number {
  return Math.min(100, Math.max(0, (dbfs + 72) / 66 * 100));
}

export function noiseWindowState(samples: number[], windowIndex: number, thresholdDbfs: number) {
  const windowSamples = samples.slice(
    windowIndex * NOISE_WINDOW_SIZE,
    windowIndex * NOISE_WINDOW_SIZE + NOISE_WINDOW_SIZE,
  );
  const complete = windowSamples.length === NOISE_WINDOW_SIZE;
  const failed = complete && windowSamples.some((sample) => sample >= thresholdDbfs);
  return {
    samples: windowSamples,
    complete,
    failed,
    state: complete ? (failed ? 'failed' : 'passed') : 'sampling',
  } as const;
}

export type SafePauseOperations<T> = {
  hasActiveAttempt: boolean;
  closeActiveAttempt: () => Promise<boolean>;
  stopSession: () => Promise<T | null>;
  closePrompter: () => Promise<unknown>;
};

function needsHandling(item: WorkflowItem): boolean {
  return item.status === 'pending' || item.status === 'review';
}

export function normalizeScriptLabel(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function labelTransition(
  from: string | null | undefined,
  to: string | null | undefined,
): LabelTransition {
  const fromLabel = normalizeScriptLabel(from);
  const toLabel = normalizeScriptLabel(to);
  return { changed: fromLabel !== toLabel, fromLabel, toLabel };
}

export function isLabelBoundary(
  items: readonly Pick<WorkflowItem, 'label'>[],
  index: number,
): boolean {
  if (index <= 0 || index >= items.length) return false;
  return labelTransition(items[index - 1]?.label, items[index]?.label).changed;
}

function latestAttempt(item: WorkflowItem): WorkflowAttempt | undefined {
  return item.attempts?.[item.attempts.length - 1];
}

function hasUsableSelectedAttempt(item: WorkflowItem): boolean {
  if (!item.selected_attempt_id) return false;
  return item.attempts?.some((attempt) => (
    attempt.attempt_id === item.selected_attempt_id && attempt.status === 'accepted'
  )) ?? false;
}

export function itemRequiresRerecord(item: WorkflowItem): boolean {
  return latestAttempt(item)?.status === 'needs_rerecord' && !hasUsableSelectedAttempt(item);
}

export function itemHasRetainedPreviousWarning(item: WorkflowItem): boolean {
  return latestAttempt(item)?.status === 'needs_rerecord' && hasUsableSelectedAttempt(item);
}

export function itemHasPendingRetakeDecision(item: WorkflowItem): boolean {
  if (item.status !== 'review') return false;
  const attempts = item.attempts ?? [];
  let candidateIndex = -1;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    if (attempts[index]?.status === 'recorded') {
      candidateIndex = index;
      break;
    }
  }
  if (candidateIndex < 0) return false;
  if (item.selected_attempt_id) return item.selected_attempt_id !== attempts[candidateIndex]?.attempt_id;
  // With no selected delivery version, a recorded candidate following any
  // earlier persisted attempt is still a retake. Deriving this from the
  // existing attempt history keeps the physical-next rule across restarts
  // without adding a disk field.
  return candidateIndex > 0;
}

export function selectionIndexAfterStoppedRetake(
  items: readonly WorkflowItem[],
  sourceIndex: number,
  wasRecordingRetake: boolean,
  attemptCountBeforeStop: number,
): number {
  if (sourceIndex < 0 || sourceIndex >= items.length) return sourceIndex;
  const source = items[sourceIndex];
  const persistedNewAttempt = (source.attempts?.length ?? 0) > attemptCountBeforeStop;
  return wasRecordingRetake && persistedNewAttempt && itemHasRetainedPreviousWarning(source)
    ? nextPhysicalItemIndex(sourceIndex, items.length)
    : sourceIndex;
}

export function findNextRerecordIndex(
  items: readonly WorkflowItem[],
  currentIndex: number,
): number {
  if (!items.length) return -1;
  const start = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < items.length
    ? currentIndex
    : -1;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (start + offset) % items.length;
    if (itemRequiresRerecord(items[index])) return index;
  }
  return -1;
}

export function nextPhysicalItemIndex(currentIndex: number, itemCount: number): number {
  if (itemCount <= 0) return -1;
  if (currentIndex < 0) return 0;
  return Math.min(currentIndex + 1, itemCount - 1);
}

export function areAllItemsHandled(items: readonly WorkflowItem[]): boolean {
  return items.length > 0 && items.every((item) => (
    item.status === 'accepted' || item.status === 'skipped'
  ));
}

export function captureExitAction(
  items: readonly WorkflowItem[],
  hasCaptureFault: boolean,
): CaptureExitAction {
  if (hasCaptureFault) return 'fault';
  return areAllItemsHandled(items) ? 'complete' : 'pause';
}

export function captureExitDialog(
  isRecording: boolean,
  hasCaptureFault: boolean,
  action: CaptureExitAction,
): CaptureExitDialog {
  if (hasCaptureFault || action === 'fault') return 'finish';
  // A retake can be active while every item is still marked handled. It must
  // close through the safe-pause flow instead of presenting a terminal finish
  // dialog that cannot close the live sentence.
  return isRecording || action === 'pause' ? 'pause' : 'finish';
}

export function shouldStayInTaskAfterStop(
  destination: CaptureStopDestination,
  mode: 'pause' | 'finish' | 'fault',
  stoppedWithFault: boolean,
): boolean {
  if (destination !== 'inspect') return false;
  // A healthy "finish capture" lands in view. If the seal is faulted or only
  // reconciled as inactive, repair still lives on the task list.
  if (mode === 'finish' && stoppedWithFault) return false;
  return true;
}

export function inspectorFooterModel(
  captureActive: boolean,
  hasCaptureFault: boolean,
): InspectorFooterModel {
  if (!captureActive) {
    return { showEnterCapture: true, showPauseCapture: false, leaveKind: 'view' };
  }
  if (hasCaptureFault) {
    return { showEnterCapture: false, showPauseCapture: false, leaveKind: 'fault' };
  }
  return { showEnterCapture: false, showPauseCapture: true, leaveKind: 'task' };
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

export function continuationAfterAccept(
  items: readonly WorkflowItem[],
  currentIndex: number,
): AcceptContinuation {
  const nextIndex = findNextActionableItemIndex(items, currentIndex);
  if (nextIndex >= 0) {
    return items[nextIndex]?.status === 'pending'
      ? { kind: 'start', nextIndex }
      : { kind: 'review', nextIndex };
  }
  return areAllItemsHandled(items) ? { kind: 'finish' } : { kind: 'blocked' };
}

export function shouldAutoStartAfterAccept(
  continuation: AcceptContinuation,
  rules: Readonly<{
    autoStartNext: boolean;
    pauseOnLabelChange: boolean;
    labelChanged: boolean;
  }>,
): boolean {
  return continuation.kind === 'start'
    && rules.autoStartNext
    && !(rules.pauseOnLabelChange && rules.labelChanged);
}

export function idlePrimaryAction(
  items: readonly WorkflowItem[],
  currentIndex: number,
): IdlePrimaryAction {
  if (areAllItemsHandled(items)) return 'finish';
  const currentItem = items[currentIndex];
  if (!currentItem) return 'none';
  if (itemRequiresRerecord(currentItem)) return 'start';
  if (currentItem.status === 'review') return 'accept';
  if (currentItem.status === 'pending') return 'start';
  return 'retake-only';
}

export function workspacePosture(
  phase: 'home' | 'setup' | 'running',
  captureActive: boolean,
): WorkspacePosture {
  if (phase !== 'running') return phase;
  return captureActive ? 'record' : 'view';
}

export function viewShortcutAction(code: string, key: string): ViewShortcutAction {
  if (code === 'Space' || key.toLowerCase() === 'p') return 'preview';
  if (key.toLowerCase() === 'r') return 'enter-capture';
  return 'none';
}

export function workflowShortcutTargetAllowed(target: WorkflowShortcutTarget): boolean {
  if (target.modalOpen || target.formControl) return false;
  return !target.button || target.professionalItem;
}

export function resolveRunningItemIndex(
  items: readonly { id: string; status: string }[],
  activeItemId?: string | null,
  keepItemId?: string | null,
): number {
  if (activeItemId) {
    const active = items.findIndex((item) => item.id === activeItemId);
    if (active >= 0) return active;
  }
  if (keepItemId) {
    const kept = items.findIndex((item) => item.id === keepItemId);
    if (kept >= 0) return kept;
  }
  const next = items.findIndex((item) => item.status === 'review' || item.status === 'pending');
  return next >= 0 ? next : 0;
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

export function sessionNoiseGate(
  noiseCheck: PersistedNoiseCheck,
  checking: boolean,
  enabled = true,
): SessionNoiseGate {
  if (!enabled) return 'ready';
  if (checking) return 'checking';
  if (!noiseCheck) return 'pending';
  return noiseCheck.passed ? 'ready' : 'failed';
}

export function shouldAutoRunSessionNoiseCheck(
  noiseCheck: PersistedNoiseCheck,
  isNewActivation: boolean,
  enabled = true,
): boolean {
  return enabled && isNewActivation && !noiseCheck;
}

export function isCurrentSessionNoiseCheckOperation(
  activeOperation: SessionNoiseCheckOperation | null,
  candidate: SessionNoiseCheckOperation,
  activeActivation: number,
  activeSessionDir: string,
): boolean {
  return activeOperation?.activation === candidate.activation
    && activeOperation.request === candidate.request
    && activeOperation.sessionDir === candidate.sessionDir
    && candidate.activation === activeActivation
    && candidate.sessionDir === activeSessionDir;
}

export function shouldShowSessionNoiseCheckDialog(
  blocksAttempt: boolean,
  hasCaptureFault: boolean,
  overlayOpen = false,
): boolean {
  return blocksAttempt && !hasCaptureFault && !overlayOpen;
}

export type CaptureEntryOverlay = 'device-warning' | 'noise-check' | 'none';

export function captureEntryOverlay(options: {
  deviceWarningOpen: boolean;
  noiseCheckBlocksAttempt: boolean;
  hasCaptureFault: boolean;
  otherOverlayOpen?: boolean;
}): CaptureEntryOverlay {
  if (options.hasCaptureFault || options.otherOverlayOpen) return 'none';
  if (options.deviceWarningOpen) return 'device-warning';
  if (options.noiseCheckBlocksAttempt) return 'noise-check';
  return 'none';
}

export function noiseCheckShortcutAction(
  key: string,
  code: string,
  running: boolean,
): NoiseCheckShortcutAction {
  if (key === 'Escape') return 'leave';
  if (code === 'Space' && !running) return 'retry';
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
