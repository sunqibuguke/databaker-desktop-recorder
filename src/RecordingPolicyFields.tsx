import { useState } from 'react';
import { useI18n } from './i18n';
import { DEFAULT_RECORDING_POLICY, dbfsToSamp, peakValue, validRecordingPolicy, type RecordingPolicy } from './recording-policy';

export function RecordingPolicyFields({ bitDepth, value, onChange, onSave, silenceDurationMs, onAdjustSilence, disabled = false }: {
  bitDepth: number;
  silenceDurationMs?: number; onAdjustSilence?: () => void;
  value: RecordingPolicy; onChange: (value: RecordingPolicy) => void; onSave?: () => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  const peak = value.peak_samp;
  return <fieldset className="recording-policy-fields" disabled={disabled} data-testid="recording-policy-fields">
    <legend>{t('speech.title')}</legend>
    <label><input type="checkbox" checked={value.amplitude_enabled} onChange={(event) => onChange({ ...value, amplitude_enabled: event.target.checked })} />{t('speech.amplitude')}</label>
    {value.amplitude_enabled && <div className="speech-thresholds">
      {peak ? <>
        <label>{t('speech.unit')}<select aria-label={t('speech.unit')} value={peak.unit} onChange={(event) => onChange({ ...value, peak_samp: { ...peak, unit: event.target.value as 'samp' | 'dbfs' } })}><option value="samp">samp</option><option value="dbfs">dBFS</option></select></label>
        <label>{t('speech.peakMin', { unit: peak.unit === 'samp' ? 'samp' : 'dBFS' })}<PeakInput key={peak.unit} unit={peak.unit} value={peak.min} onChange={(min) => onChange({ ...value, peak_samp: { ...peak, min } })} /></label>
        <label>{t('speech.peakUpper', { unit: peak.unit === 'samp' ? 'samp' : 'dBFS' })}<PeakInput key={peak.unit} unit={peak.unit} value={peak.max} onChange={(max) => onChange({ ...value, peak_samp: { ...peak, max } })} /></label>
        <p>{t('speech.peakReference')}</p>
        <p>{t('speech.peakTiming')}</p>
        {bitDepth !== 16 && <p role="alert">{t('speech.pcm16Only')}</p>}
        {peak.unit === 'dbfs' && <p>{t('speech.canonicalSamp', { min: peak.min, max: peak.max })}</p>}
      </> : <>
        <p>{t('speech.legacyMode')}</p>
        {bitDepth === 16 && <button type="button" className="inline-setting-link" onClick={() => onChange({ ...value, peak_samp: { ...DEFAULT_RECORDING_POLICY.peak_samp! } })}>{t('speech.usePeak')}</button>}
      <label>{t('speech.rmsMin')}<input type="number" min={-96} max={0} step={1} value={Number.isNaN(value.rms_min_dbfs) ? '' : value.rms_min_dbfs} onChange={(event) => onChange({ ...value, rms_min_dbfs: event.target.valueAsNumber })} /></label>
      <label>{t('speech.peakMax')}<input type="number" min={-96} max={0} step={1} value={Number.isNaN(value.peak_max_dbfs) ? '' : value.peak_max_dbfs} onChange={(event) => onChange({ ...value, peak_max_dbfs: event.target.valueAsNumber })} /></label>
      <p>{t('speech.reference')}</p>
      </>}
    </div>}
    <label><input type="checkbox" checked={value.auto_end} onChange={(event) => onChange({ ...value, auto_end: event.target.checked })} />{t('speech.autoEnd')}</label>
    <p>{t('speech.autoHint')}</p>
    {silenceDurationMs !== undefined && <p>{t('speech.silenceDuration', { seconds: silenceDurationMs / 1000 })}{onAdjustSilence && <> · <button type="button" className="inline-setting-link" onClick={onAdjustSilence}>{t('speech.adjustSilence')}</button></>}</p>}
    {!validRecordingPolicy(value, bitDepth) && <p role="alert">{t(peak ? 'speech.peakInvalid' : 'speech.invalid')}</p>}
    {onSave && <><p>{t('speech.nextTake')}</p><button className="button" type="button" disabled={!validRecordingPolicy(value, bitDepth)} onClick={onSave}>{t('speech.save')}</button></>}
  </fieldset>;
}

function PeakInput({ value, unit, onChange }: { value: number; unit: 'samp' | 'dbfs'; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = Number.isFinite(value) ? peakValue(value, unit) : '';
  return <input key={unit} type="number" min={unit === 'samp' ? 1 : -90.308} max={unit === 'samp' ? 32766 : -0.001}
    step={unit === 'samp' ? 1 : 'any'} value={draft ?? display}
    onFocus={() => setDraft(display)} onBlur={() => setDraft(null)}
    onChange={(event) => {
      setDraft(event.target.value);
      const parsed = event.target.valueAsNumber;
      onChange(unit === 'samp' || !Number.isFinite(parsed) ? parsed : dbfsToSamp(parsed));
    }} />;
}
