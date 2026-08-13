import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';
import type { PrompterCue, PrompterState } from './types';

const CUE_RING_RADIUS = 7;
const CUE_RING_CIRCUMFERENCE = 2 * Math.PI * CUE_RING_RADIUS;

function PrompterCueMark({ cue, progress }: { cue: PrompterCue; progress: number }) {
  if (cue === 'pending') {
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
  return null;
}

export function PrompterView() {
  const { t } = useI18n();
  const [state, setState] = useState<PrompterState | null>(null);
  const copyRef = useRef<HTMLParagraphElement>(null);
  const labelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const unsubscribe = window.recorder.onPrompterState(setState);
    void window.recorder.getPrompterState().then(setState).catch(() => undefined);
    return unsubscribe;
  }, []);
  useEffect(() => {
    copyRef.current?.scrollTo({ top: 0 });
    labelRef.current?.scrollTo({ top: 0 });
  }, [state?.id, state?.text, state?.label]);
  const cue = state?.cue ?? 'idle';
  const qualityWarning = cue === 'fault' ? '' : state?.qualityWarning ?? '';
  const copyLength = Array.from(state?.text ?? '').length;
  const copyDensity = copyLength > 180 ? 'dense' : copyLength > 90 ? 'long' : '';
  return <main className={`prompter-shell ${cue} ${qualityWarning ? 'has-quality-warning' : ''}`} aria-label={state?.cueLabel ?? t('prompter.panelAria')}>
    <header className="prompter-header">
      <span className="prompter-sequence">
        ID <strong>{state?.id || t('common.dash')}</strong>
        <i>· {t('prompter.sequence', { n: state?.sequence || t('common.dash') })}</i>
        <i>{t('prompter.ofTotal', { total: state?.total ?? 0 })}</i>
      </span>
      <span className="prompter-cue" role={cue === 'fault' ? 'alert' : 'status'} aria-live={cue === 'fault' ? 'assertive' : 'polite'}>
        <PrompterCueMark cue={cue} progress={state?.silenceProgress ?? 0} />
        {state?.cueLabel ?? t('prompter.waitTask')}
      </span>
    </header>
    {qualityWarning && <div className="prompter-quality-warning" role="alert"><i />{qualityWarning}</div>}
    <article className="prompter-content">
      <p ref={copyRef} className={`${copyDensity} ${cue === 'pending' ? 'pending' : cue === 'recording' ? 'live' : ''}`.trim()}>{state?.text || t('prompter.noText')}</p>
      <aside ref={labelRef} className={`prompter-label ${state?.label ? '' : 'empty'}`}><span>{t('prompter.labelTitle')}</span><strong>{state?.label || t('prompter.none')}</strong></aside>
    </article>
  </main>;
}
