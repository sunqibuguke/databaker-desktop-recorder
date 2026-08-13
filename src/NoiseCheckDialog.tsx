import { Icon } from './studio-chrome';
import { useI18n } from './i18n';
import type { NoiseCheckResult } from './types';
import {
  NOISE_CHECK_STEPS,
  NOISE_WINDOW_COUNT,
  NOISE_WINDOW_SIZE,
  noiseLevelPercent,
  noiseWindowState,
  type SessionNoiseGate,
} from './recording-workflow';

function formatDbfs(value: number): string {
  return value <= -95.9 ? '−∞' : value.toFixed(1);
}

export function NoiseCheckDialog({
  gate,
  running,
  error,
  samples,
  liveRmsDbfs,
  thresholdDbfs,
  result,
  busy,
  onRetry,
}: {
  gate: SessionNoiseGate;
  running: boolean;
  error: string;
  samples: number[];
  liveRmsDbfs: number | null;
  thresholdDbfs: number;
  result: NoiseCheckResult | null;
  busy: boolean;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const phase = running
    ? 'sampling'
    : gate === 'failed'
      ? 'failed'
      : error
        ? 'error'
        : 'idle';
  const currentDbfs = running
    ? (liveRmsDbfs ?? -96)
    : (result?.maximum_dbfs ?? liveRmsDbfs ?? -96);
  const progressPercent = Math.min(100, samples.length / NOISE_CHECK_STEPS * 100);
  const statusLabel = phase === 'sampling'
    ? t('noise.statusSampling')
    : phase === 'failed'
      ? t('noise.statusBlocked')
      : phase === 'error'
        ? t('noise.statusError')
        : t('noise.statusStandby');

  return <div className="dialog-backdrop noise-backdrop" role="presentation">
    <section
      className={`studio-dialog noise-check-dialog ${phase}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="noise-dialog-title"
      aria-busy={running}
      data-testid="noise-check-dialog"
    >
      <header>
        <span className="dialog-icon"><Icon name="meter" size={19} /></span>
        <div>
          <small>{t('noise.dialogKicker')}</small>
          <h2 id="noise-dialog-title">{t('noise.dialogTitle')}</h2>
        </div>
        <span className={`noise-status ${phase}`}>{statusLabel}</span>
      </header>
      <div className="noise-check-body">
        <p className="noise-check-copy">{t('noise.dialogCopy')}</p>
        <div className="noise-readout" aria-live="polite">
          <div>
            <small>{t('noise.liveRms')}</small>
            <strong>{formatDbfs(currentDbfs)} <em>dBFS</em></strong>
          </div>
          <div>
            <small>{t('noise.limit')}</small>
            <span>{thresholdDbfs.toFixed(1)} dBFS</span>
          </div>
        </div>
        <div className="noise-level-track" aria-hidden="true">
          <i className="noise-level-fill" style={{ width: `${noiseLevelPercent(currentDbfs)}%` }} />
          <i className="noise-threshold-marker" style={{ left: `${noiseLevelPercent(thresholdDbfs)}%` }} />
          <span>−72</span>
          <span>−6</span>
        </div>
        <div className="noise-window-grid">
          {Array.from({ length: NOISE_WINDOW_COUNT }, (_, windowIndex) => {
            const view = noiseWindowState(samples, windowIndex, thresholdDbfs);
            return <div className={`noise-window ${view.state}`} key={windowIndex}>
              <header>
                <span>{t('noise.window', { index: windowIndex + 1 })}</span>
                <em>{view.complete
                  ? (view.failed ? t('noise.windowOver') : t('noise.windowPass'))
                  : t('noise.windowProgress', { current: view.samples.length, total: NOISE_WINDOW_SIZE })}</em>
              </header>
              <div>
                {Array.from({ length: NOISE_WINDOW_SIZE }, (_, sampleIndex) => {
                  const value = samples[windowIndex * NOISE_WINDOW_SIZE + sampleIndex];
                  const over = value !== undefined && value >= thresholdDbfs;
                  return <i
                    className={value === undefined ? '' : over ? 'over' : 'ok'}
                    key={sampleIndex}
                    title={value === undefined ? undefined : `${value.toFixed(1)} dBFS`}
                  />;
                })}
              </div>
            </div>;
          })}
        </div>
        <div className="noise-progress"><i style={{ width: `${progressPercent}%` }} /></div>
        {phase === 'sampling' && <div className="noise-guidance"><i />{t('noise.guidance')}</div>}
        {phase === 'failed' && result && <div className="noise-result fail"><Icon name="meter" size={16} /><div><strong>{t('noise.resultFailTitle')}</strong><span>{t('noise.resultFailDetail', { failed: result.failing_windows })}</span></div></div>}
        {phase === 'error' && <div className="noise-result fail"><Icon name="meter" size={16} /><div><strong>{t('noise.resultErrorTitle')}</strong><span>{error || t('noise.resultErrorDetail')}</span></div></div>}
      </div>
      {phase !== 'sampling' && <footer>
        <button
          data-testid="noise-retry"
          className="button primary"
          onClick={onRetry}
          disabled={busy || running}
        >
          <Icon name="refresh" size={14} />
          {phase === 'idle' ? t('noise.startCheck') : t('noise.recheck')}
        </button>
      </footer>}
    </section>
  </div>;
}
