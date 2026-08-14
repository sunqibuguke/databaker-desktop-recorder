import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import {
  DEFAULT_PROMPTER_LIVE_COLOR,
  MAX_PROMPTER_FONT_SIZE,
  MIN_PROMPTER_FONT_SIZE,
  PROMPTER_LIVE_COLOR_PRESETS,
  defaultPrompterAppearance,
  loadPrompterAppearance,
  normalizePrompterFontSize,
  normalizePrompterLiveColor,
  prompterFontSizeRem,
  savePrompterAppearance,
  type PrompterAppearance,
} from './prompter-appearance';
import { Icon } from './studio-chrome';
import { prompterShowsSilenceRing } from './prompter-cues';
import type { PrompterCue, PrompterState } from './types';

const CUE_RING_RADIUS = 7;
const CUE_RING_CIRCUMFERENCE = 2 * Math.PI * CUE_RING_RADIUS;

function appearanceStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function PrompterCueMark({ cue, progress }: { cue: PrompterCue; progress: number }) {
  if (prompterShowsSilenceRing(cue)) {
    const clamped = Math.max(0, Math.min(1, progress));
    return <svg className="prompter-cue-ring" viewBox="0 0 18 18" aria-hidden="true">
      <circle className="prompter-cue-ring-track" cx="9" cy="9" r={CUE_RING_RADIUS} />
      <circle
        className="prompter-cue-ring-progress"
        cx="9"
        cy="9"
        r={CUE_RING_RADIUS}
        strokeDasharray={CUE_RING_CIRCUMFERENCE}
        strokeDashoffset={CUE_RING_CIRCUMFERENCE * (1 - clamped)}
      />
    </svg>;
  }
  if (cue === 'recording') {
    return <i className="prompter-rec-dot" aria-hidden="true" />;
  }
  if (cue === 'ready') {
    return <i className="prompter-ready-dot" aria-hidden="true" />;
  }
  return null;
}

export function PrompterView() {
  const { t } = useI18n();
  const [state, setState] = useState<PrompterState | null>(null);
  const [appearance, setAppearance] = useState<PrompterAppearance>(defaultPrompterAppearance);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const copyRef = useRef<HTMLParagraphElement>(null);
  const labelRef = useRef<HTMLElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setAppearance(loadPrompterAppearance(appearanceStorage()));
  }, []);
  useEffect(() => {
    const unsubscribe = window.recorder.onPrompterState(setState);
    void window.recorder.getPrompterState().then(setState).catch(() => undefined);
    return unsubscribe;
  }, []);
  useEffect(() => {
    copyRef.current?.scrollTo({ top: 0 });
    labelRef.current?.scrollTo({ top: 0 });
  }, [state?.id, state?.text, state?.label]);
  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [settingsOpen]);
  function commitAppearance(next: PrompterAppearance) {
    setAppearance(savePrompterAppearance(next, appearanceStorage()));
  }
  const cue = state?.cue ?? 'idle';
  const readerLabel = state?.readerCueLabel || state?.cueLabel || t('prompter.waitTask');
  const qualityWarning = cue === 'fault' ? '' : state?.qualityWarning ?? '';
  const copyLength = Array.from(state?.text ?? '').length;
  const copyDensity = copyLength > 180 ? 'dense' : copyLength > 90 ? 'long' : '';
  return <main
    className={`prompter-shell ${cue} ${qualityWarning ? 'has-quality-warning' : ''}`}
    data-testid="prompter-shell"
    data-cue={cue}
    aria-label={readerLabel}
    style={{
      ['--prompter-copy-size' as string]: prompterFontSizeRem(appearance.fontSize),
      ['--prompter-live-color' as string]: appearance.liveColor,
    }}
  >
    <header className="prompter-header">
      <span className="prompter-sequence">
        <strong>{state?.id || t('common.dash')}</strong>
        <i>· {t('prompter.sequence', { n: state?.sequence || t('common.dash') })}</i>
        <i>{t('prompter.ofTotal', { total: state?.total ?? 0 })}</i>
      </span>
      <span className="prompter-cue" data-testid="prompter-cue" role={cue === 'fault' ? 'alert' : 'status'} aria-live={cue === 'fault' ? 'assertive' : 'polite'}>
        <PrompterCueMark cue={cue} progress={state?.silenceProgress ?? 0} />
        {readerLabel}
      </span>
    </header>
    {qualityWarning && <div className="prompter-quality-warning" role="alert"><i />{qualityWarning}</div>}
    <article className="prompter-content">
      <p ref={copyRef} className={`${copyDensity} ${cue === 'recording' ? 'live' : ''}`.trim()}>{state?.text || t('prompter.noText')}</p>
      <aside ref={labelRef} className={`prompter-label ${state?.label ? '' : 'empty'}`}><span>{t('prompter.labelTitle')}</span><strong>{state?.label || t('prompter.none')}</strong></aside>
    </article>
    <footer className="prompter-footer">
      <div className="prompter-settings" ref={settingsRef}>
        {settingsOpen && <section className="prompter-settings-panel" role="dialog" aria-labelledby="prompter-settings-title">
          <header>
            <strong id="prompter-settings-title">{t('prompter.settings')}</strong>
            <button type="button" className="prompter-settings-reset" onClick={() => commitAppearance(defaultPrompterAppearance())}>{t('prompter.resetAppearance')}</button>
          </header>
          <label className="prompter-settings-field">
            <span>
              {t('prompter.fontSize')}
              <output>{t('prompter.fontSizeValue', { size: appearance.fontSize })}</output>
            </span>
            <input
              type="range"
              min={MIN_PROMPTER_FONT_SIZE}
              max={MAX_PROMPTER_FONT_SIZE}
              step={1}
              value={appearance.fontSize}
              aria-valuetext={t('prompter.fontSizeValue', { size: appearance.fontSize })}
              onChange={(event) => commitAppearance({
                ...appearance,
                fontSize: normalizePrompterFontSize(event.currentTarget.value),
              })}
            />
          </label>
          <div className="prompter-settings-field">
            <span>
              {t('prompter.liveColor')}
              <small>{t('prompter.liveColorHint')}</small>
            </span>
            <div className="prompter-color-row">
              {PROMPTER_LIVE_COLOR_PRESETS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`prompter-color-swatch ${appearance.liveColor === color ? 'active' : ''}`}
                  style={{ background: color }}
                  aria-label={color === DEFAULT_PROMPTER_LIVE_COLOR ? `${color} · ${t('prompter.resetAppearance')}` : color}
                  aria-pressed={appearance.liveColor === color}
                  onClick={() => commitAppearance({ ...appearance, liveColor: color })}
                />
              ))}
              <label className="prompter-color-custom">
                <input
                  type="color"
                  value={appearance.liveColor}
                  aria-label={t('prompter.liveColor')}
                  onChange={(event) => commitAppearance({
                    ...appearance,
                    liveColor: normalizePrompterLiveColor(event.currentTarget.value),
                  })}
                />
              </label>
            </div>
          </div>
        </section>}
        <button
          type="button"
          className={`prompter-settings-button ${settingsOpen ? 'open' : ''}`}
          title={t('prompter.settings')}
          aria-label={t('prompter.settingsAria')}
          aria-expanded={settingsOpen}
          aria-haspopup="dialog"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <Icon name="settings" size={15} />
        </button>
      </div>
    </footer>
  </main>;
}
