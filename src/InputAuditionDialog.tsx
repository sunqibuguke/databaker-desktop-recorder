import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Icon } from './studio-chrome';
import {
  createCurrentInputAuditionDecision,
  inputAuditionCaptureFingerprint,
  inputAuditionConfiguration,
  inputAuditionDurationSeconds,
  inputAuditionErrorMessage,
  inputAuditionProgress,
  inputAuditionStateFromResult,
  logicalInputAuditionConfigurationKey,
  shouldPromptInputAudition,
  validInputAuditionFinishResult,
  type InputAuditionDialogPhase,
} from './input-audition';
import { useI18n } from './i18n';
import type {
  InputAuditionDecision,
  InputAuditionFinishResult,
  InputAuditionState,
  SessionSnapshot,
} from './types';

const FOCUSABLE = [
  'button:not([disabled])',
  'audio[controls]',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type Props = {
  snapshot: SessionSnapshot;
  /** Manual rechecks must bypass an otherwise reusable startup decision. */
  force?: boolean;
  onSnapshot: (snapshot: SessionSnapshot) => void;
  onResolved: (
    decision: InputAuditionDecision,
    source: 'current' | 'startup-cache',
  ) => void;
  /** Cancellation does not suppress the next prompt; the parent chooses where to navigate. */
  onCancel: () => void;
};

function operationCheckId(audition: InputAuditionState | null): string | null {
  const checkId = audition?.check_id?.trim();
  return checkId || null;
}

function activeInputAudition(audition: InputAuditionState | null | undefined): InputAuditionState | null {
  if (!audition
    || !['recording', 'ready', 'warning'].includes(audition.status)
    || !operationCheckId(audition)) return null;
  return audition;
}

function cancellableCheckId(audition: InputAuditionState | null): string | null {
  return activeInputAudition(audition) ? operationCheckId(audition) : null;
}

function finiteDb(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(1)} dBFS`
    : '—';
}

export function InputAuditionDialog({
  snapshot,
  force = false,
  onSnapshot,
  onResolved,
  onCancel,
}: Props) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const finishingCheckIdRef = useRef<string | null>(null);
  const beginPendingRef = useRef(false);
  const cancelAfterBeginRef = useRef(false);
  const cancelAfterBeginNotifyParentRef = useRef(false);
  const onSnapshotRef = useRef(onSnapshot);
  const onResolvedRef = useRef(onResolved);
  const onCancelRef = useRef(onCancel);
  const audioUrlRef = useRef<string | null>(null);
  const autoPlaybackUrlRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<InputAuditionDialogPhase>('checking-cache');
  const [audition, setAudition] = useState<InputAuditionState | null>(null);
  const [beginPending, setBeginPending] = useState(false);
  const [finishResult, setFinishResult] = useState<InputAuditionFinishResult | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [listenedToEnd, setListenedToEnd] = useState(false);
  const [error, setError] = useState('');
  const [clockMs, setClockMs] = useState(Date.now());
  const blocking = beginPending
    || phase === 'checking-cache'
    || phase === 'recording'
    || phase === 'finishing'
    || phase === 'confirming'
    || phase === 'skipping'
    || phase === 'cancelling';
  onSnapshotRef.current = onSnapshot;
  onResolvedRef.current = onResolved;
  onCancelRef.current = onCancel;

  const configuration = useMemo(() => inputAuditionConfiguration(snapshot), [
    snapshot.audio_format.bit_depth,
    snapshot.audio_format.input_channel,
    snapshot.audio_format.input_channels,
    snapshot.audio_format.sample_rate,
    snapshot.capture_backend,
    snapshot.capture_buffer_frames,
    snapshot.capture_share_mode,
    snapshot.device_id,
    snapshot.device_name,
    snapshot.input_sample_format,
    snapshot.requested_capture_buffer_frames,
  ]);
  const configurationKey = useMemo(
    () => logicalInputAuditionConfigurationKey(configuration),
    [configuration],
  );

  const replaceAudioUrl = useCallback((next: string | null) => {
    const previous = audioUrlRef.current;
    audioUrlRef.current = next;
    setAudioUrl(next);
    if (previous) URL.revokeObjectURL(previous);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    return () => {
      mountedRef.current = false;
      if (beginPendingRef.current) cancelAfterBeginRef.current = true;
      operationRef.current += 1;
      const url = audioUrlRef.current;
      audioUrlRef.current = null;
      if (url) URL.revokeObjectURL(url);
      const target = restoreFocusRef.current;
      if (target?.isConnected) target.focus();
    };
  }, []);

  useEffect(() => {
    const operation = ++operationRef.current;
    setPhase('checking-cache');
    setError('');
    const unresolvedAtOpen = activeInputAudition(snapshot.input_audition);
    const decisionRequest = force || unresolvedAtOpen
      ? Promise.resolve<InputAuditionDecision | null>(null)
      : window.recorder.getInputAuditionDecision(configuration);
    void decisionRequest.then(async (decision) => {
      if (operationRef.current !== operation) return;
      const current = activeInputAudition(snapshot.input_audition);
      // An unresolved engine operation always wins over the launch cache. A
      // cached decision must never hide a recording/ready audition that still
      // needs to be completed or cancelled by its exact check id.
      if (!force && !current && !shouldPromptInputAudition(decision)) {
        onResolvedRef.current(decision!, 'startup-cache');
        return;
      }

      // A forced recheck invalidates a non-final persisted audition before the
      // new dialog becomes actionable. Confirmed/skipped are final decisions,
      // so their old check ids must never enter cancel/retry paths.
      if (force && current) {
        setAudition(current);
        setPhase('cancelling');
        const cancelled = await window.recorder.cancelInputAudition(operationCheckId(current)!);
        if (operationRef.current !== operation) return;
        onSnapshotRef.current(cancelled.snapshot);
        setAudition(null);
        setPhase('idle');
        return;
      }
      setAudition(current);
      setPhase(current?.status === 'recording'
        ? 'recording'
        : current?.status === 'ready'
          ? 'ready'
          : current?.status === 'warning'
            ? 'warning'
            : 'idle');
    }).catch((caught) => {
      if (operationRef.current !== operation) return;
      setError(inputAuditionErrorMessage(caught));
      setPhase('error');
    });
  // configurationKey intentionally represents only the logical capture path.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configurationKey, force]);

  useEffect(() => {
    if (phase === 'checking-cache') {
      dialogRef.current?.focus();
      return;
    }
    // Do not focus the consequential skip action while the operator is
    // speaking. The dialog still owns keyboard events and Tab enters its
    // controls normally.
    if (phase === 'recording') {
      dialogRef.current?.focus();
      return;
    }
    const initial = dialogRef.current?.querySelector<HTMLElement>('[data-dialog-default]:not([disabled])')
      ?? dialogRef.current?.querySelector<HTMLElement>('[data-dialog-initial]:not([disabled])')
      ?? dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    initial?.focus();
  }, [phase]);

  useEffect(() => {
    if (!audioUrl) autoPlaybackUrlRef.current = null;
  }, [audioUrl]);

  const finish = useCallback(async (checkId: string) => {
    if (finishingCheckIdRef.current === checkId) return;
    finishingCheckIdRef.current = checkId;
    const operation = ++operationRef.current;
    setPhase('finishing');
    setError('');
    try {
      const result = await window.recorder.finishInputAudition(checkId);
      if (operationRef.current !== operation || operationCheckId(result.input_audition) !== checkId) return;
      if (!validInputAuditionFinishResult(result)) {
        throw new Error(t('inputAudition.invalidResult'));
      }
      const bytes = await window.recorder.readAudio(result.file_path);
      if (operationRef.current !== operation) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      replaceAudioUrl(url);
      setFinishResult(result);
      setAudition(inputAuditionStateFromResult(result));
      onSnapshotRef.current(result.snapshot);
      setListenedToEnd(false);
      const warnings = result.warning_codes ?? result.metrics?.warning_codes ?? [];
      setPhase(result.input_audition.status === 'warning' || warnings.length > 0
        ? 'warning'
        : 'ready');
    } catch (caught) {
      if (operationRef.current !== operation) return;
      setError(inputAuditionErrorMessage(caught));
      setPhase('error');
    } finally {
      if (finishingCheckIdRef.current === checkId) finishingCheckIdRef.current = null;
    }
  }, [replaceAudioUrl, t]);

  useEffect(() => {
    if ((phase !== 'ready' && phase !== 'warning') || finishResult || audioUrl) return;
    const checkId = operationCheckId(audition);
    if (checkId) void finish(checkId);
  }, [audioUrl, audition, finish, finishResult, phase]);

  useEffect(() => {
    const checkId = operationCheckId(audition);
    if (phase !== 'recording' || !audition || !checkId) return undefined;
    const durationMs = inputAuditionDurationSeconds(audition, snapshot.audio_format.sample_rate) * 1_000;
    const parsedStart = Date.parse(audition.started_at);
    const deadline = (Number.isFinite(parsedStart) ? parsedStart : Date.now()) + durationMs;
    const tick = window.setInterval(() => setClockMs(Date.now()), 100);
    // A small margin prevents a renderer timer that fires a few samples early
    // from asking the engine to finish a take shorter than the fixed boundary.
    const timer = window.setTimeout(
      () => void finish(checkId),
      Math.max(0, deadline - Date.now() + 120),
    );
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
  }, [audition, finish, phase, snapshot.audio_format.sample_rate]);

  const begin = useCallback(async () => {
    if (beginPendingRef.current) return;
    beginPendingRef.current = true;
    cancelAfterBeginRef.current = false;
    cancelAfterBeginNotifyParentRef.current = false;
    setBeginPending(true);
    const operation = ++operationRef.current;
    replaceAudioUrl(null);
    setFinishResult(null);
    setListenedToEnd(false);
    setError('');
    try {
      const result = await window.recorder.beginInputAudition();
      const current = inputAuditionStateFromResult(result);
      if (!current || current.status !== 'recording' || !operationCheckId(current)) {
        throw new Error(t('inputAudition.invalidResult'));
      }
      if (cancelAfterBeginRef.current
        || operationRef.current !== operation
        || !mountedRef.current) {
        if (mountedRef.current) setAudition(current);
        const cancelled = await window.recorder.cancelInputAudition(operationCheckId(current)!);
        if (!mountedRef.current) return;
        onSnapshotRef.current(cancelled.snapshot);
        replaceAudioUrl(null);
        setAudition(null);
        setFinishResult(null);
        if (cancelAfterBeginNotifyParentRef.current) onCancelRef.current();
        else setPhase('idle');
        return;
      }
      setAudition(current);
      onSnapshotRef.current(result.snapshot);
      setClockMs(Date.now());
      setPhase('recording');
    } catch (caught) {
      if (!mountedRef.current || operationRef.current !== operation) return;
      setError(inputAuditionErrorMessage(caught));
      setPhase('error');
    } finally {
      beginPendingRef.current = false;
      if (mountedRef.current) setBeginPending(false);
    }
  }, [replaceAudioUrl, t]);

  const cancelCurrent = useCallback(async (notifyParent: boolean) => {
    if (beginPendingRef.current) {
      cancelAfterBeginRef.current = true;
      cancelAfterBeginNotifyParentRef.current ||= notifyParent;
      setPhase('cancelling');
      return;
    }
    const checkId = cancellableCheckId(audition);
    const operation = ++operationRef.current;
    setPhase('cancelling');
    setError('');
    try {
      if (checkId) {
        const result = await window.recorder.cancelInputAudition(checkId);
        if (operationRef.current !== operation) return;
        onSnapshotRef.current(result.snapshot);
      }
      replaceAudioUrl(null);
      setAudition(null);
      setFinishResult(null);
      if (notifyParent) onCancelRef.current();
      else await begin();
    } catch (caught) {
      if (operationRef.current !== operation) return;
      setError(inputAuditionErrorMessage(caught));
      setPhase('error');
    }
  }, [audition, begin, replaceAudioUrl]);

  const skip = useCallback(async () => {
    const operation = ++operationRef.current;
    setPhase('skipping');
    setError('');
    try {
      const checkId = cancellableCheckId(audition);
      const skipCheckId = checkId
        && (audition?.status === 'ready' || audition?.status === 'warning')
        ? checkId
        : undefined;
      if (checkId && !skipCheckId) {
        const cancelled = await window.recorder.cancelInputAudition(checkId);
        if (operationRef.current !== operation) return;
        onSnapshotRef.current(cancelled.snapshot);
      }
      const result = await window.recorder.skipInputAudition(skipCheckId);
      if (operationRef.current !== operation) return;
      const current = inputAuditionStateFromResult(result);
      if (!current || current.status !== 'skipped') throw new Error(t('inputAudition.invalidResult'));
      onSnapshotRef.current(result.snapshot);
      const decision = createCurrentInputAuditionDecision(
        'skipped',
        inputAuditionCaptureFingerprint(current),
        operationCheckId(current)!,
      );
      onResolvedRef.current(decision, 'current');
    } catch (caught) {
      if (operationRef.current !== operation) return;
      setError(inputAuditionErrorMessage(caught));
      setPhase('error');
    }
  }, [audition, t]);

  const confirm = useCallback(async () => {
    const checkId = operationCheckId(audition);
    if (!checkId || phase !== 'ready') return;
    const operation = ++operationRef.current;
    setPhase('confirming');
    setError('');
    try {
      const result = await window.recorder.confirmInputAudition(checkId);
      if (operationRef.current !== operation) return;
      const current = inputAuditionStateFromResult(result);
      if (!current || current.status !== 'confirmed' || operationCheckId(current) !== checkId) {
        throw new Error(t('inputAudition.invalidResult'));
      }
      onSnapshotRef.current(result.snapshot);
      const decision = createCurrentInputAuditionDecision(
        'confirmed',
        inputAuditionCaptureFingerprint(current),
        operationCheckId(current)!,
      );
      onResolvedRef.current(decision, 'current');
    } catch (caught) {
      if (operationRef.current !== operation) return;
      setError(inputAuditionErrorMessage(caught));
      setPhase('error');
    }
  }, [audition, phase, t]);

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // The audition overlay owns every key. In particular R/P/S/Space must not
    // leak into Recorder's global transport shortcuts.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (phase === 'checking-cache') return;
      if (phase !== 'confirming' && phase !== 'skipping' && phase !== 'cancelling') {
        void cancelCurrent(true);
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    ).filter((node) => !node.hasAttribute('disabled') && node.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const sampleRate = snapshot.audio_format.sample_rate;
  const startedAt = audition ? Date.parse(audition.started_at) : Number.NaN;
  const elapsedSeconds = audition && Number.isFinite(startedAt)
    ? Math.max(0, (clockMs - startedAt) / 1_000)
    : 0;
  const progress = inputAuditionProgress(audition, elapsedSeconds, sampleRate);
  const durationSeconds = inputAuditionDurationSeconds(audition, sampleRate);
  const remainingSeconds = Math.max(0, Math.ceil(durationSeconds * (1 - progress)));
  const metrics = finishResult?.metrics ?? audition?.metrics;
  const warningCodes = finishResult?.warning_codes
    ?? metrics?.warning_codes
    ?? audition?.warning_codes
    ?? [];
  const warningCodeCopy = warningCodes.map((code) => {
    if (code === 'digital_silence') return t('inputAudition.warningCodeDigitalSilence');
    if (code === 'clipping') return t('inputAudition.warningCodeClipping');
    if (code === 'input_discontinuity') return t('inputAudition.warningCodeDiscontinuity');
    if (code === 'overflow') return t('inputAudition.warningCodeOverflow');
    if (code === 'too_short') return t('inputAudition.warningCodeTooShort');
    if (code === 'not_confirmed') return t('inputAudition.warningCodeNotConfirmed');
    return code;
  });

  return <div className="dialog-backdrop input-audition-backdrop" role="presentation">
    <section
      ref={dialogRef}
      className="studio-dialog input-audition-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="input-audition-title"
      aria-describedby="input-audition-description"
      data-testid="input-audition-dialog"
      tabIndex={-1}
      onKeyDownCapture={onDialogKeyDown}
    >
      <header>
        <span className="dialog-icon"><Icon name="headphones" size={18} /></span>
        <div>
          <h2 id="input-audition-title">{t('inputAudition.title')}</h2>
          <small>{t('inputAudition.duration', { seconds: 10 })}</small>
        </div>
        <button
          data-testid="input-audition-close"
          className="input-audition-dialog-close"
          type="button"
          aria-label={t('inputAudition.cancel')}
          title={t('inputAudition.cancel')}
          onClick={() => void cancelCurrent(true)}
          disabled={phase === 'checking-cache'
            || phase === 'confirming'
            || phase === 'skipping'
            || phase === 'cancelling'}
        ><Icon name="close" size={15} /></button>
      </header>
      <p id="input-audition-description">{phase === 'recording'
        ? t('inputAudition.recordingBody', { seconds: remainingSeconds })
        : phase === 'finishing'
          ? t('inputAudition.preparingBody')
          : phase === 'ready'
            ? t('inputAudition.readyBody')
            : phase === 'warning'
              ? t('inputAudition.warningBody')
              : t('inputAudition.introBody')}</p>
      <dl className="dialog-summary input-audition-summary">
        <div><dt>{t('inputAudition.device')}</dt><dd title={snapshot.device_name}>{snapshot.device_name}</dd></div>
        <div><dt>{t('inputAudition.format')}</dt><dd>{sampleRate / 1_000}k / {snapshot.audio_format.bit_depth}-bit</dd></div>
        <div><dt>{t('inputAudition.channel')}</dt><dd>{snapshot.audio_format.input_channel ?? 1}</dd></div>
      </dl>
      {phase === 'recording' || phase === 'finishing' ? <div className="dialog-warning input-audition-progress-block">
        <strong aria-live="polite">{phase === 'finishing'
          ? t('inputAudition.preparing')
          : t('inputAudition.remaining', { seconds: remainingSeconds })}</strong>
        <progress
          data-testid="input-audition-progress"
          max={100}
          value={Math.round(progress * 100)}
          aria-label={t('inputAudition.progress')}
        />
      </div> : null}
      {audioUrl ? <div className="dialog-warning input-audition-playback">
        <audio
          controls
          autoPlay
          preload="auto"
          src={audioUrl}
          data-testid="input-audition-audio"
          onCanPlay={(event) => {
            if (autoPlaybackUrlRef.current === audioUrl) return;
            autoPlaybackUrlRef.current = audioUrl;
            void event.currentTarget.play().catch(() => undefined);
          }}
          onPlay={() => setListenedToEnd(false)}
          onEnded={() => setListenedToEnd(true)}
        />
        <span aria-live="polite">{listenedToEnd
          ? t('inputAudition.playbackCompleted')
          : t('inputAudition.listenBeforeConfirm')}</span>
      </div> : null}
      {metrics ? <dl className="dialog-summary input-audition-metrics">
        <div><dt>RMS</dt><dd>{finiteDb(metrics.rms_dbfs ?? finishResult?.rms_dbfs)}</dd></div>
        <div><dt>PEAK</dt><dd>{finiteDb(metrics.peak_dbfs ?? finishResult?.peak_dbfs)}</dd></div>
        <div><dt>{t('inputAudition.durationLabel')}</dt><dd>{metrics.duration_seconds.toFixed(1)}s</dd></div>
      </dl> : null}
      {warningCodes.length > 0 ? <div className="dialog-warning" role="alert">
        <strong>{t('inputAudition.warningTitle')}</strong>
        <span>{t('inputAudition.warningCodes', { codes: warningCodeCopy.join('、') })}</span>
      </div> : null}
      {error ? <div className="dialog-warning danger" role="alert">
        <strong>{t('inputAudition.errorTitle')}</strong>
        <span>{error}</span>
      </div> : null}
      <footer>
        {phase === 'checking-cache' ? <>
          <button data-dialog-initial className="button" type="button" disabled>{t('common.checking')}</button>
        </> : phase === 'idle' ? <>
          <button data-testid="input-audition-skip" className="button" type="button" onClick={() => void skip()}>{t('inputAudition.skip')}</button>
          <button data-dialog-initial data-testid="input-audition-start" className="button primary" type="button" onClick={() => void begin()} disabled={beginPending} aria-busy={beginPending}>
            <Icon name="record" size={14} />{t('inputAudition.start')}
          </button>
        </> : phase === 'ready' ? <>
          <button data-testid="input-audition-skip" className="button" type="button" onClick={() => void skip()}>{t('inputAudition.skip')}</button>
          <button data-dialog-initial data-testid="input-audition-retry" className="button" type="button" onClick={() => void cancelCurrent(false)}>{t('inputAudition.retry')}</button>
          <button
            data-dialog-default
            data-testid="input-audition-confirm"
            className="button primary"
            type="button"
            onClick={() => void confirm()}
          ><Icon name="check" size={14} />{t('inputAudition.confirm')}</button>
        </> : phase === 'warning' || phase === 'error' ? <>
          <button data-testid="input-audition-skip" className="button" type="button" onClick={() => void skip()} disabled={blocking}>{t('inputAudition.skip')}</button>
          <button data-dialog-initial data-testid="input-audition-retry" className="button primary" type="button" onClick={() => void cancelCurrent(false)} disabled={blocking}>
            <Icon name="retake" size={14} />{t('inputAudition.retry')}
          </button>
        </> : phase === 'recording' ? <>
          <button data-testid="input-audition-skip" className="button" type="button" onClick={() => void skip()}>
            <Icon name="skip" size={14} />{t('inputAudition.skipRecording')}
          </button>
        </> : <>
          <button data-testid="input-audition-skip" className="button" type="button" disabled>
            {t('inputAudition.skip')}
          </button>
        </>}
      </footer>
    </section>
  </div>;
}
