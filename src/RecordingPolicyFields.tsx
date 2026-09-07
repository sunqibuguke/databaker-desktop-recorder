import { useI18n } from './i18n';
import { validRecordingPolicy, type RecordingPolicy } from './recording-policy';

export function RecordingPolicyFields({ value, onChange, onSave, silenceDurationMs, onAdjustSilence, disabled = false }: {
  silenceDurationMs?: number; onAdjustSilence?: () => void;
  value: RecordingPolicy; onChange: (value: RecordingPolicy) => void; onSave?: () => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  return <fieldset className="recording-policy-fields" disabled={disabled} data-testid="recording-policy-fields">
    <legend>{t('speech.title')}</legend>
    <label><input type="checkbox" checked={value.amplitude_enabled} onChange={(event) => onChange({ ...value, amplitude_enabled: event.target.checked })} />{t('speech.amplitude')}</label>
    {value.amplitude_enabled && <div className="speech-thresholds">
      <label>{t('speech.rmsMin')}<input type="number" min={-96} max={0} step={1} value={Number.isNaN(value.rms_min_dbfs) ? '' : value.rms_min_dbfs} onChange={(event) => onChange({ ...value, rms_min_dbfs: event.target.valueAsNumber })} /></label>
      <label>{t('speech.peakMax')}<input type="number" min={-96} max={0} step={1} value={Number.isNaN(value.peak_max_dbfs) ? '' : value.peak_max_dbfs} onChange={(event) => onChange({ ...value, peak_max_dbfs: event.target.valueAsNumber })} /></label>
      <p>{t('speech.reference')}</p>
    </div>}
    <label><input type="checkbox" checked={value.auto_end} onChange={(event) => onChange({ ...value, auto_end: event.target.checked })} />{t('speech.autoEnd')}</label>
    <p>{t('speech.autoHint')}</p>
    {silenceDurationMs !== undefined && <p>{t('speech.silenceDuration', { seconds: silenceDurationMs / 1000 })}{onAdjustSilence && <> · <button type="button" className="inline-setting-link" onClick={onAdjustSilence}>{t('speech.adjustSilence')}</button></>}</p>}
    {!validRecordingPolicy(value) && <p role="alert">{t('speech.invalid')}</p>}
    {onSave && <><p>{t('speech.nextTake')}</p><button className="button" type="button" disabled={!validRecordingPolicy(value)} onClick={onSave}>{t('speech.save')}</button></>}
  </fieldset>;
}
