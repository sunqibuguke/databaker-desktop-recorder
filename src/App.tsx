import { useEffect, useMemo, useRef, useState } from 'react';
import appLogo from '../assets/brand/databaker-recorder-logo.png';
import { engineRecoveryFailure, planHistoryRecovery } from './history-recovery';
import { parseScript } from './script-parser';
import { WebGLWaveform } from './WebGLWaveform';
import type { Attempt, AudioDevice, EngineEvent, ExportResult, ItemState, Meter, PrompterState, RecordingHistoryEntry, ScriptItem, SealInterruptedSessionResult, SessionSnapshot } from './types';

type Phase = 'home' | 'setup' | 'running' | 'finished';
type EngineStatus = 'connecting' | 'ready' | 'offline';
type HistoryFilter = 'all' | 'completed' | 'unfinished';
type RecordingStateKind = 'completed' | 'unfinished' | 'attention';
type RunningSessionState = {
  snapshot: SessionSnapshot;
  session_dir?: string;
  active_attempt?: { item_id: string; attempt_id: string; start_sample: number; recording_started_sample: number } | null;
  recovery_warnings?: string[];
};
type StoppedSessionState = {
  snapshot: SessionSnapshot;
  session_dir?: string;
  warnings?: string[];
};
type OptionalRunningSessionState = ({ active: true } & RunningSessionState) | { active: false };
type IconName = 'check' | 'chevron-left' | 'chevron-right' | 'export' | 'file' | 'folder' | 'history' | 'home' | 'headphones' | 'meter' | 'microphone' | 'play' | 'plus' | 'record' | 'refresh' | 'retake' | 'skip' | 'sliders' | 'stop';

const emptyMeter: Meter = {
  captured_samples: 0,
  committed_samples: 0,
  overflow_samples: 0,
  faulted: false,
  storage_status: 'healthy',
  storage_safe_remaining_seconds: 0,
  peak: 0,
  rms: 0,
  silence_samples: 0,
  last_signal_sample: 0,
  silence_threshold_dbfs: -42,
  silence_duration_ms: 1_000,
  waveform: [],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryWarning(label: string, warnings: string[] | undefined): string {
  if (!warnings?.length) return '';
  const first = warnings[0];
  const remaining = warnings.length > 1 ? `（另有 ${warnings.length - 1} 项）` : '';
  return `${label}：${first}${remaining}`;
}

function isNoActiveSessionError(error: unknown): boolean {
  return /NO_ACTIVE_SESSION|当前没有进行中的录制/.test(errorMessage(error));
}

function formatDuration(samples: number, sampleRate: number): string {
  const seconds = Math.max(0, Math.floor(samples / Math.max(sampleRate, 1)));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}

function db(value: number): string {
  if (value <= 0.00001) return '−∞ dB';
  return `${Math.max(-99, 20 * Math.log10(value)).toFixed(1)} dB`;
}

function safeSessionName(value: string): string {
  const cleaned = value.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[. ]+$/g, '');
  return cleaned || 'recording';
}

function timestamp(): string {
  const now = new Date();
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((part) => String(part).padStart(2, '0')).join('');
  return `${date}-${time}`;
}

function statusLabel(status: string): string {
  return ({ pending: '待录', review: '待确认', accepted: '已确认', skipped: '已跳过' } as Record<string, string>)[status] ?? status;
}

function latestUsableAttempt(item: ItemState): Attempt | undefined {
  for (let index = item.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = item.attempts[index];
    if (attempt.status !== 'interrupted' && attempt.end_sample > attempt.start_sample) return attempt;
  }
  return undefined;
}

function recordingState(recording: RecordingHistoryEntry): { kind: RecordingStateKind; label: string } {
  if (recording.status === 'faulted' || recording.overflow_samples > 0) return { kind: 'attention', label: '需要检查' };
  if (recording.is_active && recording.status === 'stopping') {
    return { kind: 'attention', label: '安全停止中' };
  }
  if (recording.is_active) return { kind: 'unfinished', label: '当前录制' };
  if (recording.status === 'recording' || recording.status === 'stopping') {
    return { kind: 'attention', label: '异常中断' };
  }
  if (recording.pending_items + recording.review_items > 0) return { kind: 'unfinished', label: '未完成' };
  return { kind: 'completed', label: '已完成' };
}

function recordingMatchesFilter(recording: RecordingHistoryEntry, filter: HistoryFilter): boolean {
  if (filter === 'all') return true;
  const kind = recordingState(recording).kind;
  return filter === 'completed' ? kind === 'completed' : kind !== 'completed';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'check': return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case 'chevron-left': return <svg {...common}><path d="m15 18-6-6 6-6" /></svg>;
    case 'chevron-right': return <svg {...common}><path d="m9 18 6-6-6-6" /></svg>;
    case 'export': return <svg {...common}><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 15v4h14v-4" /></svg>;
    case 'file': return <svg {...common}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>;
    case 'folder': return <svg {...common}><path d="M3 6h7l2 2h9v11H3z" /></svg>;
    case 'history': return <svg {...common}><path d="M4 5v5h5" /><path d="M5.2 16a8 8 0 1 0 .1-8.2L4 10" /><path d="M12 7v5l3 2" /></svg>;
    case 'home': return <svg {...common}><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10M9 20v-6h6v6" /></svg>;
    case 'headphones': return <svg {...common}><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><path d="M4 14h4v7H5a1 1 0 0 1-1-1zm16 0h-4v7h3a1 1 0 0 0 1-1z" /></svg>;
    case 'meter': return <svg {...common}><path d="M4 18V9m5 9V5m6 13v-7m5 7V3" /></svg>;
    case 'microphone': return <svg {...common}><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
    case 'play': return <svg {...common}><path d="m8 5 11 7-11 7z" /></svg>;
    case 'plus': return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'record': return <svg {...common}><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" /></svg>;
    case 'refresh': return <svg {...common}><path d="M20 6v5h-5" /><path d="M18.5 15a7 7 0 1 1-.4-6.5L20 11" /></svg>;
    case 'retake': return <svg {...common}><path d="M3 7v5h5" /><path d="M5.5 16a8 8 0 1 0 .4-8.5L3 12" /></svg>;
    case 'skip': return <svg {...common}><path d="m5 5 10 7L5 19zM19 5v14" /></svg>;
    case 'sliders': return <svg {...common}><path d="M4 6h7m4 0h5M11 3v6M4 18h5m4 0h7M9 15v6M4 12h11m4 0h1M15 9v6" /></svg>;
    case 'stop': return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" /></svg>;
  }
}

function StudioChrome({ phase, title, engineStatus, onBack }: { phase: Phase; title: string; engineStatus: EngineStatus; onBack?: () => void }) {
  const phaseOrder: Phase[] = ['setup', 'running', 'finished'];
  const currentPhase = phaseOrder.indexOf(phase);
  return <header className="workflow-header">
    <div className="workflow-identity"><span><img src={appLogo} alt="DataBaker" /></span>{onBack && <button title="返回录制任务" onClick={onBack}><Icon name="chevron-left" size={16} /></button>}<div><small>{phase === 'setup' ? '新建任务' : phase === 'running' ? '正在采集' : '任务已结束'}</small><strong title={title}>{title}</strong></div></div>
    <nav className="workflow-steps" aria-label="任务阶段">
      {(['准备', '采集', '交付'] as const).map((label, index) => <span key={label} className={index === currentPhase ? 'active' : index < currentPhase ? 'complete' : ''}><i>{index < currentPhase ? <Icon name="check" size={11} /> : index + 1}</i>{label}</span>)}
    </nav>
    <div className={`workflow-engine ${engineStatus}`}><i /><span>{engineStatus === 'ready' ? '引擎就绪' : engineStatus === 'connecting' ? '正在连接' : '引擎离线'}</span></div>
  </header>;
}

function StudioStatus({ engineStatus, message, isError = false, right }: { engineStatus: EngineStatus; message: string; isError?: boolean; right: string }) {
  return <footer className="studio-status">
    <span className={`status-engine ${engineStatus}`}><i />{engineStatus === 'ready' ? '录音引擎已连接' : engineStatus === 'connecting' ? '连接录音引擎…' : '录音引擎离线'}</span>
    <span className={isError ? 'status-message error' : 'status-message'}>{message}</span>
    <span className="status-format">{right}</span>
  </footer>;
}

function HomeHeader({ engineStatus }: { engineStatus: EngineStatus }) {
  return <header className="home-header">
    <div className="home-brand"><span className="home-brand-mark"><img src={appLogo} alt="DataBaker" /></span><div><strong>DataBaker Recorder</strong><small>桌面音频采集</small></div></div>
    <div className={`home-engine ${engineStatus}`}><i /><span>{engineStatus === 'ready' ? '录音引擎已就绪' : engineStatus === 'connecting' ? '正在连接录音引擎' : '录音引擎离线'}</span></div>
  </header>;
}

function RecorderApp() {
  const [phase, setPhase] = useState<Phase>('home');
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('connecting');
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [sampleRate, setSampleRate] = useState(48_000);
  const [bitDepth, setBitDepth] = useState(24);
  const [inputChannel, setInputChannel] = useState(1);
  const [sessionName, setSessionName] = useState('朗读采集');
  const [outputDir, setOutputDir] = useState('');
  const [scriptFile, setScriptFile] = useState('');
  const [scriptItems, setScriptItems] = useState<ScriptItem[]>([]);
  const [scriptErrors, setScriptErrors] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [sessionDir, setSessionDir] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  const [attemptStartSample, setAttemptStartSample] = useState(0);
  const [attemptRecordingStartedSample, setAttemptRecordingStartedSample] = useState(0);
  const [reviewAttemptId, setReviewAttemptId] = useState<string | null>(null);
  const [meter, setMeter] = useState<Meter>(emptyMeter);
  const [noiseThresholdDbfs, setNoiseThresholdDbfs] = useState(-42);
  const [silenceDurationMs, setSilenceDurationMs] = useState(1_000);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('正在连接本地录音引擎…');
  const [error, setError] = useState('');
  const [dataSafetyAlert, setDataSafetyAlert] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const [recordings, setRecordings] = useState<RecordingHistoryEntry[]>([]);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [resumingSessionDir, setResumingSessionDir] = useState('');
  const [sealingSessionDir, setSealingSessionDir] = useState('');
  const [sealConfirmRecording, setSealConfirmRecording] = useState<RecordingHistoryEntry | null>(null);
  const [resumeError, setResumeError] = useState<{ sessionDir: string; message: string } | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const resumeOperationRef = useRef(false);
  const sealOperationRef = useRef(false);
  const outputDirRef = useRef('');

  const filteredRecordings = useMemo(() => recordings.filter((recording) => (
    recordingMatchesFilter(recording, historyFilter)
  )), [historyFilter, recordings]);

  const items: ItemState[] = snapshot?.items ?? scriptItems.map((item) => ({
    ...item,
    status: 'pending',
    attempts: [],
    selected_attempt_id: null,
  }));
  const currentItem = items[currentIndex] ?? null;
  const selectedDevice = devices.find((device) => device.id === deviceId) ?? null;
  const maximumInputChannels = Math.max(1, ...(selectedDevice?.input_channels ?? [1]));
  const rateOptions = useMemo(() => {
    if (!selectedDevice?.sample_rates.length) return [44_100, 48_000];
    const candidates = [...new Set([
      16_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000,
      ...selectedDevice.sample_rates,
      ...(selectedDevice.configurations?.flatMap((configuration) => [
        configuration.min_sample_rate,
        configuration.max_sample_rate,
      ]) ?? []),
    ])].sort((left, right) => left - right);
    if (selectedDevice.configurations?.length) {
      return candidates.filter((rate) => selectedDevice.configurations?.some((configuration) => (
        configuration.channels >= inputChannel
        && rate >= configuration.min_sample_rate
        && rate <= configuration.max_sample_rate
      )));
    }
    const minimum = Math.min(...selectedDevice.sample_rates);
    const maximum = Math.max(...selectedDevice.sample_rates);
    return candidates.filter((rate) => rate >= minimum && rate <= maximum);
  }, [inputChannel, selectedDevice]);
  const activeInputChannels = selectedDevice?.configurations?.length
    ? Math.max(1, ...selectedDevice.configurations
      .filter((configuration) => sampleRate >= configuration.min_sample_rate && sampleRate <= configuration.max_sample_rate)
      .map((configuration) => configuration.channels))
    : maximumInputChannels;
  const captureFormats = [...new Set(selectedDevice?.configurations
    ?.filter((configuration) => (
      configuration.channels >= inputChannel
      && sampleRate >= configuration.min_sample_rate
      && sampleRate <= configuration.max_sample_rate
    ))
    .map((configuration) => configuration.sample_format.toUpperCase()) ?? [])];
  const counts = useMemo(() => items.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {} as Record<string, number>), [items]);
  const completed = (counts.accepted ?? 0) + (counts.skipped ?? 0);
  const sampleRateForDisplay = snapshot?.audio_format.sample_rate ?? sampleRate;
  const bitDepthForDisplay = snapshot?.audio_format.bit_depth ?? bitDepth;
  const sessionDuration = formatDuration(meter.captured_samples, sampleRateForDisplay);
  const attemptDuration = recording ? formatDuration(meter.captured_samples - attemptStartSample, sampleRateForDisplay) : '00:00:00';
  const peakPercent = Math.min(100, Math.max(0, meter.peak * 100));
  const rmsPercent = Math.min(100, Math.max(0, meter.rms * 100));
  const effectiveSilenceDurationMs = snapshot?.silence_duration_ms ?? silenceDurationMs;
  const requiredSilenceSamples = sampleRateForDisplay * effectiveSilenceDurationMs / 1_000;
  const silenceProgress = Math.min(1, meter.silence_samples / Math.max(1, requiredSilenceSamples));
  const preSilenceReady = meter.silence_samples >= requiredSilenceSamples;
  const hasSpoken = recording && meter.last_signal_sample > attemptRecordingStartedSample;
  const postSilenceReady = hasSpoken && meter.silence_samples >= requiredSilenceSamples;
  const captureFault = meter.faulted || meter.overflow_samples > 0 || meter.storage_status === 'critical';
  const cue = phase !== 'running' || !currentItem
    ? 'idle'
    : recording
      ? postSilenceReady ? 'post-ready' : 'recording'
      : reviewAttemptId || currentItem.status === 'review'
        ? 'review'
        : preSilenceReady ? 'ready' : 'checking';
  const cueLabel = ({
    idle: '等待任务',
    checking: `静音检测中 ${Math.min(effectiveSilenceDurationMs / 1_000, meter.silence_samples / Math.max(sampleRateForDisplay, 1)).toFixed(1)} / ${(effectiveSilenceDurationMs / 1_000).toFixed(1)}s`,
    ready: '静音达标 · 可开始录制',
    recording: hasSpoken ? '录制中 · 等待尾部静音' : '录制中 · 请开始朗读',
    'post-ready': '尾部静音达标 · 可完成',
    review: '本句已录制 · 等待监听确认',
  } as const)[cue];
  const prompterState = useMemo<PrompterState>(() => ({
    sessionName: snapshot?.session_id ?? sessionName,
    sequence: currentItem ? currentIndex + 1 : 0,
    total: items.length,
    id: currentItem?.id ?? '',
    text: currentItem?.text ?? '',
    label: currentItem?.label ?? '',
    cue,
    cueLabel,
    silenceProgress: recording && !hasSpoken ? 0 : silenceProgress,
    silenceDurationMs: effectiveSilenceDurationMs,
  }), [cue, cueLabel, currentIndex, currentItem?.id, currentItem?.label, currentItem?.text, effectiveSilenceDurationMs, hasSpoken, items.length, recording, sessionName, silenceProgress, snapshot?.session_id]);

  async function run<T>(label: string, action: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setError('');
    try {
      return await action();
    } catch (caught) {
      setError(errorMessage(caught));
      return null;
    } finally {
      setBusy('');
    }
  }

  async function queryRunningSession(): Promise<OptionalRunningSessionState> {
    try {
      return await window.recorder.request<OptionalRunningSessionState>('get_state_optional');
    } catch {
      // During renderer hot reload, an already-running Electron main process may
      // still speak the previous protocol. Keep the live recording reconnectable
      // until the operator can safely restart the whole desktop application.
      try {
        const current = await window.recorder.request<RunningSessionState>('get_state');
        return { ...current, active: true };
      } catch (caught) {
        if (isNoActiveSessionError(caught)) return { active: false };
        throw caught;
      }
    }
  }

  async function loadDevices(): Promise<AudioDevice[]> {
    const result = await run('正在检测录音设备…', () => window.recorder.request<{
      devices: AudioDevice[];
      default_device_id: string | null;
    }>('list_devices'));
    if (!result) return [];
    setDevices(result.devices);
    const preferred = result.devices.find((device) => device.id === deviceId)
      ?? result.devices.find((device) => device.id === result.default_device_id)
      ?? result.devices[0]
      ?? null;
    setDeviceId(preferred?.id ?? '');
    setDeviceName(preferred?.name ?? '');
    setEngineStatus('ready');
    setNotice(result.devices.length ? '录音引擎已就绪' : '未发现录音输入设备');
    return result.devices;
  }

  async function refreshRecordings(root = outputDir) {
    if (!root) {
      setRecordings([]);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const result = await window.recorder.listRecordings(root);
      setRecordings(result);
    } catch (caught) {
      setError(`无法读取历史录制：${errorMessage(caught)}`);
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    window.recorder.defaultOutput().then((value) => {
      if (!active) return;
      outputDirRef.current = value;
      setOutputDir(value);
      void refreshRecordings(value);
    }).catch((caught) => {
      if (active) setError(`无法读取默认保存位置：${errorMessage(caught)}`);
    });
    window.recorder.request('hello').then(() => {
      if (!active) return;
      setEngineStatus('ready');
      void loadDevices().then((availableDevices) => queryRunningSession().then((current) => {
        if (!active || !current.active) return;
        if (current.snapshot.status !== 'recording') {
          setError('上次录音仍在安全收尾，已保留任务列表并阻止进入录制界面。');
          void refreshRecordings(outputDirRef.current);
          return;
        }
        enterRunningSession(current, false, availableDevices);
      })).catch(() => undefined);
    }).catch((caught) => {
      if (!active) return;
      setEngineStatus('offline');
      setError(`无法连接录音引擎：${errorMessage(caught)}`);
    });
    const unsubscribeEvent = window.recorder.onEngineEvent((raw) => {
      const message = raw as EngineEvent;
      const terminalRecoveryFailure = engineRecoveryFailure(message);
      if (message.event === 'meter') {
        const nextMeter = message.payload as Meter;
        setMeter(nextMeter);
        if (nextMeter.faulted) setError('录音已触发数据安全保护并停止写入，请安全结束任务；已持久化的原始母轨会保留。');
      } else if (message.event === 'engine_recovered') {
        const payload = message.payload as { state?: RunningSessionState };
        setEngineStatus('ready');
        setError('');
        if (payload.state?.snapshot.status === 'recording') {
          enterRunningSession(payload.state, true);
          setNotice('录音引擎已自动恢复；异常时的当前句已标记为中断，可继续录制。');
        } else if (payload.state?.snapshot) {
          setPhase('home');
          setError('录音引擎仍在安全收尾，未进入可录制状态。');
          void refreshRecordings(outputDirRef.current);
        }
      } else if (terminalRecoveryFailure) {
        resumeOperationRef.current = false;
        sealOperationRef.current = false;
        setEngineStatus('offline');
        setResumingSessionDir('');
        setSealingSessionDir('');
        setResumeError(null);
        setSealConfirmRecording(null);
        setPhase('home');
        setSnapshot(null);
        setSessionDir('');
        setCurrentIndex(0);
        setRecording(false);
        setAttemptStartSample(0);
        setAttemptRecordingStartedSample(0);
        setReviewAttemptId(null);
        setMeter(emptyMeter);
        setExportResult(null);
        setAudioUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return '';
        });
        setFinishConfirmOpen(false);
        setBusy('');
        setDataSafetyAlert('');
        setError(`录音引擎连续三次自动恢复失败：${terminalRecoveryFailure.error}。已返回任务列表，已落盘母音频仍保留；请使用“修复并封存”。`);
        setNotice('已返回任务列表。已落盘母音频仍保留，请使用“修复并封存”。');
        void refreshRecordings(outputDirRef.current);
      } else if (message.event === 'offline_seal_cleanup_finished') {
        setEngineStatus('ready');
        setNotice('离线封存的后台清理已完成，可以刷新任务或重试。');
      } else if (message.event === 'engine_idle_after_stopping_crash') {
        setEngineStatus('ready');
        setNotice('录音引擎已重启；中断任务的已落盘母音频仍保留，请使用“修复并封存”。');
      }
    });
    const unsubscribeOffline = window.recorder.onEngineOffline((message) => {
      setEngineStatus('offline');
      setError(message);
    });
    return () => {
      active = false;
      unsubscribeEvent();
      unsubscribeOffline();
    };
    // Initial engine discovery only runs when the renderer mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    outputDirRef.current = outputDir;
  }, [outputDir]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  useEffect(() => {
    window.recorder.sendPrompterState(prompterState);
  }, [prompterState]);

  useEffect(() => {
    if (inputChannel > activeInputChannels) setInputChannel(1);
    if (selectedDevice && !rateOptions.includes(sampleRate)) {
      setSampleRate(rateOptions.includes(48_000) ? 48_000 : rateOptions[0] ?? 48_000);
    }
  }, [activeInputChannels, inputChannel, rateOptions, sampleRate, selectedDevice]);

  function enterRunningSession(current: RunningSessionState, wasRecovered: boolean, availableDevices = devices) {
    const nextSnapshot = current.snapshot;
    const threshold = nextSnapshot.silence_threshold_dbfs ?? nextSnapshot.noise_check?.threshold_dbfs ?? -42;
    const activeIndex = current.active_attempt
      ? nextSnapshot.items.findIndex((item) => item.id === current.active_attempt?.item_id)
      : nextSnapshot.items.findIndex((item) => item.status === 'review' || item.status === 'pending');
    setSnapshot(nextSnapshot);
    if (current.session_dir) setSessionDir(current.session_dir);
    setSessionName(nextSnapshot.session_id);
    setScriptFile(nextSnapshot.script_name ?? '');
    setDeviceId(nextSnapshot.device_id ?? availableDevices.find((device) => device.name === nextSnapshot.device_name)?.id ?? '');
    setDeviceName(nextSnapshot.device_name);
    setSampleRate(nextSnapshot.audio_format.sample_rate);
    setBitDepth(nextSnapshot.audio_format.bit_depth);
    setInputChannel(nextSnapshot.audio_format.input_channel ?? 1);
    setSilenceDurationMs(nextSnapshot.silence_duration_ms ?? 1_000);
    setNoiseThresholdDbfs(threshold);
    setCurrentIndex(Math.max(0, activeIndex));
    setRecording(Boolean(current.active_attempt));
    setAttemptStartSample(current.active_attempt?.start_sample ?? 0);
    setAttemptRecordingStartedSample(current.active_attempt?.recording_started_sample ?? current.active_attempt?.start_sample ?? 0);
    setReviewAttemptId(null);
    setMeter({
      ...emptyMeter,
      captured_samples: nextSnapshot.captured_samples,
      committed_samples: nextSnapshot.committed_samples,
      overflow_samples: nextSnapshot.overflow_samples,
      silence_threshold_dbfs: threshold,
      silence_duration_ms: nextSnapshot.silence_duration_ms,
    });
    setExportResult(null);
    setFinishConfirmOpen(false);
    setPhase('running');
    setNotice(current.active_attempt
      ? `已重新连接正在录制的 ${current.active_attempt.item_id}`
      : wasRecovered
        ? '任务已恢复，请确认输入电平后继续录制。'
        : '已重新连接当前录制。');
    const warning = recoveryWarning('恢复时发现存储异常', current.recovery_warnings);
    if (warning) setDataSafetyAlert(`${warning}。已使用最新完整副本，请完成本次采集后检查交付。`);
  }

  async function chooseScript() {
    const file = await window.recorder.openScript();
    if (!file) return;
    const parsed = parseScript(file.content);
    setScriptFile(file.name);
    setSessionName(file.name.replace(/\.[^.]+$/, '') || '新录制');
    setScriptItems(parsed.items);
    setScriptErrors(parsed.errors);
    setNotice(parsed.errors.length ? '脚本需要修正后才能开始' : `已导入 ${parsed.items.length} 条文本`);
  }

  async function chooseScriptFile(file: File | undefined) {
    if (!file) return;
    const parsed = parseScript(await file.text());
    setScriptFile(file.name);
    setSessionName(file.name.replace(/\.[^.]+$/, '') || '新录制');
    setScriptItems(parsed.items);
    setScriptErrors(parsed.errors);
    setNotice(parsed.errors.length ? '脚本需要修正后才能开始' : `已导入 ${parsed.items.length} 条文本`);
  }

  async function chooseOutput() {
    const selected = await window.recorder.chooseOutput();
    if (selected) {
      setOutputDir(selected);
      await refreshRecordings(selected);
    }
  }

  async function openPrompterPanel() {
    window.recorder.sendPrompterState(prompterState);
    const opened = await run('正在打开领读面板…', () => window.recorder.openPrompter());
    if (opened) setNotice('领读面板已打开；如有外接显示器，已优先放置到外接屏。');
  }

  async function startSession() {
    if (!scriptItems.length || scriptErrors.length || !selectedDevice || !outputDir) return;
    const sessionId = `${safeSessionName(sessionName)}-${timestamp()}`;
    const destination = await window.recorder.joinPath(outputDir, sessionId);
    const result = await run('正在启动持续录音…', () => window.recorder.request<{
      snapshot: SessionSnapshot;
      session_dir: string;
    }>('start_session', {
      session_dir: destination,
      session_id: sessionId,
      script_name: scriptFile,
      device_id: selectedDevice.id,
      device_name: selectedDevice.name,
      sample_rate: sampleRate,
      bit_depth: bitDepth,
      input_channel: inputChannel,
      silence_duration_ms: silenceDurationMs,
      silence_threshold_dbfs: noiseThresholdDbfs,
      items: scriptItems,
    }));
    if (!result) return;
    setDataSafetyAlert('');
    setSnapshot(result.snapshot);
    setSessionDir(result.session_dir);
    setPhase('running');
    setCurrentIndex(0);
    setMeter(emptyMeter);
    setNotice('录制已建立，请确认实时输入电平后开始第一句。');
  }

  async function refreshState(): Promise<SessionSnapshot | null> {
    const result = await window.recorder.request<{ snapshot: SessionSnapshot }>('get_state');
    setSnapshot(result.snapshot);
    return result.snapshot;
  }

  async function startAttempt() {
    if (!currentItem || recording || phase !== 'running') return;
    if (!preSilenceReady) {
      setNotice(`开始前请保持静音 ${(effectiveSilenceDurationMs / 1_000).toFixed(1)} 秒。`);
      return;
    }
    const result = await run('正在开始…', () => window.recorder.request<{
      attempt_id: string;
      start_sample: number;
      recording_started_sample: number;
    }>('start_attempt', { item_id: currentItem.id }));
    if (!result) return;
    setRecording(true);
    setAttemptStartSample(result.start_sample);
    setAttemptRecordingStartedSample(result.recording_started_sample);
    setReviewAttemptId(null);
    setNotice(`正在录制 ${currentItem.id}`);
  }

  async function stopAttempt() {
    if (!recording) return;
    const force = !postSilenceReady;
    const result = await run('正在封闭本次录音…', () => window.recorder.request<{
      item_id: string;
      attempt: Attempt | null;
      discarded?: boolean;
      interrupted?: boolean;
      forced?: boolean;
    }>('stop_attempt', { force }));
    if (!result) return;
    setRecording(false);
    setAttemptRecordingStartedSample(0);
    if (!result.attempt) {
      setReviewAttemptId(null);
      await refreshState();
      if (result.discarded && !result.interrupted) {
        setNotice('未检测到有效语音，本句已取消，没有生成可交付的录音版本。');
        return;
      }
      setNotice('写盘异常，本句没有可用音频；请安全结束并检查原始母轨，常规交付已阻断。');
      return;
    }
    if (result.interrupted || result.attempt.status === 'interrupted') {
      setReviewAttemptId(null);
      await refreshState();
      setDataSafetyAlert('音频采集故障已触发保护；当前句已标记为异常中断，不会进入常规交付。');
      setNotice('已封存可恢复的母轨，请结束本次录制并检查原始文件。');
      return;
    }
    setReviewAttemptId(result.attempt.attempt_id);
    await refreshState();
    setNotice((result.forced ?? result.attempt.forced_without_tail_silence)
      ? '已强制完成本句，尾部静音不足；请试听后确认或重录。'
      : '录制完成：请试听、确认，或按 R 重录。');
  }

  function moveToNext(snapshotValue: SessionSnapshot) {
    const after = snapshotValue.items.findIndex((item, index) => index > currentIndex && item.status === 'pending');
    const anywhere = snapshotValue.items.findIndex((item) => item.status === 'pending');
    const next = after >= 0 ? after : anywhere;
    if (next >= 0) {
      setCurrentIndex(next);
      setNotice('已确认，准备下一句。');
    } else {
      setNotice('所有句子均已处理，可以结束录制并导出。');
    }
  }

  async function acceptAttempt() {
    if (!currentItem || recording) return;
    const attemptId = reviewAttemptId
      ?? currentItem.selected_attempt_id
      ?? latestUsableAttempt(currentItem)?.attempt_id;
    if (!attemptId) return;
    const accepted = await run('正在保存确认结果…', () => window.recorder.request('accept_attempt', {
      item_id: currentItem.id,
      attempt_id: attemptId,
    }));
    if (!accepted) return;
    const latest = await refreshState();
    setReviewAttemptId(null);
    if (latest) moveToNext(latest);
  }

  async function skipItem() {
    if (!currentItem || recording) return;
    const skipped = await run('正在保存跳过状态…', () => window.recorder.request('skip_item', { item_id: currentItem.id }));
    if (!skipped) return;
    const latest = await refreshState();
    setReviewAttemptId(null);
    if (latest) moveToNext(latest);
  }

  async function previewAttempt() {
    if (!currentItem || recording) return;
    const attemptId = reviewAttemptId
      ?? currentItem.selected_attempt_id
      ?? latestUsableAttempt(currentItem)?.attempt_id;
    if (!attemptId) return;
    const rendered = await run('正在准备试听…', () => window.recorder.request<{ file_path: string }>('render_attempt', {
      item_id: currentItem.id,
      attempt_id: attemptId,
    }));
    if (!rendered) return;
    const audio = await run('正在读取试听文件…', () => window.recorder.readAudio(rendered.file_path));
    if (!audio) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(new Blob([audio], { type: 'audio/wav' }));
    setAudioUrl(url);
    setTimeout(() => void audioRef.current?.play(), 0);
    setNotice(`正在试听 ${attemptId}`);
  }

  async function exportSession(targetDir = sessionDir) {
    if (!targetDir) return;
    const exported = await run('正在导出单句 WAV 和元数据…', () => window.recorder.request<ExportResult>('export_session', {
      session_dir: targetDir,
    }));
    if (!exported) return;
    setExportResult(exported);
    const warning = recoveryWarning('导出时发现存储异常', exported.recovery_warnings);
    if (warning) setDataSafetyAlert(`${warning}。交付已基于最新完整投影生成，请抽检。`);
    setNotice(`导出完成：${exported.exported_count} 条 WAV${warning ? '，但需要抽检' : ''}`);
  }

  async function exportHistoricalRecording(recording: RecordingHistoryEntry) {
    const exported = await run('正在重新生成交付文件…', () => window.recorder.request<ExportResult>('export_session', {
      session_dir: recording.session_dir,
    }));
    if (!exported) return;
    const warning = recoveryWarning('导出时发现存储异常', exported.recovery_warnings);
    if (warning) setDataSafetyAlert(`${warning}。交付已生成，请抽检。`);
    setNotice(`“${recording.session_id}”已导出 ${exported.exported_count} 条 WAV${warning ? '，但需要抽检' : ''}`);
    await refreshRecordings();
  }

  async function resumeHistoricalRecording(recording: RecordingHistoryEntry) {
    if (resumeOperationRef.current || sealOperationRef.current) return;
    if (recording.overflow_samples > 0) {
      setError('该任务记录过写盘溢出，不能直接续接母轨；请先检查原始文件。');
      return;
    }
    resumeOperationRef.current = true;
    setResumingSessionDir(recording.session_dir);
    setResumeError(null);
    setBusy('正在校验母音频并恢复录制…');
    setError('');
    setDataSafetyAlert('');
    let resumed: RunningSessionState;
    try {
      resumed = await window.recorder.request<RunningSessionState>('resume_session', {
        session_dir: recording.session_dir,
      });
    } catch (caught) {
      const message = `无法恢复“${recording.session_id}”：${errorMessage(caught)}`;
      setError(message);
      setResumeError({ sessionDir: recording.session_dir, message });
      setBusy('');
      return;
    } finally {
      resumeOperationRef.current = false;
      setResumingSessionDir('');
    }
    setBusy('');
    setEngineStatus('ready');
    enterRunningSession(resumed, true);
  }

  async function sealHistoricalRecording(recording: RecordingHistoryEntry) {
    if (sealOperationRef.current || resumeOperationRef.current) return;
    sealOperationRef.current = true;
    setSealingSessionDir(recording.session_dir);
    setBusy('正在修复并封存已落盘的母音频…');
    setError('');
    setDataSafetyAlert('');
    let sealed: SealInterruptedSessionResult;
    try {
      sealed = await window.recorder.request<SealInterruptedSessionResult>(
        'seal_interrupted_session',
        { session_dir: recording.session_dir, session_id: recording.session_id },
      );
    } catch (caught) {
      const message = `无法封存“${recording.session_id}”：${errorMessage(caught)}`;
      setError(message);
      setResumeError({ sessionDir: recording.session_dir, message });
      return;
    } finally {
      sealOperationRef.current = false;
      setSealingSessionDir('');
      setBusy('');
    }
    setResumeError(null);
    setEngineStatus('ready');
    await refreshRecordings();
    const warning = recoveryWarning('封存时发现存储异常', sealed.warnings);
    const durableDuration = formatDuration(sealed.durable_frames, recording.sample_rate);
    if (sealed.fault_preserved || sealed.snapshot.status === 'faulted') {
      setDataSafetyAlert(
        `已保留 ${durableDuration} 可恢复母音频，但任务仍带有采集故障标记；不会生成常规交付，请人工检查原始分段。`,
      );
      return;
    }
    if (warning) setDataSafetyAlert(`${warning}。已落盘的母音频仍已封存，请抽检。`);
    const recovered = sealed.recovered_attempts
      ? `，${sealed.recovered_attempts} 个未闭合录音版本已标记为异常中断`
      : '';
    const canExportNow = recording.pending_items + recording.review_items === 0;
    setNotice(sealed.no_op
      ? `“${recording.session_id}”已处于安全封存状态${canExportNow ? '，现在可以生成交付' : ''}`
      : `“${recording.session_id}”已封存 ${durableDuration} 母音频${recovered}${canExportNow ? '，现在可以生成交付' : ''}`);
  }

  async function returnToActiveRecording() {
    const current = await run('正在返回当前录制…', () => window.recorder.request<RunningSessionState>('get_state'));
    if (!current) return;
    if (current.snapshot.status !== 'recording') {
      setError('当前任务仍在安全收尾，不能进入录制界面。');
      await refreshRecordings();
      return;
    }
    enterRunningSession(current, false);
  }

  async function continuePendingStop(recording: RecordingHistoryEntry) {
    const stopped = await run('正在继续安全封存…', () => (
      window.recorder.request<StoppedSessionState>('stop_session')
    ));
    await refreshRecordings();
    if (!stopped) return;
    setEngineStatus('ready');
    setNotice(`“${recording.session_id}”已完成安全收尾。`);
  }

  async function openRecordingExport(recording: RecordingHistoryEntry) {
    const target = await window.recorder.joinPath(recording.session_dir, 'export');
    await run('正在打开交付目录…', () => window.recorder.openPath(target));
  }

  function finishSession() {
    if ((recording && !captureFault) || !sessionDir) return;
    setFinishConfirmOpen(true);
  }

  async function confirmFinishSession() {
    if ((recording && !captureFault) || !sessionDir) return;
    setFinishConfirmOpen(false);
    const stopped = await run('正在安全结束持续录音…', () => window.recorder.request<StoppedSessionState>('stop_session'));
    if (!stopped) return;
    const finishedDir = stopped.session_dir ?? sessionDir;
    setSnapshot(stopped.snapshot);
    setSessionDir(finishedDir);
    setPhase('finished');
    const warning = recoveryWarning('安全结束时收到警告', stopped.warnings);
    if (warning) setDataSafetyAlert(`${warning}。原始母轨已保留，请检查交付结果。`);
    await window.recorder.closePrompter().catch(() => undefined);
    const stoppedWithFault = stopped.snapshot.status === 'faulted'
      || stopped.snapshot.overflow_samples > 0
      || captureFault;
    if (stoppedWithFault) {
      setRecording(false);
      setDataSafetyAlert('采集故障已安全封存：原始母轨保留，当前句不进入常规交付。请先检查故障标记和原始分段。');
    } else {
      await exportSession(finishedDir);
    }
    await refreshRecordings();
  }

  function resetForNewSession() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setResumeError(null);
    setResumingSessionDir('');
    setSealConfirmRecording(null);
    setPhase('setup');
    setSnapshot(null);
    setSessionDir('');
    setRecording(false);
    setAttemptStartSample(0);
    setAttemptRecordingStartedSample(0);
    setReviewAttemptId(null);
    setMeter(emptyMeter);
    setExportResult(null);
    setAudioUrl('');
    setFinishConfirmOpen(false);
    setNotice('可以沿用当前脚本和设备创建新录制。');
  }

  function beginNewRecording() {
    resetForNewSession();
    setScriptFile('');
    setScriptItems([]);
    setScriptErrors([]);
    setSessionName('新录制');
    setNotice('请选择一份 CSV 或 TXT 开始录制。');
  }

  function returnToRecordings() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setResumingSessionDir('');
    setResumeError(null);
    setSealConfirmRecording(null);
    setPhase('home');
    setSnapshot(null);
    setSessionDir('');
    setRecording(false);
    setAttemptStartSample(0);
    setAttemptRecordingStartedSample(0);
    setReviewAttemptId(null);
    setMeter(emptyMeter);
    setExportResult(null);
    setAudioUrl('');
    setFinishConfirmOpen(false);
    setNotice('历史录制已刷新。');
    void refreshRecordings();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (sealConfirmRecording) {
        if (event.key === 'Escape' && !sealingSessionDir) setSealConfirmRecording(null);
        return;
      }
      if (finishConfirmOpen) {
        if (event.key === 'Escape') setFinishConfirmOpen(false);
        return;
      }
      if (phase !== 'running' || busy) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, audio')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        if (recording && captureFault) finishSession();
        else if (recording) void stopAttempt();
        else if (reviewAttemptId || currentItem?.status === 'review') void acceptAttempt();
        else void startAttempt();
      } else if (event.key.toLowerCase() === 'r' && !recording) {
        void startAttempt();
      } else if (event.key.toLowerCase() === 'p' && !recording) {
        void previewAttempt();
      } else if (event.key.toLowerCase() === 's' && !recording) {
        void skipItem();
      } else if (event.key === 'ArrowLeft' && !recording) {
        setCurrentIndex((index) => Math.max(0, index - 1));
        setReviewAttemptId(null);
      } else if (event.key === 'ArrowRight' && !recording) {
        setCurrentIndex((index) => Math.min(items.length - 1, index + 1));
        setReviewAttemptId(null);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (phase === 'home') {
    const filters: Array<{ id: HistoryFilter; label: string }> = [
      { id: 'all', label: '全部' },
      { id: 'completed', label: '已完成' },
      { id: 'unfinished', label: '未完成' },
    ];
    return <div className="home-shell">
      <HomeHeader engineStatus={engineStatus} />
      <main className="home-main" data-testid="recordings-workspace">
        <header className="home-titlebar">
          <div><h1>录制任务</h1><p>从脚本开始一次采集，或查看本机已有任务。</p></div>
          <button data-testid="new-recording" className="home-primary" onClick={beginNewRecording} disabled={Boolean(busy)}><Icon name="plus" size={16} />新建录制</button>
        </header>

        <section className="home-controls" aria-label="任务筛选与存储位置">
          <nav className="home-filters" aria-label="录制状态筛选">
            {filters.map((filter) => <button key={filter.id} className={historyFilter === filter.id ? 'active' : ''} onClick={() => setHistoryFilter(filter.id)}>
              <span>{filter.label}</span><em>{recordings.filter((recording) => recordingMatchesFilter(recording, filter.id)).length}</em>
            </button>)}
          </nav>
          <div className="home-storage"><Icon name="folder" size={14} /><span>保存到</span><code title={outputDir}>{outputDir || '正在读取默认位置…'}</code><button onClick={() => void chooseOutput()} disabled={Boolean(busy)}>更改</button><button title="刷新任务" aria-label="刷新任务" onClick={() => void refreshRecordings()} disabled={Boolean(busy)}><Icon name="refresh" size={14} /></button></div>
        </section>

        <section className="home-list" aria-label="录制任务列表">
          <div className="home-list-header"><span>任务</span><span>进度</span><span>更新时间</span><span>状态</span><span /></div>
          {historyLoading && <div className="home-empty"><Icon name="refresh" size={20} /><strong>正在读取录制任务</strong></div>}
          {!historyLoading && !filteredRecordings.length && <div className="home-empty"><span className="home-empty-icon"><Icon name="microphone" size={24} /></span><strong>{recordings.length ? '这里还没有任务' : '开始第一条录制任务'}</strong><p>{recordings.length ? '切换到其他状态查看已有任务。' : '导入三列 CSV 或 TXT，配置设备后即可开始采集。'}</p>{!recordings.length && <button className="home-primary" onClick={beginNewRecording} disabled={Boolean(busy)}><Icon name="plus" size={15} />新建录制</button>}</div>}
          {!historyLoading && filteredRecordings.map((recording) => {
            const state = recordingState(recording);
            const handled = recording.accepted_items + recording.skipped_items;
            const progress = recording.total_items ? handled / recording.total_items * 100 : 0;
            const isResuming = resumingSessionDir === recording.session_dir;
            const isSealing = sealingSessionDir === recording.session_dir;
            const rowResumeError = resumeError?.sessionDir === recording.session_dir ? resumeError.message : '';
            const recoveryPlan = planHistoryRecovery(recording);
            return <article key={recording.session_dir} className={`home-recording-row ${rowResumeError ? 'has-error' : ''}`}>
              <div className="home-recording-name"><i className={`recording-dot ${state.kind}`} /><div><strong>{recording.session_id}</strong><small>{recording.script_name || '未记录源文件'} · {recording.sample_rate ? `${recording.sample_rate.toLocaleString()} Hz / ${recording.bit_depth}-bit` : '格式未知'}</small></div></div>
              <div className="home-recording-progress"><span><b>{handled}</b><small> / {recording.total_items}</small></span><i><em style={{ width: `${progress}%` }} /></i></div>
              <time>{formatDateTime(recording.updated_at)}</time>
              <span><em className={`recording-status ${state.kind}`}>{state.label}</em></span>
              <div className="home-row-actions">
                <button title="打开任务目录" aria-label={`打开 ${recording.session_id} 的任务目录`} onClick={() => void run('正在打开录制目录…', () => window.recorder.openPath(recording.session_dir))}><Icon name="folder" size={15} /></button>
                {recording.is_active
                  ? recording.status === 'stopping'
                    ? <button className="row-primary" onClick={() => void continuePendingStop(recording)} disabled={Boolean(busy)}>继续安全停止</button>
                    : <button className="row-primary" onClick={() => void returnToActiveRecording()} disabled={Boolean(busy)}>返回录制</button>
                  : recoveryPlan.primary === 'resume'
                    ? <>{recording.status === 'stopped' && recording.accepted_items > 0 && (recording.export_exists
                      ? <button title="查看已有交付" aria-label={`查看 ${recording.session_id} 的已有交付`} onClick={() => void openRecordingExport(recording)}><Icon name="export" size={15} /></button>
                      : <button title="生成已完成条目的交付" aria-label={`生成 ${recording.session_id} 已完成条目的交付`} onClick={() => void exportHistoricalRecording(recording)} disabled={Boolean(busy)}><Icon name="export" size={15} /></button>)}<button data-testid="resume-recording" className={`row-primary resume ${isResuming ? 'working' : ''}`} aria-busy={isResuming} onClick={() => void resumeHistoricalRecording(recording)} disabled={Boolean(busy) || Boolean(resumingSessionDir) || Boolean(sealingSessionDir)}>{isResuming ? <><i />恢复中…</> : recording.status === 'recording' ? '恢复录制' : '继续录制'}</button>{recoveryPlan.secondary === 'seal' && <button data-testid="seal-recording" className="row-secondary-seal" aria-busy={isSealing} onClick={() => setSealConfirmRecording(recording)} disabled={Boolean(busy) || Boolean(resumingSessionDir) || Boolean(sealingSessionDir)}>{isSealing ? '封存中…' : '修复并封存'}</button>}</>
                    : recoveryPlan.primary === 'seal'
                      ? <button data-testid="seal-recording" className="row-primary seal" aria-busy={isSealing} onClick={() => setSealConfirmRecording(recording)} disabled={Boolean(busy) || Boolean(resumingSessionDir) || Boolean(sealingSessionDir)}>{isSealing ? '封存中…' : '修复并封存'}</button>
                    : recording.export_exists
                  ? <button className="row-primary" onClick={() => void openRecordingExport(recording)}>查看交付</button>
                  : recording.status === 'stopped'
                    ? <button className="row-primary" onClick={() => void exportHistoricalRecording(recording)} disabled={Boolean(busy)}>生成交付</button>
                    : <button className="row-primary" onClick={() => void run('正在打开录制目录…', () => window.recorder.openPath(recording.session_dir))}>检查文件</button>}
              </div>
              {rowResumeError && <div className="home-row-error" role="alert"><strong>恢复未完成</strong><span title={rowResumeError}>{rowResumeError}</span><div className="home-row-error-actions"><button data-testid="seal-recording" className="seal" aria-busy={isSealing} onClick={() => setSealConfirmRecording(recording)} disabled={Boolean(busy) || Boolean(resumingSessionDir) || Boolean(sealingSessionDir)}>{isSealing ? '封存中…' : '修复并封存'}</button><button onClick={() => setResumeError(null)} disabled={Boolean(busy)}>关闭</button></div></div>}
            </article>;
          })}
        </section>

        {(error || dataSafetyAlert || busy || notice) && <div className={`home-notice ${error || dataSafetyAlert ? 'error' : ''}`}><i />{error || dataSafetyAlert || busy || notice}</div>}
      </main>
      {sealConfirmRecording && <div className="dialog-backdrop" role="presentation">
        <section className="studio-dialog seal-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="seal-confirm-title">
          <header><span className="dialog-icon"><Icon name="history" size={19} /></span><div><small>OFFLINE RECOVERY</small><h2 id="seal-confirm-title">修复并封存中断任务？</h2></div></header>
          <p>系统会先确认当前没有活跃录音，再修复已落盘 WAV 头和未闭合版本，并把任务写成可恢复的安全状态。</p>
          <div className="dialog-warning">任务：{sealConfirmRecording.session_id}<br />此操作不会覆盖母音频，也不会自动生成交付。封存后，已完成任务可直接生成交付；未完成任务仍可继续录制。</div>
          <footer><button className="button" onClick={() => setSealConfirmRecording(null)} disabled={Boolean(busy)}>取消</button><button data-testid="confirm-seal-recording" className="button primary" onClick={() => { const recording = sealConfirmRecording; setSealConfirmRecording(null); void sealHistoricalRecording(recording); }} disabled={Boolean(busy)}>确认修复并封存</button></footer>
        </section>
      </div>}
    </div>;
  }

  if (phase === 'setup') {
    const readyToStart = engineStatus === 'ready' && scriptItems.length > 0 && !scriptErrors.length && Boolean(selectedDevice) && Boolean(outputDir) && rateOptions.includes(sampleRate) && inputChannel <= activeInputChannels && captureFormats.length > 0 && !busy;
    return <div className="studio-shell">
      <StudioChrome phase={phase} title="新建录制" engineStatus={engineStatus} onBack={returnToRecordings} />
      <div className="studio-workspace setup-workspace" data-testid="setup-workspace">
        <aside className="tool-rail" aria-label="工具"><button className="active" title="新建录制"><Icon name="file" /></button><button title="音频设备"><Icon name="microphone" /></button><button title="参数"><Icon name="sliders" /></button><span /><button title="返回历史录制" onClick={returnToRecordings}><Icon name="history" /></button></aside>
        <aside className="panel setup-outline">
          <div className="panel-tabs"><button className="active">准备</button><button>预设</button></div>
          <div className="panel-section-title">新建录制</div>
          <ol className="setup-steps">
            <li className={scriptFile && !scriptErrors.length ? 'complete' : 'active'}><span>{scriptFile && !scriptErrors.length ? <Icon name="check" size={13} /> : '1'}</span><div><strong>导入录音脚本</strong><small>{scriptFile || 'CSV / TSV 文本清单'}</small></div></li>
            <li className={deviceName ? 'complete' : ''}><span>{deviceName ? <Icon name="check" size={13} /> : '2'}</span><div><strong>配置音频输入</strong><small>{deviceName || '选择麦克风'}</small></div></li>
            <li className={outputDir ? 'complete' : ''}><span>{outputDir ? <Icon name="check" size={13} /> : '3'}</span><div><strong>保存与命名</strong><small>本地录制目录</small></div></li>
          </ol>
          <div className="outline-note"><Icon name="meter" /><p>进入录制后请先确认实时电平有正常波动，再开始第一句。</p></div>
        </aside>
        <main className="setup-document">
          <div className="document-tabs"><span className="active"><Icon name="sliders" size={13} /> 录制设置 <i>×</i></span></div>
          <div className="document-canvas">
            <header className="document-heading"><div><span className="document-kicker">RECORDING SETUP</span><h1>新建录制</h1><p>选择脚本、声卡输入与交付格式，进入后直接开始录制流程。</p></div><div className="session-badge"><Icon name="microphone" /><span>AUDIO CAPTURE<small>Local / Continuous</small></span></div></header>
            <section className="property-group">
              <div className="property-heading"><span>01</span><div><h2>录音脚本</h2><p>脚本决定条目顺序、ID 与朗读文本</p></div></div>
              <label className={`script-picker ${busy ? 'disabled' : ''}`}><input data-testid="script-file" className="file-input" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" disabled={Boolean(busy)} onChange={(event) => void chooseScriptFile(event.target.files?.[0])} /><span className="picker-icon"><Icon name="file" size={19} /></span><span className="picker-copy"><strong>{scriptFile || '选择 CSV、TSV 或 TXT 脚本'}</strong><small>{scriptFile ? `${scriptItems.length} 个有效条目 · UTF-8` : '三列：序号 / 句子正文 / 标签（备注）'}</small></span><span className="button subtle">浏览…</span></label>
              {scriptErrors.length > 0 && <div className="validation-errors">{scriptErrors.slice(0, 5).map((message) => <p key={message}>{message}</p>)}</div>}
            </section>
            <section className="property-group">
              <div className="property-heading"><span>02</span><div><h2>音频输入</h2><p>选择硬件设备与本次录制格式</p></div></div>
              <div className="form-grid audio-form"><label className="field span-2"><span>输入设备（Windows 系统驱动 / 声卡）</span><div className="field-row"><select value={deviceId} onChange={(event) => { const device = devices.find((candidate) => candidate.id === event.target.value); setDeviceId(event.target.value); setDeviceName(device?.name ?? ''); }} disabled={Boolean(busy)}>{!devices.length && <option value="">未发现输入设备</option>}{devices.map((device) => <option value={device.id} key={device.id}>{device.name}{device.is_default ? '（系统默认）' : ''}</option>)}</select><button className="square-button" title="刷新设备" onClick={() => void loadDevices()}><Icon name="refresh" /></button></div></label><label className="field"><span>采样率</span><select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))}>{rateOptions.map((rate) => <option value={rate} key={rate}>{rate.toLocaleString()} Hz</option>)}</select></label><label className="field"><span>交付位深</span><select value={bitDepth} onChange={(event) => setBitDepth(Number(event.target.value))}><option value={16}>16-bit PCM</option><option value={24}>24-bit PCM（推荐）</option><option value={32}>32-bit Float</option></select></label><label className="field"><span>输入通道</span><select value={inputChannel} onChange={(event) => setInputChannel(Number(event.target.value))}>{Array.from({ length: activeInputChannels }, (_, index) => <option value={index + 1} key={index + 1}>输入 {index + 1}</option>)}</select></label><label className="field"><span>环境 / 静音上限（RMS dBFS）</span><input type="number" min="-72" max="-12" step="1" value={noiseThresholdDbfs} onChange={(event) => setNoiseThresholdDbfs(Math.min(-12, Math.max(-72, Number(event.target.value) || -42)))} /></label><label className="field"><span>前后静音时长（秒）</span><input type="number" min="0.2" max="5" step="0.1" value={silenceDurationMs / 1_000} onChange={(event) => setSilenceDurationMs(Math.round(Math.min(5, Math.max(.2, Number(event.target.value) || 1)) * 1_000))} /></label></div>
              <div className="hardware-line"><span className={deviceName ? 'ok' : ''}><i />{deviceName ? '设备可用' : '等待设备'}</span><em>输入通道 {inputChannel} / {activeInputChannels}</em><em>驱动格式 {captureFormats.join(' / ') || '检测中'}</em><em>{bitDepth === 32 ? 'Float' : 'PCM'} {bitDepth}-bit / Mono</em></div>
            </section>
            <section className="property-group">
              <div className="property-heading"><span>03</span><div><h2>录制与存储</h2><p>创建独立目录保存母音频、进度和交付文件</p></div></div>
              <div className="form-grid storage-form"><label className="field"><span>录制名称</span><input value={sessionName} onChange={(event) => setSessionName(event.target.value)} /></label><label className="field span-2"><span>本地保存位置</span><div className="field-row"><input value={outputDir} readOnly /><button className="button" onClick={() => void chooseOutput()}><Icon name="folder" size={14} />选择…</button></div></label></div>
            </section>
            <div className="document-actions"><p><Icon name="check" size={14} />开始后自动保存，不需要手动保存工程。</p><button data-testid="start-session" className="button primary" onClick={() => void startSession()} disabled={!readyToStart}><Icon name="record" size={14} />开始录制</button></div>
          </div>
        </main>
        <aside className="panel inspector setup-inspector">
          <div className="panel-tabs"><button className="active">检查器</button></div>
          <div className="inspector-section"><h3>录制摘要</h3><dl className="property-list"><div><dt>脚本条目</dt><dd>{scriptItems.length || '—'}</dd></div><div><dt>采样率</dt><dd>{sampleRate.toLocaleString()} Hz</dd></div><div><dt>位深</dt><dd>{bitDepth === 32 ? '32-bit Float' : `${bitDepth}-bit PCM`}</dd></div><div><dt>输入通道</dt><dd>{inputChannel}</dd></div><div><dt>声道</dt><dd>Mono</dd></div><div><dt>噪声上限</dt><dd>{noiseThresholdDbfs} dBFS</dd></div><div><dt>前后静音</dt><dd>{(silenceDurationMs / 1_000).toFixed(1)} s</dd></div></dl></div>
          <div className="inspector-section"><h3>输入设备</h3><div className="device-summary"><span><Icon name="microphone" /></span><div><strong>{deviceName || '未选择设备'}</strong><small>{selectedDevice?.is_default ? '系统默认输入' : '外部输入设备'}</small></div></div></div>
          <div className="inspector-section"><h3>数据策略</h3><ul className="feature-list"><li><Icon name="check" />持续母音频</li><li><Icon name="check" />整数样本边界</li><li><Icon name="check" />不可变重录版本</li><li><Icon name="check" />原子状态快照</li></ul></div>
        </aside>
      </div>
      <StudioStatus engineStatus={engineStatus} message={error || dataSafetyAlert || busy || notice} isError={Boolean(error || dataSafetyAlert)} right="READY · PCM · LOCAL" />
    </div>;
  }

  if (phase === 'finished') {
    const finishedWithCaptureFault = snapshot?.status === 'faulted'
      || Boolean(snapshot?.overflow_samples)
      || captureFault;
    const finishedOpenDirectory = finishedWithCaptureFault
      ? sessionDir
      : exportResult?.export_dir ?? sessionDir;
    return <div className="studio-shell">
      <StudioChrome phase={phase} title={snapshot?.session_id ?? '已结束录制'} engineStatus={engineStatus} onBack={returnToRecordings} />
      <div className="studio-workspace export-workspace" data-testid="export-workspace">
        <aside className="tool-rail"><button><Icon name="file" /></button><button className="active"><Icon name="export" /></button><span /></aside>
        <aside className="panel export-queue"><div className="panel-tabs"><button className="active">{finishedWithCaptureFault ? '数据保全' : '交付'}</button></div><div className="panel-section-title">{finishedWithCaptureFault ? '安全状态' : '导出队列'}</div><div className="queue-item active"><Icon name="folder" /><div><strong>{snapshot?.session_id}</strong><small>{finishedWithCaptureFault ? '原始母轨已封存 · 导出阻断' : exportResult ? '导出完成' : '等待导出'}</small></div><span>{finishedWithCaptureFault ? <Icon name="stop" /> : exportResult ? <Icon name="check" /> : '…'}</span></div><div className="panel-section-title">{finishedWithCaptureFault ? '已保留' : '包含文件'}</div><ul className="file-tree">{finishedWithCaptureFault ? <><li><Icon name="folder" /> audio / segments</li><li><Icon name="folder" /> metadata / audio-fault.json</li><li><Icon name="file" /> session.json</li></> : <><li><Icon name="folder" /> export</li><li><Icon name="file" /> full-track.wav</li><li><Icon name="folder" /> sentences / 单句 WAV × {exportResult?.exported_count ?? 0}</li><li><Icon name="file" /> metadata.json</li><li><Icon name="file" /> metadata.csv</li></>}</ul></aside>
        <main className="export-document">
          <div className="document-tabs"><span className="active"><Icon name="export" size={13} /> 导出报告 <i>×</i></span></div>
          <div className="export-canvas">
              <header className="export-heading"><span className="export-check"><Icon name={finishedWithCaptureFault ? 'stop' : 'check'} size={28} /></span><div><span className="document-kicker">{finishedWithCaptureFault ? 'SAFETY SEAL' : 'EXPORT REPORT'}</span><h1>{finishedWithCaptureFault ? '采集故障已安全封存' : '录制已安全结束'}</h1><p>{dataSafetyAlert || (finishedWithCaptureFault ? '原始母轨已保留；为避免交付静默损坏的音频，常规导出已阻断。' : exportResult ? `已生成 ${exportResult.exported_count} 条单句 WAV；${exportResult.skipped_count} 条未进入交付。` : error || '母音频与进度快照已封存，可以重新执行导出。')}</p></div></header>
            <section className="report-table"><div className="report-row header"><span>项目</span><span>结果</span><span>状态</span></div><div className="report-row"><span>有效录音</span><strong>{counts.accepted ?? 0} 条</strong><em className={finishedWithCaptureFault ? 'fail' : 'pass'}>{finishedWithCaptureFault ? '未交付' : <><Icon name="check" size={13} />通过</>}</em></div><div className="report-row"><span>未导出条目</span><strong>{exportResult?.skipped_count ?? 0} 条</strong><em>已记录</em></div><div className="report-row"><span>音频完整性</span><strong>{snapshot?.overflow_samples ?? 0} 溢出样本</strong><em className={finishedWithCaptureFault ? 'fail' : 'pass'}>{finishedWithCaptureFault ? '需人工检查' : <><Icon name="check" size={13} />通过</>}</em></div><div className="report-row"><span>录制时长</span><strong>{sessionDuration}</strong><em>已封存</em></div></section>
            <section className="export-location"><h3>{finishedWithCaptureFault ? '原始任务位置' : '输出位置'}</h3><div><Icon name="folder" /><code>{finishedOpenDirectory}</code><button className="button" onClick={() => void window.recorder.openPath(finishedOpenDirectory)}>在文件夹中打开</button></div></section>
            <div className="export-actions"><button className="button" onClick={returnToRecordings}><Icon name="history" size={14} />返回历史录制</button><button className="button" onClick={beginNewRecording}><Icon name="plus" size={14} />新建录制</button><span /><button className="button" onClick={() => void exportSession()} disabled={Boolean(busy) || finishedWithCaptureFault} title={finishedWithCaptureFault ? '采集故障未解除，不允许生成常规交付' : undefined}><Icon name="refresh" size={14} />{finishedWithCaptureFault ? '导出已阻断' : '重新导出'}</button><button className="button primary" onClick={() => void window.recorder.openPath(finishedOpenDirectory)}><Icon name="folder" size={14} />{finishedWithCaptureFault ? '打开原始任务目录' : '打开交付目录'}</button></div>
          </div>
        </main>
        <aside className="panel inspector export-inspector"><div className="panel-tabs"><button className="active">{finishedWithCaptureFault ? '保全属性' : '导出属性'}</button></div><div className="inspector-section"><h3>音频格式</h3><dl className="property-list"><div><dt>容器</dt><dd>WAV</dd></div><div><dt>编码</dt><dd>{bitDepthForDisplay === 32 ? 'Float' : 'PCM'}</dd></div><div><dt>采样率</dt><dd>{sampleRateForDisplay.toLocaleString()} Hz</dd></div><div><dt>位深</dt><dd>{bitDepthForDisplay}-bit</dd></div><div><dt>通道</dt><dd>Mono</dd></div></dl></div><div className="inspector-section"><h3>{finishedWithCaptureFault ? '数据状态' : '元数据'}</h3><ul className="feature-list">{finishedWithCaptureFault ? <><li><Icon name="check" />原始分段已保留</li><li><Icon name="check" />故障证据已记录</li><li><Icon name="stop" />常规交付已阻断</li></> : <><li><Icon name="check" />metadata.json</li><li><Icon name="check" />metadata.csv</li><li><Icon name="check" />样本边界</li></>}</ul></div></aside>
      </div>
      <StudioStatus engineStatus={engineStatus} message={error || dataSafetyAlert || busy || notice} isError={Boolean(error || dataSafetyAlert)} right="RECORDING SEALED · LOCAL" />
    </div>;
  }

  return <div className="studio-shell">
    <StudioChrome phase={phase} title={snapshot?.session_id ?? '当前录制'} engineStatus={engineStatus} />
    <div className="studio-workspace recording-workspace" data-testid="recording-workspace">
      <aside className="tool-rail" aria-label="录音工具"><button title="选择"><Icon name="file" /></button><button className="active" title="录音"><Icon name="microphone" /></button><button title="电平"><Icon name="meter" /></button><span /><button title="导出"><Icon name="export" /></button></aside>
      <aside className="panel item-browser">
        <div className="panel-tabs"><button className="active">脚本</button><button>标记</button></div>
        <div className="browser-summary"><span><strong>{completed}</strong> / {items.length} 完成</span><div className="mini-progress"><i style={{ width: `${items.length ? completed / items.length * 100 : 0}%` }} /></div></div>
        <div className="item-filter"><span>所有条目</span><em>{items.length}</em></div>
        <div className="professional-item-list">{items.map((item, index) => <button key={item.id} className={`professional-item ${index === currentIndex ? 'active' : ''}`} disabled={recording} onClick={() => { setCurrentIndex(index); setReviewAttemptId(null); }}><span className={`item-state ${item.status}`}>{item.status === 'accepted' ? <Icon name="check" size={12} /> : item.status === 'skipped' ? '—' : String(index + 1).padStart(2, '0')}</span><span><strong>{item.id}</strong><small>{item.text}</small></span><em>{statusLabel(item.status)}</em></button>)}</div>
      </aside>
      <main className="editor-document">
        <div className="document-tabs"><span className="active"><Icon name="microphone" size={13} /> {currentItem?.id ?? 'Item'} <i>×</i></span></div>
        <div className="editor-toolbar"><div className="editor-nav"><button title="上一句" disabled={recording || currentIndex === 0} onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}><Icon name="chevron-left" /></button><span>{currentIndex + 1} / {items.length}</span><button title="下一句" disabled={recording || currentIndex >= items.length - 1} onClick={() => setCurrentIndex((index) => Math.min(items.length - 1, index + 1))}><Icon name="chevron-right" /></button></div><div className="editor-time"><small>{recording ? 'TAKE' : 'TOTAL'}</small><strong className={recording ? 'recording' : ''}>{recording ? attemptDuration : sessionDuration}</strong></div><button className="prompter-launch" onClick={() => void openPrompterPanel()}><Icon name="play" size={13} />领读面板</button><div className={`save-health ${meter.faulted || meter.overflow_samples || meter.storage_status === 'critical' ? 'fault' : meter.storage_status === 'warning' ? 'warning' : ''}`}><i />{meter.storage_status === 'critical' ? '磁盘余量不足 · 已保护停录' : meter.faulted ? '音频引擎故障 · 已保留母轨' : meter.overflow_samples ? '写盘队列溢出 · 不可交付' : meter.storage_status === 'warning' ? `磁盘余量预警 · 约 ${Math.max(0, Math.floor(meter.storage_safe_remaining_seconds / 60))} 分钟安全窗口` : '正在自动写入 · 母轨已保护'}</div></div>
        <div className="editor-canvas">
          <section className={`script-monitor ${recording ? 'recording' : ''} cue-${cue}`}><header><span>朗读监视器</span><div><span className={`studio-cue ${cue}`}><i />{cueLabel}</span><em>ITEM {String(currentIndex + 1).padStart(3, '0')}</em><span className={`take-state ${recording ? 'recording' : currentItem?.status ?? 'pending'}`}>{recording ? 'RECORDING' : statusLabel(currentItem?.status ?? 'pending')}</span></div></header><div className="prompt-surface">{currentItem?.label && <span className="label-chip">{currentItem.label}</span>}<p>{currentItem?.text ?? '没有可显示的文本'}</p><small>TEXT ID&nbsp;&nbsp;{currentItem?.id}</small></div><div className="silence-progress" aria-label={cueLabel}><i style={{ width: `${Math.min(100, silenceProgress * 100)}%` }} /></div></section>
          <section className="signal-monitor"><header><div><strong>实时 PCM 波形</strong><span>MIN / MAX · WEBGL</span></div><div><span>RMS <b>{db(meter.rms)}</b></span><span>PEAK <b className={meter.peak > .92 ? 'clip' : ''}>{db(meter.peak)}</b></span></div></header><div className="signal-scope"><WebGLWaveform bins={meter.waveform ?? []} recording={recording} sampleRate={sampleRateForDisplay} /><div className="scope-scale"><span>−1.0</span><span>−0.5</span><span>0</span><span>+0.5</span><span>+1.0</span></div></div><div className="horizontal-meter"><i className="meter-rms" style={{ width: `${rmsPercent}%` }} /><i className="meter-peak" style={{ left: `${peakPercent}%` }} /></div></section>
          {audioUrl && <audio ref={audioRef} src={audioUrl} controls className="audio-player" />}
          <section className="transport-panel"><div className="transport-secondary"><button title="试听 P" onClick={() => void previewAttempt()} disabled={recording || !currentItem?.attempts.length || Boolean(busy)}><Icon name="play" /><span>试听</span><kbd>P</kbd></button><button title="重录 R" onClick={() => void startAttempt()} disabled={recording || Boolean(busy) || !preSilenceReady}><Icon name="retake" /><span>重录</span><kbd>R</kbd></button></div><div className="transport-primary">{recording ? <button data-testid="main-transport" className={`main-transport ${captureFault ? 'stop' : postSilenceReady ? 'post-ready' : 'stop'}`} onClick={() => captureFault ? finishSession() : void stopAttempt()} disabled={Boolean(busy)}><span><Icon name="stop" /></span><strong>{captureFault ? '故障已保护 · 安全结束任务' : postSilenceReady ? '静音达标 · 完成本句' : hasSpoken ? '尾部静音不足 · 强制完成' : '未检测到语音 · 取消本句'}</strong><kbd>SPACE</kbd></button> : (reviewAttemptId || currentItem?.status === 'review') ? <button data-testid="main-transport" className="main-transport accept" onClick={() => void acceptAttempt()} disabled={Boolean(busy)}><span><Icon name="check" /></span><strong>确认并转到下一句</strong><kbd>SPACE</kbd></button> : <button data-testid="main-transport" className={`main-transport ${preSilenceReady ? 'record' : 'waiting'}`} onClick={() => void startAttempt()} disabled={Boolean(busy) || !currentItem || !preSilenceReady}><span><Icon name="record" /></span><strong>{preSilenceReady ? currentItem?.status === 'accepted' ? '静音达标 · 录制新版本' : '静音达标 · 开始录制' : cueLabel}</strong><kbd>SPACE</kbd></button>}</div><div className="transport-secondary right"><button title="跳过 S" onClick={() => void skipItem()} disabled={recording || Boolean(busy)}><Icon name="skip" /><span>跳过</span><kbd>S</kbd></button></div></section>
        </div>
      </main>
      <aside className="panel inspector recording-inspector">
        <div className="panel-tabs"><button className="active">属性</button><button>历史</button></div>
        <div className="inspector-section compact"><h3>当前条目</h3><dl className="property-list"><div><dt>文本 ID</dt><dd>{currentItem?.id}</dd></div><div><dt>状态</dt><dd className={`status-value ${currentItem?.status}`}>{recording ? '录制中' : statusLabel(currentItem?.status ?? '')}</dd></div><div><dt>版本数</dt><dd>{currentItem?.attempts.length ?? 0}</dd></div></dl></div>
        <div className="inspector-section input-inspector"><h3>输入电平</h3><div className="vertical-meter-wrap"><div className="vertical-meter"><i className="safe-zone" /><i className="vertical-fill" style={{ height: `${peakPercent}%` }} /></div><div className="vertical-scale"><span>0</span><span>−6</span><span>−12</span><span>−24</span><span>−48</span></div><div className="level-readout"><strong className={meter.peak > .92 ? 'clip' : ''}>{db(meter.peak)}</strong><small>PEAK</small><strong>{db(meter.rms)}</strong><small>RMS</small></div></div><p className={`level-hint ${meter.peak > .92 ? 'danger' : meter.peak > .04 ? 'good' : ''}`}><i />{meter.peak > .92 ? '输入过载，请降低增益' : meter.peak > .04 ? '输入电平正常' : '等待输入信号'}</p></div>
        <div className="inspector-section takes-section"><h3>录音版本</h3>{currentItem?.attempts.length ? <div className="take-list">{[...currentItem.attempts].reverse().map((attempt) => {
          const interrupted = attempt.status === 'interrupted' || attempt.end_sample <= attempt.start_sample;
          const forcedTail = Boolean(attempt.forced_without_tail_silence);
          return <button key={attempt.attempt_id} className={`${attempt.attempt_id === (reviewAttemptId ?? currentItem.selected_attempt_id) ? 'selected' : ''} ${interrupted ? 'interrupted' : ''} ${forcedTail ? 'quality-warning' : ''}`} disabled={interrupted} onClick={() => setReviewAttemptId(attempt.attempt_id)}><span><i />{attempt.attempt_id}</span><small>{interrupted ? '异常中断 · 不可交付' : forcedTail ? '尾静音不足 · 需试听' : formatDuration(attempt.end_sample - attempt.start_sample, sampleRateForDisplay)}</small></button>;
        })}</div> : <p className="empty-panel">尚无录音版本</p>}</div>
        <div className="inspector-section compact"><h3>本次录制</h3><dl className="property-list"><div><dt>格式</dt><dd>{sampleRateForDisplay / 1000}k / {snapshot?.audio_format.bit_depth}-bit</dd></div><div><dt>驱动实际输入</dt><dd>{snapshot?.input_sample_format?.toUpperCase() ?? '—'}</dd></div><div><dt>静音规则</dt><dd>{(effectiveSilenceDurationMs / 1_000).toFixed(1)} s / {snapshot?.silence_threshold_dbfs ?? noiseThresholdDbfs} dBFS</dd></div><div><dt>当前门控</dt><dd className={`cue-value ${cue}`}>{cueLabel}</dd></div><div><dt>队列溢出</dt><dd className={meter.overflow_samples ? 'danger' : ''}>{meter.overflow_samples}</dd></div><div><dt>已确认</dt><dd>{counts.accepted ?? 0} / {items.length}</dd></div></dl></div>
        <button data-testid="finish-session" className="button finish-session" onClick={() => void finishSession()} disabled={(recording && !captureFault) || Boolean(busy)}><Icon name="export" size={14} />{captureFault ? '故障封存并结束' : '结束录制并导出'}</button>
      </aside>
    </div>
    {finishConfirmOpen && <div className="dialog-backdrop" role="presentation">
      <section className="studio-dialog" role="dialog" aria-modal="true" aria-labelledby="finish-dialog-title">
        <header><span className="dialog-icon"><Icon name="export" size={19} /></span><div><small>RECORDING CONTROL</small><h2 id="finish-dialog-title">{captureFault ? '故障保护：安全结束录制？' : '结束当前录制？'}</h2></div></header>
        <p>{captureFault ? '录音引擎将停止接收新音频，排空已接收数据并封存原始分段。当前句会标记为异常中断，故障解除前不生成常规交付。' : '录音引擎将停止持续写盘，封存整轨母音频与进度快照，然后生成 full-track.wav、单句 WAV bundle 和元数据。'}</p>
        <dl className="dialog-summary"><div><dt>已确认</dt><dd>{counts.accepted ?? 0}</dd></div><div><dt>已跳过</dt><dd>{counts.skipped ?? 0}</dd></div><div><dt>待处理</dt><dd className={(counts.pending ?? 0) + (counts.review ?? 0) ? 'warning' : ''}>{(counts.pending ?? 0) + (counts.review ?? 0)}</dd></div></dl>
        {Boolean((counts.pending ?? 0) + (counts.review ?? 0)) && <div className="dialog-warning">待处理条目不会进入交付目录，但仍会保留在录制记录中。</div>}
        <footer><button data-testid="finish-cancel" className="button" onClick={() => setFinishConfirmOpen(false)}>取消</button><button data-testid="finish-confirm" className="button primary" onClick={() => void confirmFinishSession()}><Icon name="export" size={14} />{captureFault ? '安全结束并保留母轨' : '结束并导出'}</button></footer>
      </section>
    </div>}
    <StudioStatus engineStatus={engineStatus} message={error || dataSafetyAlert || busy || notice} isError={Boolean(error || dataSafetyAlert)} right={`${sampleRateForDisplay.toLocaleString()} HZ · ${bitDepthForDisplay}-BIT · MONO`} />
  </div>;
}

function PrompterView() {
  const [state, setState] = useState<PrompterState | null>(null);
  useEffect(() => {
    const unsubscribe = window.recorder.onPrompterState(setState);
    void window.recorder.getPrompterState().then(setState).catch(() => undefined);
    return unsubscribe;
  }, []);
  const cue = state?.cue ?? 'idle';
  return <main className={`prompter-shell ${cue}`}>
    <header className="prompter-header">
      <div><span className="prompter-brand">DB</span><strong>{state?.sessionName || '领读面板'}</strong></div>
      <div className={`prompter-cue ${cue}`}><i /><span>{state?.cueLabel ?? '等待监听人员打开录制任务'}</span></div>
      <nav><button onClick={() => void window.recorder.togglePrompterFullscreen()}>全屏</button><button onClick={() => void window.recorder.closePrompter()}>关闭</button></nav>
    </header>
    <section className="prompter-content">
      <div className="prompter-sequence"><span>{state?.sequence ? String(state.sequence).padStart(3, '0') : '———'}</span><em>/ {state?.total ?? 0}</em><small>ID {state?.id || '—'}</small></div>
      <p>{state?.text || '当前没有可朗读的文本'}</p>
      <div className={`prompter-label ${state?.label ? '' : 'empty'}`}><span>标签 / 备注</span><strong>{state?.label || '无额外要求'}</strong></div>
    </section>
    <footer className="prompter-footer"><span>{state ? `前后静音 ${(state.silenceDurationMs / 1_000).toFixed(1)} 秒` : 'CONTINUOUS MASTER RECORDING'}</span><div><i style={{ width: `${Math.min(100, (state?.silenceProgress ?? 0) * 100)}%` }} /></div><strong>{state?.cueLabel ?? 'STANDBY'}</strong></footer>
  </main>;
}

export default function App() {
  return new URLSearchParams(window.location.search).get('view') === 'prompter'
    ? <PrompterView />
    : <RecorderApp />;
}
