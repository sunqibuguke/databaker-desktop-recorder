export type HistoryDeliveryHealth = 'clear' | 'warning' | 'blocked';

export type HistoryDeliveryReadiness = Readonly<{
  ready: boolean;
  health: HistoryDeliveryHealth;
  included_items: number;
  excluded_items: number;
  blocker_count: number;
  warning_count: number;
}>;

export type HistoryWorkflowSummary = Readonly<{
  blocker_items: number;
  warning_items: number;
  confirmed_only_readiness: HistoryDeliveryReadiness;
  complete_task_readiness: HistoryDeliveryReadiness;
}>;

type Reason =
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

type Disposition =
  | 'unrecorded'
  | 'first_take_review'
  | 'retake_review'
  | 'rerecord_required'
  | 'selected'
  | 'retained_previous'
  | 'skipped'
  | 'inconsistent';

type DerivedItem = Readonly<{
  disposition: Disposition;
  blockers: readonly Reason[];
  warnings: readonly Reason[];
}>;

const ITEM_STATUSES = new Set(['pending', 'review', 'accepted', 'skipped']);
const ATTEMPT_STATUSES = new Set([
  'recorded',
  'accepted',
  'rejected_by_operator',
  'interrupted',
  'needs_rerecord',
]);
const QUALITY_ISSUES = new Set([
  'input_discontinuity',
  'vad_queue_overflow',
  'vad_classifier_failure',
  'vad_flush_timeout',
  'vad_worker_disconnected',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function safeSample(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasHistoricalVadDiagnosticWarning(snapshot: Record<string, unknown>): boolean {
  if (snapshot.vad_diagnostics === undefined) return false;
  const diagnostics = record(snapshot.vad_diagnostics);
  if (!diagnostics) return true;
  const faultCounters = [
    'overflow_count',
    'dropped_samples',
    'classifier_failure_count',
    'flush_timeout_count',
    'worker_disconnect_count',
  ] as const;
  return faultCounters.some((key) => {
    const value = diagnostics[key];
    return value !== undefined && (!safeSample(value) || value > 0);
  });
}

function attemptId(attempt: Record<string, unknown> | undefined): string | null {
  return typeof attempt?.attempt_id === 'string' && attempt.attempt_id.trim().length > 0
    ? attempt.attempt_id
    : null;
}

function qualityIssues(attempt: Record<string, unknown>): unknown[] | null {
  if (attempt.quality_issues === undefined) return [];
  return Array.isArray(attempt.quality_issues) ? attempt.quality_issues : null;
}

function issueCodeKnown(issue: unknown): boolean {
  const value = record(issue);
  return Boolean(value && typeof value.code === 'string' && QUALITY_ISSUES.has(value.code));
}

function attemptStructuralReasons(
  attempt: Record<string, unknown>,
  committedSamples: number,
  silenceDetector: unknown = 'energy',
): Reason[] {
  const reasons: Reason[] = [];
  if (!attemptId(attempt)) reasons.push('attempt_id_invalid');
  const abnormal = attempt.status === 'interrupted' || attempt.status === 'needs_rerecord';
  const required = [
    attempt.start_sample,
    attempt.recording_started_sample,
    attempt.content_started_sample,
    attempt.end_sample,
  ];
  const optional = [
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
  const validCompletedStart = safeSample(attempt.start_sample)
    && safeSample(attempt.recording_started_sample)
    && safeSample(attempt.content_started_sample)
    && safeSample(headSilencePassedSample)
    && safeSample(requiredHeadSilenceSamples)
    && (attempt.start_sample === attempt.recording_started_sample
      || attempt.start_sample === headSilencePassedSample
      || (silenceDetector === 'vad'
        && attempt.content_started_sample !== 0
        && attempt.start_sample === Math.max(
          attempt.content_started_sample - requiredHeadSilenceSamples,
          attempt.recording_started_sample,
        )));
  const headSilenceContractInvalid = safeSample(headSilenceArmedSample)
    && safeSample(headSilencePassedSample)
    && safeSample(requiredHeadSilenceSamples)
    && (headSilencePassedSample === 0
      ? !abnormalAttempt && (headSilenceArmedSample !== 0 || requiredHeadSilenceSamples !== 0)
      : !abnormalAttempt && (
        headSilenceArmedSample > headSilencePassedSample
        || requiredHeadSilenceSamples === 0
        || headSilencePassedSample - headSilenceArmedSample < requiredHeadSilenceSamples
        || attempt.recording_started_sample !== headSilenceArmedSample
        || !validCompletedStart
      ));
  if (required.some((value) => !safeSample(value))
    || optional.some((value) => !safeSample(value))
    || (safeSample(attempt.start_sample)
      && safeSample(attempt.end_sample)
      && (abnormal
        ? attempt.end_sample < attempt.start_sample
        : attempt.end_sample <= attempt.start_sample))
    || (safeSample(attempt.start_sample)
      && safeSample(attempt.recording_started_sample)
      && safeSample(attempt.end_sample)
      && (attempt.start_sample < attempt.recording_started_sample
        || attempt.recording_started_sample > attempt.end_sample))
    || (safeSample(attempt.recording_started_sample)
      && safeSample(attempt.start_sample)
      && safeSample(attempt.content_started_sample)
      && safeSample(attempt.end_sample)
      && attempt.content_started_sample !== 0
      && (attempt.content_started_sample < attempt.start_sample
        || attempt.content_started_sample < attempt.recording_started_sample
        || attempt.content_started_sample > attempt.end_sample))
    || (safeSample(headSilenceArmedSample)
      && safeSample(attempt.recording_started_sample)
      && safeSample(attempt.end_sample)
      && headSilenceArmedSample !== 0
      && (headSilenceArmedSample < attempt.recording_started_sample
        || headSilenceArmedSample > attempt.end_sample))
    || (safeSample(headSilenceArmedSample)
      && safeSample(headSilencePassedSample)
      && safeSample(attempt.end_sample)
      && headSilencePassedSample !== 0
      && (headSilencePassedSample < headSilenceArmedSample
        || headSilencePassedSample > attempt.end_sample))
    || headSilenceContractInvalid) {
    reasons.push('selected_range_invalid');
  }
  if (!safeSample(committedSamples)
    || required.some((value) => safeSample(value) && value > committedSamples)
    || optional.some((value) => safeSample(value) && value > committedSamples)) {
    reasons.push('selected_beyond_committed');
  }
  const issues = qualityIssues(attempt);
  if (issues === null) {
    reasons.push('quality_issue_range_invalid');
  } else {
    for (const rawIssue of issues) {
      const issue = record(rawIssue);
      if (!issue) {
        reasons.push('quality_issue_range_invalid');
        continue;
      }
      const start = issue.start_sample;
      const end = issue.end_sample;
      const generation = issue.detector_generation;
      const hasStart = start !== undefined;
      const hasEnd = end !== undefined;
      if (hasStart !== hasEnd
        || (hasStart && (!safeSample(start)
          || !safeSample(end)
          || Number(start) > Number(end)
          || !safeSample(attempt.recording_started_sample)
          || Number(start) < Number(attempt.recording_started_sample)
          || !safeSample(attempt.end_sample)
          || Number(end) > Number(attempt.end_sample)))
        || (generation !== undefined && !safeSample(generation))) {
        reasons.push('quality_issue_range_invalid');
      }
    }
  }
  return unique(reasons);
}

function rangeCoveredByProvenance(
  start: number,
  end: number,
  provenance: readonly Record<string, unknown>[] | null,
): boolean {
  if (!provenance?.length) return false;
  const spans: Array<{ start: number; end: number }> = [];
  for (const raw of provenance) {
    if (!safeSample(raw.start_sample)
      || !safeSample(raw.end_sample)
      // Resume appends an empty tail span before the new activation writes
      // audio. Ignore that non-covering marker without invalidating history.
      || raw.end_sample < raw.start_sample) return false;
    spans.push({ start: raw.start_sample, end: raw.end_sample });
  }
  spans.sort((left, right) => left.start - right.start);
  let cursor = start;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    if (span.start > cursor) return false;
    cursor = Math.max(cursor, span.end);
    if (cursor >= end) return true;
  }
  return false;
}

function fullTrackCoveredByProvenance(
  committedSamples: number,
  provenance: readonly Record<string, unknown>[] | null,
  expectedSampleRate: unknown,
): boolean {
  if (!safeSample(committedSamples)) return false;
  if (!provenance) return committedSamples === 0;
  if (provenance.length > 0 && (!safeSample(expectedSampleRate) || expectedSampleRate === 0)) {
    return false;
  }
  let cursor = 0;
  for (const span of provenance) {
    if (!safeSample(span.start_sample)
      || !safeSample(span.end_sample)
      || span.start_sample !== cursor
      || span.end_sample < span.start_sample
      || span.end_sample > committedSamples
      || span.sample_rate !== expectedSampleRate
      || typeof span.input_sample_format !== 'string'
      || span.input_sample_format.trim().length === 0
      || !safeSample(span.input_channels)
      || span.input_channels === 0
      || !safeSample(span.input_channel)
      || span.input_channel === 0
      || span.input_channel > span.input_channels) return false;
    cursor = span.end_sample;
  }
  return cursor === committedSamples;
}

function attemptSafetyReasons(
  attempt: Record<string, unknown>,
  committedSamples: number,
  provenance: readonly Record<string, unknown>[] | null,
  requireAccepted: boolean,
  silenceDetector: unknown,
): Reason[] {
  const reasons: Reason[] = attemptStructuralReasons(attempt, committedSamples, silenceDetector);
  if (typeof attempt.status !== 'string' || !ATTEMPT_STATUSES.has(attempt.status)) {
    reasons.push('unknown_attempt_status');
  }
  if (requireAccepted && attempt.status !== 'accepted') reasons.push('selected_not_accepted');
  const validRange = safeSample(attempt.start_sample)
    && safeSample(attempt.end_sample)
    && attempt.end_sample > attempt.start_sample;
  if (validRange && !rangeCoveredByProvenance(
    attempt.start_sample as number,
    attempt.end_sample as number,
    provenance,
  )) reasons.push('selected_provenance_gap');
  const issues = qualityIssues(attempt);
  if (issues === null || issues.some((issue) => !issueCodeKnown(issue))) {
    reasons.push('unknown_quality_issue');
  }
  if ((issues?.length ?? 0) > 0
    || attempt.status === 'interrupted'
    || attempt.status === 'needs_rerecord') {
    reasons.push('selected_quality_issue');
  }
  return unique(reasons);
}

function silenceWarnings(attempt: Record<string, unknown> | undefined): Reason[] {
  if (!attempt) return [];
  const warnings: Reason[] = [];
  if (safeSample(attempt.required_head_silence_samples)
    && attempt.required_head_silence_samples > 0
    && safeSample(attempt.content_started_sample)
    && attempt.content_started_sample > 0
    && safeSample(attempt.recording_started_sample)
    && attempt.content_started_sample - attempt.recording_started_sample
      < attempt.required_head_silence_samples) warnings.push('head_silence_short');
  if (safeSample(attempt.required_tail_silence_samples)
    && attempt.required_tail_silence_samples > 0
    && (!safeSample(attempt.tail_silence_samples)
      || attempt.tail_silence_samples < attempt.required_tail_silence_samples)) {
    warnings.push('tail_silence_short');
  }
  return warnings;
}

function deriveItem(
  rawItem: unknown,
  committedSamples: number,
  provenance: readonly Record<string, unknown>[] | null,
  silenceDetector: unknown,
): DerivedItem {
  const item = record(rawItem);
  if (!item) return { disposition: 'inconsistent', blockers: ['unknown_item_status'], warnings: [] };
  const blockers: Reason[] = [];
  const warnings: Reason[] = [];
  const attempts = Array.isArray(item.attempts)
    ? item.attempts.map(record)
    : [];
  if (!Array.isArray(item.attempts) || attempts.some((attempt) => !attempt)) {
    blockers.push('unknown_attempt_status');
  }
  const validAttempts = attempts.filter((attempt): attempt is Record<string, unknown> => Boolean(attempt));
  if (typeof item.id !== 'string' || item.id.trim().length === 0) {
    blockers.push('item_id_invalid');
  }
  if (typeof item.status !== 'string' || !ITEM_STATUSES.has(item.status)) {
    blockers.push('unknown_item_status');
  }
  const seenAttemptIds = new Set<string>();
  if (validAttempts.some((attempt) => {
    const id = attemptId(attempt);
    if (!id || seenAttemptIds.has(id)) return true;
    seenAttemptIds.add(id);
    return false;
  })) blockers.push('attempt_id_invalid');
  if (validAttempts.some((attempt) => (
    typeof attempt.status !== 'string' || !ATTEMPT_STATUSES.has(attempt.status)
  ))) blockers.push('unknown_attempt_status');
  if (validAttempts.some((attempt) => {
    const issues = qualityIssues(attempt);
    return issues === null || issues.some((issue) => !issueCodeKnown(issue));
  })) blockers.push('unknown_quality_issue');
  for (const attempt of validAttempts) {
    blockers.push(...attemptStructuralReasons(attempt, committedSamples, silenceDetector));
  }

  const selectedId = typeof item.selected_attempt_id === 'string' && item.selected_attempt_id
    ? item.selected_attempt_id
    : null;
  const selected = selectedId
    ? validAttempts.find((attempt) => attemptId(attempt) === selectedId)
    : undefined;
  let candidate: Record<string, unknown> | undefined;
  for (let index = validAttempts.length - 1; index >= 0; index -= 1) {
    if (validAttempts[index].status === 'recorded') {
      candidate = validAttempts[index];
      break;
    }
  }
  const latest = validAttempts.at(-1);
  if (selectedId && !selected) blockers.push('selected_not_found');
  if ((item.status === 'pending' || item.status === 'skipped') && selectedId) {
    blockers.push('selected_not_accepted');
  }
  if ((item.status === 'accepted' || item.status === 'review') && selectedId && selected) {
    blockers.push(...attemptSafetyReasons(
      selected,
      committedSamples,
      provenance,
      true,
      silenceDetector,
    ));
  }
  if (item.status === 'accepted' && !selectedId) blockers.push('selected_missing');
  const acceptedAttemptCount = validAttempts
    .filter((attempt) => attempt.status === 'accepted').length;
  if (selected && acceptedAttemptCount !== 1) blockers.push('multiple_accepted_attempts');
  if (item.status === 'accepted' && candidate) blockers.push('accepted_has_recorded_candidate');

  let disposition: Disposition;
  if (blockers.length > 0) disposition = 'inconsistent';
  else if (item.status === 'skipped') disposition = 'skipped';
  else if (item.status === 'accepted'
    && latest?.status === 'needs_rerecord'
    && selected?.status === 'accepted') {
    disposition = 'retained_previous';
    warnings.push('retained_previous', ...silenceWarnings(selected));
  } else if (latest?.status === 'needs_rerecord') disposition = 'rerecord_required';
  else if (item.status === 'review'
    && candidate
    && selected?.status === 'accepted'
    && attemptId(selected) !== attemptId(candidate)) disposition = 'retake_review';
  else if (item.status === 'review' && candidate) disposition = 'first_take_review';
  else if (item.status === 'accepted' && selected?.status === 'accepted') {
    disposition = 'selected';
    warnings.push(...silenceWarnings(selected));
  } else if (item.status === 'pending' && !selectedId) disposition = 'unrecorded';
  else disposition = 'inconsistent';
  if (disposition === 'inconsistent' && blockers.length === 0) blockers.push('unknown_item_status');
  return { disposition, blockers: unique(blockers), warnings: unique(warnings) };
}

function exclusionReasons(item: DerivedItem): Reason[] {
  if (item.blockers.length) return [...item.blockers];
  switch (item.disposition) {
    case 'unrecorded': return ['unrecorded'];
    case 'first_take_review': return ['first_take_pending'];
    case 'retake_review': return ['retake_pending'];
    case 'rerecord_required': return ['rerecord_required'];
    case 'skipped': return ['skipped'];
    case 'inconsistent': return ['unknown_item_status'];
    default: return [];
  }
}

function readiness(
  items: readonly DerivedItem[],
  scope: 'confirmed_only' | 'complete_task',
  taskBlockers: readonly Reason[],
): HistoryDeliveryReadiness {
  let includedItems = 0;
  let excludedItems = 0;
  const blockers: Reason[] = [...taskBlockers];
  const warnings: Reason[] = [];
  for (const item of items) {
    const deliverable = item.disposition === 'selected' || item.disposition === 'retained_previous';
    const hardInconsistency = item.disposition === 'inconsistent' || item.blockers.some((reason) => (
      !['unrecorded', 'first_take_pending', 'retake_pending', 'rerecord_required'].includes(reason)
    ));
    if (deliverable) {
      includedItems += 1;
      warnings.push(...item.warnings);
    } else {
      excludedItems += 1;
      if (scope === 'complete_task' || hardInconsistency) blockers.push(...exclusionReasons(item));
    }
  }
  if (includedItems === 0) blockers.push('selected_missing');
  const normalizedBlockers = unique(blockers);
  const normalizedWarnings = unique(warnings);
  return {
    ready: normalizedBlockers.length === 0,
    health: normalizedBlockers.length > 0
      ? 'blocked'
      : normalizedWarnings.length > 0 ? 'warning' : 'clear',
    included_items: includedItems,
    excluded_items: excludedItems,
    blocker_count: normalizedBlockers.length,
    warning_count: normalizedWarnings.length,
  };
}

export function deriveHistoryWorkflowSummary(snapshotValue: unknown): HistoryWorkflowSummary {
  const snapshot = record(snapshotValue);
  if (!snapshot || !Array.isArray(snapshot.items) || !safeSample(snapshot.committed_samples)) {
    const blocked: HistoryDeliveryReadiness = {
      ready: false,
      health: 'blocked',
      included_items: 0,
      excluded_items: Array.isArray(snapshot?.items) ? snapshot.items.length : 0,
      blocker_count: 1,
      warning_count: 0,
    };
    return {
      blocker_items: Array.isArray(snapshot?.items) ? snapshot.items.length : 1,
      warning_items: 0,
      confirmed_only_readiness: blocked,
      complete_task_readiness: blocked,
    };
  }
  let provenance: readonly Record<string, unknown>[] | null;
  if (snapshot.capture_provenance === undefined) {
    provenance = null;
  } else if (Array.isArray(snapshot.capture_provenance)) {
    const parsed = snapshot.capture_provenance.map(record);
    provenance = parsed.some((span) => !span)
      ? null
      : parsed as Record<string, unknown>[];
  } else {
    provenance = null;
  }
  const seenItemIds = new Set<string>();
  const duplicateItemIds = new Set<string>();
  for (const rawItem of snapshot.items) {
    const item = record(rawItem);
    if (!item || typeof item.id !== 'string' || item.id.trim().length === 0) continue;
    if (seenItemIds.has(item.id)) duplicateItemIds.add(item.id);
    else seenItemIds.add(item.id);
  }
  const items = snapshot.items.map((rawItem) => {
    const derived = deriveItem(
      rawItem,
      snapshot.committed_samples as number,
      provenance,
      snapshot.silence_detector,
    );
    const item = record(rawItem);
    if (!item || typeof item.id !== 'string' || !duplicateItemIds.has(item.id)) return derived;
    return {
      disposition: 'inconsistent' as const,
      blockers: unique([...derived.blockers, 'item_id_invalid' as const]),
      warnings: derived.warnings,
    };
  });
  const taskBlockers: Reason[] = [];
  if (snapshot.status !== 'stopped') taskBlockers.push('task_not_stopped');
  if (snapshot.audio_fault_marker === true
    || !safeSample(snapshot.overflow_samples)
    || snapshot.overflow_samples !== 0) taskBlockers.push('task_audio_fault');
  const audioFormat = record(snapshot.audio_format);
  if (!fullTrackCoveredByProvenance(
    snapshot.committed_samples as number,
    provenance,
    audioFormat?.sample_rate,
  )) taskBlockers.push('task_provenance_incomplete');
  const taskWarningCount = hasHistoricalVadDiagnosticWarning(snapshot) ? 1 : 0;
  return {
    blocker_items: items.filter((item) => item.blockers.length > 0
      || ['unrecorded', 'first_take_review', 'retake_review', 'rerecord_required', 'inconsistent']
        .includes(item.disposition)).length,
    warning_items: items.filter((item) => item.blockers.length === 0
      && (item.warnings.length > 0 || item.disposition === 'skipped')).length
      + taskWarningCount,
    confirmed_only_readiness: readiness(items, 'confirmed_only', taskBlockers),
    complete_task_readiness: readiness(items, 'complete_task', taskBlockers),
  };
}
