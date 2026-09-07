import type { Attempt } from './types';
import { t } from '../shared/i18n/index.ts';

export type RecordingPolicy = { amplitude_enabled: boolean; auto_end: boolean; rms_min_dbfs: number; peak_max_dbfs: number };
export const DEFAULT_RECORDING_POLICY: RecordingPolicy = { amplitude_enabled: false, auto_end: false, rms_min_dbfs: -30, peak_max_dbfs: -3 };
export type SpeechQuality = {
  policy: RecordingPolicy;
  speech_samples: number;
  rms_dbfs: number | null;
  peak_dbfs: number | null;
  warnings: string[];
  live_warnings: string[];
  retained_by_operator_at: string | null;
};
export type StoppedAttempt = {
  item_id: string; attempt: Attempt | null; discarded?: boolean; interrupted?: boolean;
  forced?: boolean; auto_selected?: boolean; recovered_discontinuity?: boolean; already_stopped?: boolean;
};
export type AutomaticStopEvent = { session_id: string; attempt_id?: string; result: StoppedAttempt };
export function validRecordingPolicy(value: RecordingPolicy): boolean {
  return typeof value.amplitude_enabled === 'boolean' && typeof value.auto_end === 'boolean'
    && Number.isFinite(value.rms_min_dbfs) && Number.isFinite(value.peak_max_dbfs)
    && value.rms_min_dbfs >= -96 && value.peak_max_dbfs <= 0 && value.rms_min_dbfs < value.peak_max_dbfs;
}
export function speechQualityWarning(quality: SpeechQuality | null | undefined, live = false): string {
  if (!quality) return '';
  const codes = [...new Set([...(live ? [] : quality.warnings), ...quality.live_warnings])];
  return codes.map((code) => code === 'speech_low' ? t('speech.low') : code === 'speech_high' ? t('speech.high') : '').filter(Boolean).join(' · ');
}
