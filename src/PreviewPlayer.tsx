import { useEffect, useRef, useState } from 'react';
import { Icon } from './studio-chrome';
import { WebGLWaveform } from './WebGLWaveform';
import { formatPlaybackClock, playbackProgress, seekTimeFromClientX } from './preview-player';
import { useI18n } from './i18n';

function disposeAudioElement(audio: HTMLAudioElement | null) {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

type Props = {
  url: string;
  attemptId: string;
  itemId: string;
  itemText: string;
  itemLabel?: string;
  bins: Array<[number, number]>;
  sampleRate: number;
  onClose: () => void;
};

export function PreviewPlayer({
  url,
  attemptId,
  itemId,
  itemText,
  itemLabel,
  bins,
  sampleRate,
  onClose,
}: Props) {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onCloseRef = useRef(onClose);
  const draggingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  onCloseRef.current = onClose;

  const syncFromAudio = (audio: HTMLAudioElement | null = audioRef.current) => {
    if (!audio) return;
    setCurrentTime(audio.currentTime);
    if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
  };

  const seekTo = (next: number) => {
    const audio = audioRef.current;
    const limit = Number.isFinite(audio?.duration) && (audio?.duration ?? 0) > 0
      ? audio!.duration
      : duration;
    if (!audio || !Number.isFinite(limit) || limit <= 0) return;
    const time = Math.min(Math.max(0, next), limit);
    audio.currentTime = time;
    setCurrentTime(time);
  };

  const seekFromClientX = (target: HTMLElement, clientX: number) => {
    const rect = target.getBoundingClientRect();
    const limit = duration || audioRef.current?.duration || 0;
    seekTo(seekTimeFromClientX(clientX, rect.left, rect.width, limit));
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  };

  const replay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    setCurrentTime(0);
    void audio.play();
  };

  useEffect(() => {
    const audio = new Audio(url);
    audio.preload = 'auto';
    audioRef.current = audio;
    setCurrentTime(0);
    setDuration(0);
    setPlaying(false);

    const onEnded = () => {
      setPlaying(false);
      setCurrentTime(audio.duration || 0);
      disposeAudioElement(audio);
      if (audioRef.current === audio) audioRef.current = null;
      onCloseRef.current();
    };
    audio.addEventListener('loadedmetadata', () => syncFromAudio(audio));
    audio.addEventListener('durationchange', () => syncFromAudio(audio));
    audio.addEventListener('timeupdate', () => syncFromAudio(audio));
    audio.addEventListener('play', () => setPlaying(true));
    audio.addEventListener('pause', () => setPlaying(false));
    audio.addEventListener('ended', onEnded);
    void audio.play().catch(() => undefined);

    return () => {
      audio.removeEventListener('ended', onEnded);
      disposeAudioElement(audio);
      if (audioRef.current === audio) audioRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const tick = () => {
      syncFromAudio();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const progress = playbackProgress(currentTime, duration);
  const progressPercent = `${(progress * 100).toFixed(3)}%`;

  return <div
    className="dialog-backdrop preview-player-backdrop"
    role="presentation"
    onPointerDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
  >
    <section
      className="studio-dialog preview-player-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-player-title"
      data-testid="preview-player"
    >
      <header>
        <span className="dialog-icon"><Icon name="headphones" size={18} /></span>
        <div>
          <h2 id="preview-player-title">{t('recorder.previewTitle')}</h2>
          <small>{itemId} · {t('recorder.previewAttempt', { id: attemptId })}</small>
        </div>
        <button
          className="preview-player-close"
          type="button"
          title={t('recorder.previewClose')}
          aria-label={t('recorder.previewClose')}
          onClick={onClose}
        >
          <Icon name="close" size={15} />
        </button>
      </header>
      <div className="preview-player-body">
        {(itemLabel || itemText) && <p className="preview-player-script">
          {itemLabel && <span className="label-chip">{itemLabel}</span>}
          <span>{itemText || t('recorder.noText')}</span>
        </p>}
        <div
          className="preview-player-scope"
          role="slider"
          aria-label={t('recorder.previewSeekAria')}
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.round(duration * 10))}
          aria-valuenow={Math.round(currentTime * 10)}
          aria-valuetext={`${formatPlaybackClock(currentTime)} / ${formatPlaybackClock(duration)}`}
          onPointerDown={(event) => {
            draggingRef.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            seekFromClientX(event.currentTarget, event.clientX);
          }}
          onPointerMove={(event) => {
            if (!draggingRef.current) return;
            seekFromClientX(event.currentTarget, event.clientX);
          }}
          onPointerUp={() => { draggingRef.current = false; }}
          onPointerCancel={() => { draggingRef.current = false; }}
        >
          <WebGLWaveform
            key={url}
            mode="review"
            bins={bins}
            capturedSamples={0}
            recording={false}
            sampleRate={sampleRate}
            ariaLabel={t('waveform.previewAria')}
          />
          <i className="preview-player-played" style={{ width: progressPercent }} />
          <i className="preview-player-playhead" style={{ left: progressPercent }} />
        </div>
        <div className="preview-player-meter">
          <time dateTime={`PT${currentTime.toFixed(1)}S`}>{formatPlaybackClock(currentTime)}</time>
          <div
            className="preview-player-track"
            role="progressbar"
            aria-label={t('recorder.previewProgressAria')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            onPointerDown={(event) => {
              draggingRef.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              seekFromClientX(event.currentTarget, event.clientX);
            }}
            onPointerMove={(event) => {
              if (!draggingRef.current) return;
              seekFromClientX(event.currentTarget, event.clientX);
            }}
            onPointerUp={() => { draggingRef.current = false; }}
            onPointerCancel={() => { draggingRef.current = false; }}
          >
            <i className="preview-player-fill" style={{ width: progressPercent }} />
            <i className="preview-player-knob" style={{ left: progressPercent }} />
          </div>
          <time dateTime={`PT${duration.toFixed(1)}S`}>{formatPlaybackClock(duration)}</time>
        </div>
        <div className="preview-player-controls">
          <button className="button preview-player-replay" type="button" onClick={replay} title={t('recorder.previewReplay')}>
            <Icon name="retake" size={14} />
            <span>{t('recorder.previewReplay')}</span>
          </button>
          <button className="button primary preview-player-toggle" type="button" onClick={toggle} data-testid="preview-player-toggle">
            <Icon name={playing ? 'pause' : 'play'} size={15} />
            <strong>{playing ? t('recorder.previewPause') : t('recorder.previewPlay')}</strong>
          </button>
          <button className="button" type="button" onClick={onClose}>
            <span>{t('recorder.previewClose')}</span>
          </button>
        </div>
      </div>
    </section>
  </div>;
}
