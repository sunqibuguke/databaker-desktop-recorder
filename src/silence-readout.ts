import { t } from '../shared/i18n/index.ts';
import type { Attempt, HeadSilencePhase } from './types';

export type SilencePairView = {
  headText: string;
  tailText: string;
  headWarn: boolean;
  tailMet: boolean;
  hint: string;
  extra: string;
};

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
  if (!input.recording) {
    return {
      headText: t('silence.headDash'),
      tailText: t('silence.tailDash'),
      headWarn: false,
      tailMet: false,
      hint: '',
      extra: '',
    };
  }
  if (input.spoken) {
    const tailMs = Math.max(0, input.liveSilenceMs);
    const met = required > 0 && tailMs >= required;
    return {
      headText: input.headMs === null ? t('silence.headDash') : t('silence.headMs', { ms: formatSilenceMs(input.headMs) }),
      tailText: met
        ? t('silence.tailEnough', { ms: formatSilenceMs(tailMs) })
        : t('silence.tailProgress', { ms: formatSilenceMs(tailMs), required: formatSilenceMs(required) }),
      headWarn: isHeadSilenceShort(input.headMs, required),
      tailMet: met,
      hint: '',
      extra: '',
    };
  }
  if (input.pending) {
    return {
      headText: t('silence.waiting', { seconds: formatWaitSeconds(input.pendingRemainingMs) }),
      tailText: t('silence.tailDash'),
      headWarn: false,
      tailMet: false,
      hint: '',
      extra: '',
    };
  }
  return {
    headText: t('silence.pleaseRead'),
    tailText: t('silence.tailDash'),
    headWarn: false,
    tailMet: false,
    hint: '',
    extra: '',
  };
}

export function reviewSilencePair(input: {
  attempt: Attempt | null | undefined;
  sampleRate: number;
  requiredMs: number;
  peak?: number;
}): SilencePairView {
  const required = Math.max(0, input.requiredMs);
  const attempt = input.attempt;
  if (!attempt) {
    return {
      headText: t('silence.headDash'),
      tailText: t('silence.tailDash'),
      headWarn: false,
      tailMet: false,
      hint: '',
      extra: '',
    };
  }
  const start = attempt.recording_started_sample || attempt.start_sample || 0;
  const headMs = actualHeadSilenceMs(start, attempt.content_started_sample, input.sampleRate);
  const tailMs = attempt.tail_silence_samples === undefined
    ? null
    : samplesToMs(attempt.tail_silence_samples, input.sampleRate);
  const headShort = isHeadSilenceShort(headMs, required);
  const tailShort = attempt.forced_without_tail_silence === true
    || isTailSilenceShort(tailMs, required);
  const note = peakNoteFromLevel(input.peak);
  const extra = note === 'clip' ? t('silence.peakHigh') : note === 'quiet' ? t('silence.almostSilent') : '';
  const requiredLabel = `${(required / 1_000).toFixed(1)} s`;
  let hint = '';
  if (headShort && tailShort) hint = t('silence.hintBoth', { required: requiredLabel });
  else if (headShort) hint = t('silence.hintHead', { required: requiredLabel });
  else if (tailShort) hint = t('silence.hintTail', { required: requiredLabel });
  return {
    headText: headMs === null ? t('silence.headDash') : t('silence.headMs', { ms: formatSilenceMs(headMs) }),
    tailText: tailMs === null ? t('silence.tailDash') : t('silence.tailMs', { ms: formatSilenceMs(tailMs) }),
    headWarn: headShort,
    tailMet: !tailShort && tailMs !== null,
    hint,
    extra,
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

const POST_TAKE_STORAGE_PREFIX = 'databaker:post-take-silence:';

export function loadPostTakeSilenceReview(sessionDir: string): boolean {
  if (!sessionDir) return true;
  try {
    const stored = localStorage.getItem(`${POST_TAKE_STORAGE_PREFIX}${sessionDir}`);
    if (stored === '0') return false;
    if (stored === '1') return true;
  } catch {
    return true;
  }
  return true;
}

export function savePostTakeSilenceReview(sessionDir: string, enabled: boolean): void {
  if (!sessionDir) return;
  try {
    localStorage.setItem(`${POST_TAKE_STORAGE_PREFIX}${sessionDir}`, enabled ? '1' : '0');
  } catch {
    // Preference is workstation-local; a blocked store must not stop capture.
  }
}
