import type { Attempt } from './types';
import { t } from '../shared/i18n/index.ts';

export type PeakSampPolicy = { min: number; max: number; unit: 'samp' | 'dbfs' };
export type RecordingPolicy = { amplitude_enabled: boolean; auto_end: boolean; rms_min_dbfs: number; peak_max_dbfs: number; peak_samp?: PeakSampPolicy | null };
export const LEGACY_RECORDING_POLICY: RecordingPolicy = { amplitude_enabled: false, auto_end: false, rms_min_dbfs: -30, peak_max_dbfs: -3 };
export const DEFAULT_RECORDING_POLICY: RecordingPolicy = { ...LEGACY_RECORDING_POLICY, peak_samp: { min: 3000, max: 20000, unit: 'samp' } };
export function recordingPolicyForTask(value?: Partial<RecordingPolicy> | null): RecordingPolicy {
  return { ...LEGACY_RECORDING_POLICY, ...value };
}
export function sampToDbfs(samp: number): number { return 20 * Math.log10(samp / 32768); }
export function dbfsToSamp(dbfs: number): number { return Math.round(32768 * 10 ** (dbfs / 20)); }
export function peakValue(samp: number, unit: 'samp' | 'dbfs'): string {
  return unit === 'samp' ? String(samp) : samp === 0 ? '−∞' : String(Number(sampToDbfs(samp).toFixed(3)));
}
export function speechQualityMetrics(quality: SpeechQuality): string {
  if (!quality.speech_samples) return t('speech.unmeasured');
  const peak = quality.policy.peak_samp;
  if (peak && quality.peak_samp != null) return t('speech.peakMetrics', { value: peakValue(quality.peak_samp, peak.unit), unit: peak.unit === 'samp' ? 'samp' : 'dBFS' });
  return t('speech.metrics', { rms: quality.rms_dbfs?.toFixed(1) ?? '—', peak: quality.peak_dbfs?.toFixed(1) ?? '—' });
}
export type SpeechQuality = {
  policy: RecordingPolicy;
  speech_samples: number;
  rms_dbfs: number | null;
  peak_dbfs: number | null;
  peak_samp?: number | null;
  warnings: string[];
  live_warnings: string[];
  retained_by_operator_at: string | null;
};
export type StoppedAttempt = {
  item_id: string; attempt: Attempt | null; discarded?: boolean; interrupted?: boolean;
  forced?: boolean; auto_selected?: boolean; recovered_discontinuity?: boolean; already_stopped?: boolean;
};
export type AutomaticStopEvent = { session_id: string; attempt_id?: string; result: StoppedAttempt };
export function validRecordingPolicy(value: RecordingPolicy, bitDepth?: number): boolean {
  const peak = value.peak_samp;
  if (peak != null && (typeof peak !== 'object' || !Number.isSafeInteger(peak.min) || !Number.isSafeInteger(peak.max)
    || peak.min < 1 || peak.min >= peak.max || peak.max > 32766 || !['samp', 'dbfs'].includes(peak.unit)
    || (value.amplitude_enabled && bitDepth !== undefined && bitDepth !== 16))) return false;
  return typeof value.amplitude_enabled === 'boolean' && typeof value.auto_end === 'boolean'
    && Number.isFinite(value.rms_min_dbfs) && Number.isFinite(value.peak_max_dbfs)
    && value.rms_min_dbfs >= -96 && value.peak_max_dbfs <= 0 && value.rms_min_dbfs < value.peak_max_dbfs;
}
export function speechQualityWarning(quality: SpeechQuality | null | undefined, live = false): string {
  if (!quality) return '';
  const codes = [...new Set([...(live ? [] : quality.warnings), ...quality.live_warnings])];
  return codes.map((code) => code === 'speech_low' ? t('speech.low') : code === 'speech_high' ? t('speech.high') : '').filter(Boolean).join(' · ');
}

// Explain saved warning codes using the policy captured for this take, never the
// task's current settings. Live-only warnings must not imply the final RMS failed.
export function speechQualityWarningDetail(quality: SpeechQuality | null | undefined): string {
  if (!quality) return '';
  const parts: string[] = [];
  const peak = quality.policy.peak_samp;
  if (peak) {
    const args = { value: quality.peak_samp == null ? '—' : String(quality.peak_samp), min: peak.min, max: peak.max };
    if (quality.warnings.includes('speech_low')) parts.push(t('speech.peakLowReason', args));
    if (quality.warnings.includes('speech_high') || quality.live_warnings.includes('speech_high')) parts.push(t('speech.peakHighReason', args));
    return parts.join(' · ');
  }
  const value = (dbfs: number) => String(Number(dbfs.toFixed(3)));
  if (quality.warnings.includes('speech_low') && quality.rms_dbfs !== null) {
    parts.push(t('speech.lowReason', { value: value(quality.rms_dbfs), limit: value(quality.policy.rms_min_dbfs) }));
  } else if (quality.live_warnings.includes('speech_low')) {
    parts.push(t('speech.liveLowReason', { limit: value(quality.policy.rms_min_dbfs) }));
  }
  if (quality.warnings.includes('speech_high') && quality.peak_dbfs !== null) {
    parts.push(t('speech.highReason', { value: value(quality.peak_dbfs), limit: value(quality.policy.peak_max_dbfs) }));
  } else if (quality.live_warnings.includes('speech_high')) {
    parts.push(t('speech.liveHighReason', { limit: value(quality.policy.peak_max_dbfs) }));
  }
  return parts.join(' · ');
}
