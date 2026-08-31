import type {
  Attempt,
  CaptureProvenanceSpan,
  ExportScope,
  ItemState,
  QualityIssueCode,
  SessionSnapshot,
  SilenceDetector,
} from './types';

export type ItemDisposition =
  | 'unrecorded'
  | 'first_take_review'
  | 'retake_review'
  | 'rerecord_required'
  | 'selected'
  | 'retained_previous'
  | 'skipped'
  | 'inconsistent';

export type RecommendedAction =
  | 'record'
  | 'confirm_first'
  | 'decide_retake'
  | 'rerecord'
  | 'continue'
  | 'repair'
  | 'none';

export type DeliveryHealth = 'clear' | 'warning' | 'blocked';
export type IssueSeverity = 'warning' | 'blocker';
export type IssueFilter = 'all' | 'blocker' | 'warning';

export type WorkflowReasonCode =
  | 'unrecorded'
  | 'first_take_pending'
  | 'retake_pending'
  | 'rerecord_required'
  | 'retained_previous'
  | 'skipped'
  | 'head_silence_short'
  | 'tail_silence_short'
  | 'selected_missing'
  | 'selected_not_found'
  | 'selected_not_accepted'
  | 'selected_range_invalid'
  | 'selected_beyond_committed'
  | 'selected_provenance_gap'
  | 'selected_quality_issue'
  | 'quality_issue_range_invalid'
  | 'multiple_accepted_attempts'
  | 'accepted_has_recorded_candidate'
  | 'attempt_id_invalid'
  | 'item_id_invalid'
  | 'unknown_item_status'
  | 'unknown_attempt_status'
  | 'unknown_quality_issue'
  | 'task_not_stopped'
  | 'task_audio_fault'
  | 'task_provenance_incomplete';

export type DerivedItemWorkflow = {
  itemId: string;
  disposition: ItemDisposition;
  recommendedAction: RecommendedAction;
  deliveryHealth: DeliveryHealth;
  selectedAttemptId: string | null;
  candidateAttemptId: string | null;
  blockers: WorkflowReasonCode[];
  warnings: WorkflowReasonCode[];
};

export type ScopeExclusion = {
  itemId: string;
  reasons: WorkflowReasonCode[];
};

export type DeliveryReadiness = {
  scope: ExportScope;
  ready: boolean;
  health: DeliveryHealth;
  includedItemIds: string[];
  excluded: ScopeExclusion[];
  blockers: WorkflowReasonCode[];
  warningCodes: WorkflowReasonCode[];
  requiresAcknowledgement: boolean;
};

export type TaskWorkflowSummary = {
  items: DerivedItemWorkflow[];
  counts: Record<ItemDisposition, number>;
  blockerCount: number;
  warningCount: number;
  dataPreservation: {
    ready: boolean;
    health: DeliveryHealth;
    blockers: WorkflowReasonCode[];
    warnings: WorkflowReasonCode[];
  };
  confirmedOnly: DeliveryReadiness;
  completeTask: DeliveryReadiness;
};

export type WorkbenchIssueKind =
  | 'first_take_review'
  | 'retake_review'
  | 'rerecord_required'
  | 'retained_previous'
  | 'head_silence_short'
  | 'tail_silence_short'
  | 'inconsistent'
  | 'capture_fault'
  | 'storage_fault'
  | 'input_discontinuity'
  | 'vad_health'
  | 'vad_diagnostics';

export type WorkbenchIssue = {
  id: string;
  kind: WorkbenchIssueKind;
  severity: IssueSeverity;
  itemId: string | null;
  itemIndex: number | null;
  reasonCodes: WorkflowReasonCode[];
};

export type TaskLevelIssueInput = {
  captureFault?: boolean;
  storageFault?: boolean;
  inputDiscontinuity?: boolean;
  vadHealth?: 'healthy' | 'lagging' | 'degraded' | 'unavailable';
  vadDiagnosticFaultCount?: number;
};

const ITEM_STATUSES = new Set(['pending', 'review', 'accepted', 'skipped']);
const ATTEMPT_STATUSES = new Set([
  'recorded',
  'accepted',
  'rejected_by_operator',
  'interrupted',
  'needs_rerecord',
]);
const KNOWN_QUALITY_ISSUES = new Set<QualityIssueCode>([
  'input_discontinuity',
  'vad_queue_overflow',
  'vad_classifier_failure',
  'vad_flush_timeout',
  'vad_worker_disconnected',
]);

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function latestAttempt(item: ItemState): Attempt | undefined {
  return item.attempts[item.attempts.length - 1];
}

function latestRecordedCandidate(item: ItemState): Attempt | undefined {
  for (let index = item.attempts.length - 1; index >= 0; index -= 1) {
    if (item.attempts[index]?.status === 'recorded') return item.attempts[index];
  }
  return undefined;
}

export function knownQualityIssueCode(code: string): code is QualityIssueCode {
  return KNOWN_QUALITY_ISSUES.has(code as QualityIssueCode);
}

function isSample(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function attemptStructuralReasons(
  attempt: Attempt,
  committedSamples?: number,
  silenceDetector: SilenceDetector = 'energy',
): WorkflowReasonCode[] {
  const reasons: WorkflowReasonCode[] = [];
  if (typeof attempt.attempt_id !== 'string' || attempt.attempt_id.trim().length === 0) {
    reasons.push('attempt_id_invalid');
  }
  const abnormal = attempt.status === 'interrupted' || attempt.status === 'needs_rerecord';
  const requiredSamples = [
    attempt.start_sample,
    attempt.recording_started_sample,
    attempt.content_started_sample,
    attempt.end_sample,
  ];
  const optionalSamples = [
    attempt.head_silence_armed_sample,
    attempt.head_silence_passed_sample,
    attempt.required_head_silence_samples,
    attempt.tail_silence_samples,
    attempt.required_tail_silence_samples,
  ].filter((value) => value !== undefined);
  const headSilenceArmedSample = attempt.head_silence_armed_sample ?? 0;
  const headSilencePassedSample = attempt.head_silence_passed_sample ?? 0;
  const requiredHeadSilenceSamples = attempt.required_head_silence_samples ?? 0;
  const abnormalAttempt = attempt.status === 'interrupted' || attempt.status === 'needs_rerecord';
  const validCompletedStart = attempt.start_sample === attempt.recording_started_sample
    || attempt.start_sample === headSilencePassedSample
    || (silenceDetector === 'vad'
      && attempt.content_started_sample !== 0
      && attempt.start_sample === Math.max(
        attempt.content_started_sample - requiredHeadSilenceSamples,
        attempt.recording_started_sample,
      ));
  const headSilenceContractInvalid = headSilencePassedSample === 0
    ? !abnormalAttempt && (headSilenceArmedSample !== 0 || requiredHeadSilenceSamples !== 0)
    : !abnormalAttempt && (
      headSilenceArmedSample > headSilencePassedSample
      || requiredHeadSilenceSamples === 0
      || headSilencePassedSample - headSilenceArmedSample < requiredHeadSilenceSamples
      || attempt.recording_started_sample !== headSilenceArmedSample
      || !validCompletedStart
    );
  if (requiredSamples.some((value) => !isSample(value))
    || optionalSamples.some((value) => !isSample(value))
    || (abnormal
      ? attempt.end_sample < attempt.start_sample
      : attempt.end_sample <= attempt.start_sample)
    || attempt.recording_started_sample > attempt.start_sample
    || attempt.recording_started_sample > attempt.end_sample
    || attempt.content_started_sample > attempt.end_sample
    || (attempt.content_started_sample !== 0
      && attempt.content_started_sample < attempt.start_sample)
    || (isSample(headSilenceArmedSample)
      && headSilenceArmedSample !== 0
      && (headSilenceArmedSample < attempt.recording_started_sample
        || headSilenceArmedSample > attempt.end_sample))
    || (isSample(headSilenceArmedSample)
      && isSample(headSilencePassedSample)
      && headSilencePassedSample !== 0
      && (headSilencePassedSample < headSilenceArmedSample
        || headSilencePassedSample > attempt.end_sample))
    || (isSample(requiredHeadSilenceSamples)
      && isSample(headSilenceArmedSample)
      && isSample(headSilencePassedSample)
      && headSilenceContractInvalid)) {
    reasons.push('selected_range_invalid');
  }
  if (typeof committedSamples === 'number') {
    if (!isSample(committedSamples)
      || requiredSamples.some((value) => isSample(value) && value > committedSamples)
      || optionalSamples.some((value) => isSample(value) && value > committedSamples)) {
      reasons.push('selected_beyond_committed');
    }
  }
  const rawIssues: unknown = attempt.quality_issues;
  if (rawIssues !== undefined && !Array.isArray(rawIssues)) {
    reasons.push('quality_issue_range_invalid');
  } else {
    for (const issue of rawIssues ?? []) {
      if (!issue || typeof issue !== 'object') {
        reasons.push('quality_issue_range_invalid');
        continue;
      }
      const { start_sample: start, end_sample: end, detector_generation: generation } = issue as {
        start_sample?: unknown;
        end_sample?: unknown;
        detector_generation?: unknown;
      };
      const hasStart = start !== undefined;
      const hasEnd = end !== undefined;
      if (hasStart !== hasEnd
        || (hasStart && (!isSample(start)
          || !isSample(end)
          || Number(start) > Number(end)
          || Number(start) < attempt.recording_started_sample
          || Number(end) > attempt.end_sample))
        || (generation !== undefined && !isSample(generation))) {
        reasons.push('quality_issue_range_invalid');
      }
    }
  }
  return unique(reasons);
}

export function attemptRangeCoveredByProvenance(
  attempt: Pick<Attempt, 'start_sample' | 'end_sample'>,
  spans: readonly CaptureProvenanceSpan[] | undefined,
): boolean {
  // Missing spans are an old-task compatibility case, but absence is not
  // evidence that a selected range belongs to the durable master track.
  if (!spans?.length) return false;
  if (spans.some((span) => !isSample(span.start_sample)
    || !isSample(span.end_sample)
    // A freshly activated capture has a legal zero-length tail span until
    // its first durable frame arrives. It contributes no coverage, but must
    // not invalidate already-confirmed ranges from earlier activations.
    || span.end_sample < span.start_sample)) return false;
  let cursor = attempt.start_sample;
  const ordered = [...spans].sort((left, right) => left.start_sample - right.start_sample);
  for (const span of ordered) {
    if (span.end_sample <= cursor) continue;
    if (span.start_sample > cursor) return false;
    cursor = Math.max(cursor, span.end_sample);
    if (cursor >= attempt.end_sample) return true;
  }
  return false;
}

export function taskProvenanceComplete(
  committedSamples: number,
  spans: readonly CaptureProvenanceSpan[] | undefined,
  expectedSampleRate?: number,
): boolean {
  if (!isSample(committedSamples)) return false;
  if (!spans?.length) return committedSamples === 0;
  if (!isSample(expectedSampleRate) || expectedSampleRate === 0) return false;
  let cursor = 0;
  for (const span of spans) {
    if (!isSample(span.start_sample)
      || !isSample(span.end_sample)
      || span.start_sample !== cursor
      || span.end_sample < span.start_sample
      || span.end_sample > committedSamples
      || span.sample_rate !== expectedSampleRate
      || typeof span.input_sample_format !== 'string'
      || span.input_sample_format.trim().length === 0
      || !Number.isSafeInteger(span.input_channels)
      || span.input_channels <= 0
      || !Number.isSafeInteger(span.input_channel)
      || span.input_channel <= 0
      || span.input_channel > span.input_channels) return false;
    cursor = span.end_sample;
  }
  return cursor === committedSamples;
}

export function attemptSafetyReasons(
  attempt: Attempt,
  options: {
    committedSamples?: number;
    provenance?: readonly CaptureProvenanceSpan[];
    requireAccepted?: boolean;
    silenceDetector?: SilenceDetector;
  } = {},
): WorkflowReasonCode[] {
  const reasons: WorkflowReasonCode[] = attemptStructuralReasons(
    attempt,
    options.committedSamples,
    options.silenceDetector,
  );
  if (!ATTEMPT_STATUSES.has(attempt.status)) reasons.push('unknown_attempt_status');
  if (options.requireAccepted && attempt.status !== 'accepted') reasons.push('selected_not_accepted');
  if (!attemptRangeCoveredByProvenance(attempt, options.provenance)) {
    reasons.push('selected_provenance_gap');
  }
  const rawIssues: unknown = attempt.quality_issues;
  const issues = Array.isArray(rawIssues) ? rawIssues : [];
  if (rawIssues !== undefined && !Array.isArray(rawIssues)) reasons.push('unknown_quality_issue');
  if (issues.some((issue) => (
    !issue
    || typeof issue !== 'object'
    || typeof issue.code !== 'string'
    || !knownQualityIssueCode(issue.code)
  ))) reasons.push('unknown_quality_issue');
  if (issues.length > 0 || attempt.status === 'interrupted' || attempt.status === 'needs_rerecord') {
    reasons.push('selected_quality_issue');
  }
  return unique(reasons);
}

export function isAttemptPreviewSafe(
  attempt: Attempt,
  snapshot: Pick<SessionSnapshot, 'committed_samples' | 'capture_provenance'>
    & Partial<Pick<SessionSnapshot, 'silence_detector'>>,
): boolean {
  if (attempt.status === 'interrupted' || attempt.status === 'needs_rerecord') return false;
  return attemptSafetyReasons(attempt, {
    committedSamples: snapshot.committed_samples,
    provenance: snapshot.capture_provenance,
    silenceDetector: snapshot.silence_detector,
  }).length === 0;
}

function selectedAttempt(item: ItemState): Attempt | undefined {
  if (!item.selected_attempt_id) return undefined;
  return item.attempts.find((attempt) => attempt.attempt_id === item.selected_attempt_id);
}

export function deliveryWarningCodesForAttempt(attempt: Attempt | undefined): WorkflowReasonCode[] {
  if (!attempt) return [];
  const warnings: WorkflowReasonCode[] = [];
  if (typeof attempt.required_head_silence_samples === 'number'
    && attempt.required_head_silence_samples > 0
    && typeof attempt.content_started_sample === 'number'
    && attempt.content_started_sample > 0
    && attempt.content_started_sample - attempt.recording_started_sample < attempt.required_head_silence_samples) {
    warnings.push('head_silence_short');
  }
  if (typeof attempt.required_tail_silence_samples === 'number'
    && attempt.required_tail_silence_samples > 0
    && (attempt.tail_silence_samples ?? 0) < attempt.required_tail_silence_samples) {
    warnings.push('tail_silence_short');
  }
  return warnings;
}

export function deriveItemWorkflow(
  item: ItemState,
  options: {
    committedSamples?: number;
    provenance?: readonly CaptureProvenanceSpan[];
    silenceDetector?: SilenceDetector;
  } = {},
): DerivedItemWorkflow {
  const blockers: WorkflowReasonCode[] = [];
  const warnings: WorkflowReasonCode[] = [];
  const selected = selectedAttempt(item);
  const candidate = latestRecordedCandidate(item);
  const latest = latestAttempt(item);
  const acceptedAttemptCount = item.attempts.filter((attempt) => attempt.status === 'accepted').length;
  const seenAttemptIds = new Set<string>();

  if (typeof item.id !== 'string' || item.id.trim().length === 0) blockers.push('item_id_invalid');
  if (item.attempts.some((attempt) => {
    if (typeof attempt.attempt_id !== 'string' || attempt.attempt_id.trim().length === 0) return true;
    if (seenAttemptIds.has(attempt.attempt_id)) return true;
    seenAttemptIds.add(attempt.attempt_id);
    return false;
  })) blockers.push('attempt_id_invalid');
  if (!ITEM_STATUSES.has(item.status)) blockers.push('unknown_item_status');
  if (item.attempts.some((attempt) => !ATTEMPT_STATUSES.has(attempt.status))) {
    blockers.push('unknown_attempt_status');
  }
  if (item.attempts.some((attempt) => {
    const rawIssues: unknown = attempt.quality_issues;
    if (rawIssues === undefined) return false;
    if (!Array.isArray(rawIssues)) return true;
    return rawIssues.some((issue) => (
      !issue
      || typeof issue !== 'object'
      || typeof issue.code !== 'string'
      || !knownQualityIssueCode(issue.code)
    ));
  })) blockers.push('unknown_quality_issue');
  for (const attempt of item.attempts) {
    blockers.push(...attemptStructuralReasons(
      attempt,
      options.committedSamples,
      options.silenceDetector,
    ));
  }
  if (item.selected_attempt_id && !selected) blockers.push('selected_not_found');
  if ((item.status === 'pending' || item.status === 'skipped') && item.selected_attempt_id) {
    blockers.push('selected_not_accepted');
  }
  if ((item.status === 'accepted' || item.status === 'review') && item.selected_attempt_id && selected) {
    blockers.push(...attemptSafetyReasons(selected, {
      committedSamples: options.committedSamples,
      provenance: options.provenance,
      requireAccepted: true,
      silenceDetector: options.silenceDetector,
    }));
  }
  if (item.status === 'accepted' && !item.selected_attempt_id) blockers.push('selected_missing');
  if (selected && acceptedAttemptCount !== 1) blockers.push('multiple_accepted_attempts');
  if (item.status === 'accepted' && candidate) blockers.push('accepted_has_recorded_candidate');
  if (latest?.status === 'needs_rerecord'
    && selected?.status === 'accepted'
    && item.status !== 'accepted') blockers.push('unknown_item_status');

  let disposition: ItemDisposition;
  if (blockers.length > 0) disposition = 'inconsistent';
  else if (item.status === 'skipped') disposition = 'skipped';
  else if (item.status === 'accepted'
    && latest?.status === 'needs_rerecord'
    && selected?.status === 'accepted') {
    disposition = 'retained_previous';
    warnings.push('retained_previous', ...deliveryWarningCodesForAttempt(selected));
  } else if (latest?.status === 'needs_rerecord') disposition = 'rerecord_required';
  else if (item.status === 'review' && candidate && selected?.status === 'accepted'
    && selected.attempt_id !== candidate.attempt_id) disposition = 'retake_review';
  else if (item.status === 'review' && candidate) disposition = 'first_take_review';
  else if (item.status === 'accepted' && selected?.status === 'accepted') {
    disposition = 'selected';
    warnings.push(...deliveryWarningCodesForAttempt(selected));
  } else if (item.status === 'pending' && !item.selected_attempt_id) disposition = 'unrecorded';
  else disposition = 'inconsistent';

  if (disposition === 'inconsistent' && blockers.length === 0) blockers.push('unknown_item_status');

  const recommendedAction: RecommendedAction = ({
    unrecorded: 'record',
    first_take_review: 'confirm_first',
    retake_review: 'decide_retake',
    rerecord_required: 'rerecord',
    selected: 'continue',
    retained_previous: 'continue',
    skipped: 'none',
    inconsistent: 'repair',
  } satisfies Record<ItemDisposition, RecommendedAction>)[disposition];
  const normalizedBlockers = unique(blockers);
  const normalizedWarnings = unique(warnings);
  return {
    itemId: item.id,
    disposition,
    recommendedAction,
    deliveryHealth: normalizedBlockers.length > 0
      || ['unrecorded', 'first_take_review', 'retake_review', 'rerecord_required', 'inconsistent'].includes(disposition)
      ? 'blocked'
      : normalizedWarnings.length > 0 || disposition === 'skipped'
        ? 'warning'
        : 'clear',
    selectedAttemptId: selected?.attempt_id ?? null,
    candidateAttemptId: candidate?.attempt_id ?? null,
    blockers: normalizedBlockers,
    warnings: normalizedWarnings,
  };
}

function exclusionReason(item: DerivedItemWorkflow): WorkflowReasonCode[] {
  if (item.blockers.length) return item.blockers;
  return ({
    unrecorded: ['unrecorded'],
    first_take_review: ['first_take_pending'],
    retake_review: ['retake_pending'],
    rerecord_required: ['rerecord_required'],
    skipped: ['skipped'],
    inconsistent: ['unknown_item_status'],
    selected: [],
    retained_previous: [],
  } satisfies Record<ItemDisposition, WorkflowReasonCode[]>)[item.disposition];
}

export function deriveDeliveryReadiness(
  derivedItems: readonly DerivedItemWorkflow[],
  scope: ExportScope,
  taskBlockers: readonly WorkflowReasonCode[] = [],
): DeliveryReadiness {
  const includedItemIds: string[] = [];
  const excluded: ScopeExclusion[] = [];
  const blockers: WorkflowReasonCode[] = [...taskBlockers];
  const warningCodes: WorkflowReasonCode[] = [];

  for (const item of derivedItems) {
    const deliverable = item.disposition === 'selected' || item.disposition === 'retained_previous';
    const hardInconsistency = item.disposition === 'inconsistent' || item.blockers.some((reason) => (
      !['unrecorded', 'first_take_pending', 'retake_pending', 'rerecord_required'].includes(reason)
    ));
    if (deliverable) {
      includedItemIds.push(item.itemId);
      warningCodes.push(...item.warnings);
      continue;
    }
    const reasons = exclusionReason(item);
    excluded.push({ itemId: item.itemId, reasons });
    if (scope === 'complete_task' || hardInconsistency) blockers.push(...reasons);
  }

  if (includedItemIds.length === 0) blockers.push('selected_missing');
  const normalizedBlockers = unique(blockers);
  const normalizedWarnings = unique(warningCodes);
  return {
    scope,
    ready: normalizedBlockers.length === 0,
    health: normalizedBlockers.length > 0 ? 'blocked' : normalizedWarnings.length > 0 ? 'warning' : 'clear',
    includedItemIds,
    excluded,
    blockers: normalizedBlockers,
    warningCodes: normalizedWarnings,
    requiresAcknowledgement: normalizedWarnings.length > 0,
  };
}

const EMPTY_COUNTS: Record<ItemDisposition, number> = {
  unrecorded: 0,
  first_take_review: 0,
  retake_review: 0,
  rerecord_required: 0,
  selected: 0,
  retained_previous: 0,
  skipped: 0,
  inconsistent: 0,
};

export function deriveTaskWorkflow(
  snapshot: Pick<SessionSnapshot, 'items' | 'committed_samples' | 'capture_provenance'>
    & Partial<Pick<SessionSnapshot, 'status' | 'overflow_samples' | 'silence_detector' | 'audio_format'>>,
): TaskWorkflowSummary {
  const seenItemIds = new Set<string>();
  const duplicateItemIds = new Set<string>();
  for (const item of snapshot.items) {
    if (typeof item.id !== 'string' || item.id.trim().length === 0) continue;
    if (seenItemIds.has(item.id)) duplicateItemIds.add(item.id);
    else seenItemIds.add(item.id);
  }
  const items = snapshot.items.map((item) => {
    const derived = deriveItemWorkflow(item, {
      committedSamples: snapshot.committed_samples,
      provenance: snapshot.capture_provenance,
      silenceDetector: snapshot.silence_detector,
    });
    if (!duplicateItemIds.has(item.id)) return derived;
    return {
      ...derived,
      disposition: 'inconsistent' as const,
      recommendedAction: 'repair' as const,
      deliveryHealth: 'blocked' as const,
      blockers: unique([...derived.blockers, 'item_id_invalid' as const]),
    };
  });
  const counts = items.reduce((result, item) => {
    result[item.disposition] += 1;
    return result;
  }, { ...EMPTY_COUNTS });
  const cutTaskBlockers: WorkflowReasonCode[] = [];
  if (snapshot.status !== 'stopped') cutTaskBlockers.push('task_not_stopped');
  if (snapshot.status === 'faulted'
    || !isSample(snapshot.overflow_samples)
    || snapshot.overflow_samples > 0) cutTaskBlockers.push('task_audio_fault');
  if (!taskProvenanceComplete(
    snapshot.committed_samples,
    snapshot.capture_provenance,
    snapshot.audio_format?.sample_rate,
  )) {
    cutTaskBlockers.push('task_provenance_incomplete');
  }
  return {
    items,
    counts,
    blockerCount: items.filter((item) => item.deliveryHealth === 'blocked').length,
    warningCount: items.filter((item) => item.deliveryHealth === 'warning').length,
    dataPreservation: deriveDataPreservationReadiness(snapshot),
    confirmedOnly: deriveDeliveryReadiness(items, 'confirmed_only', cutTaskBlockers),
    completeTask: deriveDeliveryReadiness(items, 'complete_task', cutTaskBlockers),
  };
}

const HEAD_TAIL_WARNING_CODES = new Set<WorkflowReasonCode>([
  'head_silence_short',
  'tail_silence_short',
]);

/**
 * Applies the task's operator-facing head/tail hint preference to derived UI
 * and cuts-readiness state. The engine's attempt metrics and journal remain
 * untouched; disabling the hint only removes the two corresponding warnings.
 */
export function applyHeadTailWarningPreference(
  summary: TaskWorkflowSummary,
  enabled: boolean,
): TaskWorkflowSummary {
  if (enabled) return summary;
  const keep = (code: WorkflowReasonCode) => !HEAD_TAIL_WARNING_CODES.has(code);
  const items = summary.items.map((item) => {
    const warnings = item.warnings.filter(keep);
    return {
      ...item,
      warnings,
      deliveryHealth: item.deliveryHealth === 'warning' && warnings.length === 0
        ? 'clear' as const
        : item.deliveryHealth,
    };
  });
  const filterReadiness = (readiness: DeliveryReadiness): DeliveryReadiness => {
    const warningCodes = readiness.warningCodes.filter(keep);
    return {
      ...readiness,
      warningCodes,
      health: readiness.blockers.length > 0
        ? 'blocked'
        : warningCodes.length > 0
          ? 'warning'
          : 'clear',
      requiresAcknowledgement: warningCodes.length > 0,
    };
  };
  return {
    ...summary,
    items,
    warningCount: items.filter((item) => item.deliveryHealth === 'warning').length,
    confirmedOnly: filterReadiness(summary.confirmedOnly),
    completeTask: filterReadiness(summary.completeTask),
  };
}

export function deriveDataPreservationReadiness(
  snapshot: Partial<Pick<SessionSnapshot, 'status' | 'overflow_samples'>>,
): TaskWorkflowSummary['dataPreservation'] {
  const blockers: WorkflowReasonCode[] = [];
  const warnings: WorkflowReasonCode[] = [];
  if (snapshot.status !== 'stopped' && snapshot.status !== 'faulted') {
    blockers.push('task_not_stopped');
  }
  if (!isSample(snapshot.overflow_samples)) {
    blockers.push('task_audio_fault');
  } else if (snapshot.status === 'faulted' || snapshot.overflow_samples > 0) {
    // Faulted tasks may still preserve and export the master track plus
    // diagnostics. This is an explicit warning, never a clean result.
    warnings.push('task_audio_fault');
  }
  return {
    ready: blockers.length === 0,
    health: blockers.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : 'clear',
    blockers: unique(blockers),
    warnings: unique(warnings),
  };
}

export function buildIssueWorkbench(
  summary: TaskWorkflowSummary,
  taskIssues: TaskLevelIssueInput = {},
): WorkbenchIssue[] {
  const issues: WorkbenchIssue[] = [];
  summary.items.forEach((item, itemIndex) => {
    const add = (kind: WorkbenchIssueKind, severity: IssueSeverity, reasons: WorkflowReasonCode[]) => {
      issues.push({
        // The task is fail-closed when sentence IDs collide, but the repair UI
        // still needs a stable, unique row for every affected physical item.
        id: `item:${itemIndex}:${item.itemId}:${kind}`,
        kind,
        severity,
        itemId: item.itemId,
        itemIndex,
        reasonCodes: reasons,
      });
    };
    if (item.disposition === 'first_take_review') add('first_take_review', 'blocker', ['first_take_pending']);
    if (item.disposition === 'retake_review') add('retake_review', 'blocker', ['retake_pending']);
    if (item.disposition === 'rerecord_required') add('rerecord_required', 'blocker', ['rerecord_required']);
    if (item.disposition === 'retained_previous') add('retained_previous', 'warning', ['retained_previous']);
    if (item.disposition === 'inconsistent') add('inconsistent', 'blocker', item.blockers);
    if (item.warnings.includes('head_silence_short')) add('head_silence_short', 'warning', ['head_silence_short']);
    if (item.warnings.includes('tail_silence_short')) add('tail_silence_short', 'warning', ['tail_silence_short']);
  });
  const addTaskIssue = (
    kind: WorkbenchIssueKind,
    severity: IssueSeverity,
    reasonCodes: WorkflowReasonCode[] = [],
  ) => {
    issues.push({ id: `task:${kind}`, kind, severity, itemId: null, itemIndex: null, reasonCodes });
  };
  if (taskIssues.captureFault) addTaskIssue('capture_fault', 'blocker');
  const provenanceIncomplete = summary.confirmedOnly.blockers.includes('task_provenance_incomplete');
  if (taskIssues.storageFault || provenanceIncomplete) {
    addTaskIssue(
      'storage_fault',
      'blocker',
      provenanceIncomplete ? ['task_provenance_incomplete'] : [],
    );
  }
  if (taskIssues.inputDiscontinuity) addTaskIssue('input_discontinuity', 'warning');
  if (taskIssues.vadHealth && taskIssues.vadHealth !== 'healthy') {
    addTaskIssue('vad_health', taskIssues.vadHealth === 'lagging' ? 'warning' : 'blocker');
  }
  if (typeof taskIssues.vadDiagnosticFaultCount === 'number'
    && taskIssues.vadDiagnosticFaultCount > 0) {
    addTaskIssue('vad_diagnostics', 'warning');
  }
  const priority = (issue: WorkbenchIssue) => {
    if (issue.severity === 'blocker' && issue.itemId === null) return 0;
    if (issue.severity === 'blocker') return 1;
    return 2;
  };
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((left, right) => priority(left.issue) - priority(right.issue) || left.index - right.index)
    .map(({ issue }) => issue);
}

export function filterWorkbenchIssues(
  issues: readonly WorkbenchIssue[],
  filter: IssueFilter,
): WorkbenchIssue[] {
  return filter === 'all' ? [...issues] : issues.filter((issue) => issue.severity === filter);
}

export function adjacentWorkbenchIssue(
  issues: readonly WorkbenchIssue[],
  currentIssueId: string | null,
  direction: 1 | -1,
): { issue: WorkbenchIssue | null; wrapped: boolean } {
  if (!issues.length) return { issue: null, wrapped: false };
  const currentIndex = currentIssueId ? issues.findIndex((issue) => issue.id === currentIssueId) : -1;
  if (currentIndex < 0) return { issue: direction === 1 ? issues[0] : issues[issues.length - 1], wrapped: false };
  const raw = currentIndex + direction;
  const wrapped = raw < 0 || raw >= issues.length;
  const index = (raw + issues.length) % issues.length;
  return { issue: issues[index] ?? null, wrapped };
}

/**
 * Keeps issue handling continuous without turning navigation into an implicit
 * recording action. When the selected issue disappears after a mutation, use
 * the first surviving issue that followed it in the previous queue; fall back
 * to the nearest preceding survivor, then the new queue head.
 */
export function nextWorkbenchIssueAfterResolution(
  previousIssues: readonly WorkbenchIssue[],
  resolvedIssueId: string | null,
  currentIssues: readonly WorkbenchIssue[],
): WorkbenchIssue | null {
  if (!currentIssues.length) return null;
  if (!resolvedIssueId) return currentIssues[0] ?? null;
  const stillSelected = currentIssues.find((issue) => issue.id === resolvedIssueId);
  if (stillSelected) return stillSelected;
  const previousIndex = previousIssues.findIndex((issue) => issue.id === resolvedIssueId);
  if (previousIndex < 0) return currentIssues[0] ?? null;
  const currentById = new Map(currentIssues.map((issue) => [issue.id, issue]));
  for (let index = previousIndex + 1; index < previousIssues.length; index += 1) {
    const survivor = currentById.get(previousIssues[index]?.id ?? '');
    if (survivor) return survivor;
  }
  for (let index = previousIndex - 1; index >= 0; index -= 1) {
    const survivor = currentById.get(previousIssues[index]?.id ?? '');
    if (survivor) return survivor;
  }
  return currentIssues[0] ?? null;
}

export type SetupReadinessIssue = 'engine' | 'script' | 'output' | 'capture';

export function setupReadinessIssues(input: {
  engineReady: boolean;
  scriptReady: boolean;
  outputReady: boolean;
  captureReady: boolean;
}): SetupReadinessIssue[] {
  const issues: SetupReadinessIssue[] = [];
  if (!input.engineReady) issues.push('engine');
  if (!input.scriptReady) issues.push('script');
  if (!input.captureReady) issues.push('capture');
  if (!input.outputReady) issues.push('output');
  return issues;
}

export function normalizeWarningAcknowledgements(
  readiness: DeliveryReadiness,
  acknowledged: readonly string[],
): QualityIssueCode[] | WorkflowReasonCode[] {
  const expected = new Set(readiness.warningCodes);
  return unique(acknowledged.filter((code): code is WorkflowReasonCode => expected.has(code as WorkflowReasonCode)));
}
