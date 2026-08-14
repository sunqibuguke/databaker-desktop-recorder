import { t } from '../shared/i18n/index.ts';
import { loadAutomationRules, saveAutomationRules } from './automation-rules.ts';
import type { Attempt, HeadSilencePhase, ItemState } from './types';

export type SilencePadStatus = 'unknown' | 'short' | 'met';

export type SilencePairView = {
  headText: string;
  tailText: string;
  headWarn: boolean;
  tailMet: boolean;
  headStatus: SilencePadStatus;
  tailStatus: SilencePadStatus;
  hint: string;
  extra: string;
};

export type ItemSilenceMarks = {
  headShort: boolean;
  tailShort: boolean;
  title: string;
};

const EMPTY_SILENCE_MARKS: ItemSilenceMarks = { headShort: false, tailShort: false, title: '' };

function emptySilencePair(): SilencePairView {
  return {
    headText: t('silence.headDash'),
    tailText: t('silence.tailDash'),
    headWarn: false,
    tailMet: false,
    headStatus: 'unknown',
    tailStatus: 'unknown',
    hint: '',
    extra: '',
  };
}

export function samplesToMs(samples: number, sampleRate: number): number {
  if (!Number.isFinite(samples) || samples <= 0) return 0;
  return Math.round(samples / Math.max(sampleRate, 1) * 1_000);
}

export function formatSilenceMs(ms: number): string {
  return `${Math.max(0, Math.round(ms))} ms`;
}

export function formatWaitSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1_000).toFixed(1)} s`;
}

export function actualHeadSilenceMs(
  startSample: number,
  contentStartedSample: number,
  sampleRate: number,
): number | null {
  if (!contentStartedSample || contentStartedSample <= 0) return null;
  return samplesToMs(Math.max(0, contentStartedSample - Math.max(0, startSample)), sampleRate);
}

export function isHeadSilenceShort(headMs: number | null, requiredMs: number): boolean {
  return headMs !== null && requiredMs > 0 && headMs < requiredMs;
}

export function isTailSilenceShort(tailMs: number | null, requiredMs: number): boolean {
  return tailMs !== null && requiredMs > 0 && tailMs < requiredMs;
}

export function silenceReadoutClass(status: SilencePadStatus): string {
  if (status === 'met') return 'silence-readout met';
  if (status === 'short') return 'silence-readout short';
  return 'silence-readout';
}

export function padStatus(measuredMs: number | null, requiredMs: number): SilencePadStatus {
  if (measuredMs === null) return 'unknown';
  if (requiredMs <= 0) return 'unknown';
  return measuredMs < requiredMs ? 'short' : 'met';
}

function isUsableAttempt(attempt: Attempt): boolean {
  return !['interrupted', 'needs_rerecord'].includes(attempt.status)
    && attempt.end_sample > attempt.start_sample;
}

export function selectedOrLatestUsableAttempt(item: ItemState): Attempt | undefined {
  const selected = item.selected_attempt_id
    ? item.attempts.find((attempt) => attempt.attempt_id === item.selected_attempt_id)
    : undefined;
  if (selected && isUsableAttempt(selected)) return selected;
  for (let index = item.attempts.length - 1; index >= 0; index -= 1) {
    if (isUsableAttempt(item.attempts[index])) return item.attempts[index];
  }
  return undefined;
}

function attemptTailMs(attempt: Attempt, sampleRate: number): number | null {
  return attempt.tail_silence_samples === undefined
    ? null
    : samplesToMs(attempt.tail_silence_samples, sampleRate);
}

function attemptTailIsShort(attempt: Attempt, tailMs: number | null, requiredMs: number): boolean {
  return attempt.forced_without_tail_silence === true || isTailSilenceShort(tailMs, requiredMs);
}

export function itemSilenceMarks(
  item: ItemState | null | undefined,
  sampleRate: number,
  requiredMs: number,
): ItemSilenceMarks {
  if (!item || (item.status !== 'review' && item.status !== 'accepted')) return EMPTY_SILENCE_MARKS;
  const attempt = selectedOrLatestUsableAttempt(item);
  if (!attempt) return EMPTY_SILENCE_MARKS;
  const start = attempt.recording_started_sample || attempt.start_sample || 0;
  const headMs = actualHeadSilenceMs(start, attempt.content_started_sample, sampleRate);
  const tailMs = attemptTailMs(attempt, sampleRate);
  const headShort = isHeadSilenceShort(headMs, requiredMs);
  const tailShort = attemptTailIsShort(attempt, tailMs, requiredMs);
  if (!headShort && !tailShort) return EMPTY_SILENCE_MARKS;
  const requiredLabel = `${(Math.max(0, requiredMs) / 1_000).toFixed(1)} s`;
  const headLabel = headMs === null ? t('common.dash') : formatSilenceMs(headMs);
  const tailLabel = tailMs === null ? t('common.dash') : formatSilenceMs(tailMs);
  const title = headShort && tailShort
    ? t('silence.markBothTitle', { head: headLabel, tail: tailLabel, required: requiredLabel })
    : headShort
      ? t('silence.markHeadTitle', { ms: headLabel, required: requiredLabel })
      : t('silence.markTailTitle', { ms: tailLabel, required: requiredLabel });
  return { headShort, tailShort, title };
}

export function peakNoteFromLevel(peak: number | undefined): 'clip' | 'quiet' | null {
  if (peak === undefined || !Number.isFinite(peak) || peak <= 0) return null;
  if (peak > 0.92) return 'clip';
  if (peak < 0.04) return 'quiet';
  return null;
}

export function liveSilencePair(input: {
  recording: boolean;
  pending: boolean;
  spoken: boolean;
  pendingRemainingMs: number;
  requiredMs: number;
  liveSilenceMs: number;
  headMs: number | null;
}): SilencePairView {
  const required = Math.max(0, input.requiredMs);
  if (!input.recording) return emptySilencePair();
  if (input.spoken) {
    const tailMs = Math.max(0, input.liveSilenceMs);
    const tailStatus = padStatus(tailMs, required);
    const headStatus = padStatus(input.headMs, required);
    return {
      headText: input.headMs === null ? t('silence.headDash') : t('silence.headMs', { ms: formatSilenceMs(input.headMs) }),
      tailText: tailStatus === 'met'
        ? t('silence.tailEnough', { ms: formatSilenceMs(tailMs) })
        : t('silence.tailProgress', { ms: formatSilenceMs(tailMs), required: formatSilenceMs(required) }),
      headWarn: headStatus === 'short',
      tailMet: tailStatus === 'met',
      headStatus,
      tailStatus,
      hint: '',
      extra: '',
    };
  }
  if (input.pending) {
    return {
      ...emptySilencePair(),
      headText: t('silence.waiting', { seconds: formatWaitSeconds(input.pendingRemainingMs) }),
    };
  }
  return {
    ...emptySilencePair(),
    headText: t('silence.pleaseRead'),
  };
}

export function peakFromWaveformBins(bins: Array<[number, number]> | undefined): number {
  if (!bins?.length) return 0;
  let peak = 0;
  for (const [minimum, maximum] of bins) {
    if (Number.isFinite(minimum)) peak = Math.max(peak, Math.abs(minimum));
    if (Number.isFinite(maximum)) peak = Math.max(peak, Math.abs(maximum));
  }
  return peak;
}

export function takeReviewPeak(input: {
  livePeak?: number;
  storedPeak?: number;
  waveformBins?: Array<[number, number]>;
}): number {
  return Math.max(
    peakFromWaveformBins(input.waveformBins),
    Number.isFinite(input.storedPeak) ? Number(input.storedPeak) : 0,
    Number.isFinite(input.livePeak) ? Number(input.livePeak) : 0,
  );
}

export function reviewSilencePair(input: {
  attempt: Attempt | null | undefined;
  sampleRate: number;
  requiredMs: number;
  peak?: number;
  showHeadTailHints?: boolean;
  showAlmostSilent?: boolean;
  showPeakHigh?: boolean;
}): SilencePairView {
  const required = Math.max(0, input.requiredMs);
  const attempt = input.attempt;
  if (!attempt) return emptySilencePair();
  const start = attempt.recording_started_sample || attempt.start_sample || 0;
  const headMs = actualHeadSilenceMs(start, attempt.content_started_sample, input.sampleRate);
  const tailMs = attemptTailMs(attempt, input.sampleRate);
  const headStatus = padStatus(headMs, required);
  const tailStatus = attempt.forced_without_tail_silence === true
    ? 'short'
    : padStatus(tailMs, required);
  const showHeadTailHints = input.showHeadTailHints !== false;
  const headShort = showHeadTailHints && headStatus === 'short';
  const tailShort = showHeadTailHints && tailStatus === 'short';
  const note = peakNoteFromLevel(input.peak);
  const extra = note === 'clip' && input.showPeakHigh
    ? t('silence.peakHigh')
    : note === 'quiet' && input.showAlmostSilent
      ? t('silence.almostSilent')
      : '';
  const requiredLabel = `${(required / 1_000).toFixed(1)} s`;
  let hint = '';
  if (headShort && tailShort) hint = t('silence.hintBoth', { required: requiredLabel });
  else if (headShort) hint = t('silence.hintHead', { required: requiredLabel });
  else if (tailShort) hint = t('silence.hintTail', { required: requiredLabel });
  return {
    headText: headMs === null ? t('silence.headDash') : t('silence.headMs', { ms: formatSilenceMs(headMs) }),
    tailText: tailMs === null ? t('silence.tailDash') : t('silence.tailMs', { ms: formatSilenceMs(tailMs) }),
    headWarn: headShort,
    tailMet: tailStatus === 'met',
    headStatus,
    tailStatus,
    hint,
    extra,
  };
}

export type LiveSilenceHintView = {
  text: string;
  met: boolean;
  progress: number;
};

export function liveSilenceHint(input: {
  liveMs: number;
  requiredMs: number;
}): LiveSilenceHintView {
  const liveMs = Math.max(0, Math.round(Number.isFinite(input.liveMs) ? input.liveMs : 0));
  const requiredMs = Math.max(0, Math.round(Number.isFinite(input.requiredMs) ? input.requiredMs : 0));
  return {
    text: t('recorder.silenceLive', { ms: liveMs, required: requiredMs }),
    met: requiredMs > 0 && liveMs >= requiredMs,
    progress: requiredMs > 0 ? Math.min(1, liveMs / requiredMs) : 0,
  };
}

export function liveHeadMsFromMeter(input: {
  sampleRate: number;
  armedSample: number;
  contentStartedSample: number;
  phase?: HeadSilencePhase;
}): number | null {
  if ((input.contentStartedSample ?? 0) <= 0 && input.phase !== 'speech_started') return null;
  return actualHeadSilenceMs(input.armedSample, input.contentStartedSample, input.sampleRate);
}

export function shouldUseRecordedSilencePair(
  recording: boolean,
  attempt: Attempt | null | undefined,
): boolean {
  return !recording && Boolean(attempt);
}

export function recordedMonitorSentenceLabel(input: {
  liveCue: string;
  itemStatus?: string | null;
  liveLabel: string;
}): string {
  if (input.liveCue !== 'idle' && input.liveCue !== 'review') return input.liveLabel;
  if (input.itemStatus === 'accepted') return t('itemStatus.accepted');
  if (input.itemStatus === 'skipped') return t('itemStatus.skipped');
  if (input.itemStatus === 'review') return t('cue.recorded');
  return input.liveLabel;
}

export function loadPostTakeSilenceReview(sessionDir: string): boolean {
  return loadAutomationRules(sessionDir).headTailSilence;
}

export function savePostTakeSilenceReview(sessionDir: string, enabled: boolean): void {
  const current = loadAutomationRules(sessionDir);
  saveAutomationRules(sessionDir, { ...current, headTailSilence: enabled });
}
