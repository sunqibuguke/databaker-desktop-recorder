import { useEffect, useMemo, useRef, useState } from 'react';
import { HomeHeader, Icon, StudioChrome, StudioStatus, type EngineStatus, type Phase } from './studio-chrome';
import {
  effectiveCaptureFaultKind,
  engineRecoveryFailure,
  isReconciliableInactiveStopError,
  planHistoryRecovery,
  planTaskListEntry,
  splitRecoveryWarnings,
} from './history-recovery';
import type { TaskListEntry, TaskListRecordDisabledReason } from './history-recovery';
import type { EffectiveCaptureFaultKind } from './history-recovery';
import { parseScript } from './script-parser';
import {
  areAllItemsHandled,
  captureExitAction,
  captureExitDialog,
  continuationAfterAccept,
  executeSafePause,
  findNextActionableItemIndex,
  idlePrimaryAction,
  isCurrentSessionNoiseCheckOperation,
  isFinalReview,
  NOISE_CHECK_STEPS,
  previewShortcutAction,
  resolveRunningItemIndex,
  sessionNoiseGate,
  shouldAutoRunSessionNoiseCheck,
  shouldAutoStartAfterAccept,
  viewShortcutAction,
  workflowShortcutAction,
} from './recording-workflow';
import { waveformTakeIsActive } from './waveform-buffer';
import { WebGLWaveform } from './WebGLWaveform';
import { PreviewPlayer, type PreviewPlayerHandle } from './PreviewPlayer';
import { inputQualityWarning, shouldHandleLiveMeter } from './input-quality';
import {
  liveHeadMsFromMeter,
  liveSilenceHint,
  liveSilencePair,
  recordedMonitorSentenceLabel,
  reviewSilencePair,
  shouldUseRecordedSilencePair,
  takeReviewPeak,
  type SilencePairView,
} from './silence-readout';
import {
  DEFAULT_AUTOMATION_RULES,
  loadAutomationRules,
  saveAutomationRules,
  showsPostTakeQualityBill,
  type AutomationRules,
} from './automation-rules.ts';
import {
  captureSampleFormatFromBitDepth,
  captureSampleFormatLabel,
  captureSampleFormatsForConfiguration,
  captureShareModeLabel,
  configurationsForShareMode,
  deliveryBitDepthForCaptureFormat,
  deviceExclusiveAvailable,
  normalizeCaptureSampleFormat,
  normalizeCaptureShareMode,
  preferredCaptureSampleFormat,
} from './capture-configuration';
import { createLatestFrameCommitter } from './latest-frame';
import type { LatestFrameCommitter } from './latest-frame';
import type { SessionNoiseCheckOperation } from './recording-workflow';
import { licenseSummary } from './ActivateLicense';
import type { Attempt, AudioDevice, CapturePreset, CapturePresetDraft, CapturePresetStore, CaptureShareMode, EngineEvent, ExportArtifact, ExportResult, HeadSilencePhase, InspectedSessionState, ItemState, LicenseStatus, Meter, NoiseCheckProgress, NoiseCheckResult, PrompterState, RecordingHistoryEntry, ScriptItem, SealInterruptedSessionResult, SessionSnapshot } from './types';
import { reportRendererError } from './sentry';
import { logUserAction } from './debug-log';
import { translateExportDeliverError } from './export-deliver-i18n';
import {
  DISCONTINUITY_TOAST_MS,
  discontinuityDurationMs,
  initialDiscontinuityToastState,
  shouldShowDiscontinuityToast,
} from './discontinuity-toast';
import { classifyEngineError, userFacingEngineError, type ClassifiedEngineError } from './engine-error';
import { LogPanel } from './LogPanel';
import { NoiseCheckDialog } from './NoiseCheckDialog';
import { APP_LOCALES, LOCALE_NATIVE_NAMES, getLocale, t, useI18n } from './i18n';
import { startDevWebCapture, type DevWebCaptureHandle } from './dev-web-capture';
import { readerCueKey, readerFacingCue, resolveMonitorCue } from './prompter-cues';

type HistoryFilter = 'all' | 'completed' | 'unfinished';
type RecordingStateKind = 'completed' | 'unfinished' | 'attention';
type RunningSessionState = {
  snapshot: SessionSnapshot;
  session_dir?: string;
  active_attempt?: {
    item_id: string;
    attempt_id: string;
    start_sample: number;
    recording_started_sample: number;
    head_silence_armed_sample?: number;
    head_silence_passed_sample?: number;
    head_silence_progress_samples?: number;
    required_head_silence_samples?: number;
    head_silence_phase?: HeadSilencePhase;
    content_started_sample?: number;
  } | null;
  recovery_warnings?: string[];
};
type StoppedSessionState = {
  snapshot: SessionSnapshot;
  session_dir?: string;
  warnings?: string[];
  reconciled_inactive_after_error?: boolean;
};
type CaptureExitMode = 'pause' | 'finish' | 'fault';
type MonitorPanelTab = 'monitor' | 'detection' | 'task' | 'export' | 'issues';
type OptionalRunningSessionState = ({ active: true } & RunningSessionState) | { active: false };
type ExportFeedback = {
  sessionId: string;
  sessionDir: string;
  artifact: ExportArtifact;
  status: 'working' | 'ok' | 'failed';
  output: string;
  exportDir?: string;
  filePath?: string;
  warning?: string;
  error?: string;
};
type UserAlert = {
  kind: 'error' | 'warning';
  title: string;
  body: string;
};

const HISTORY_PAGE_SIZE = 100;

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
  digital_silence_samples: 0,
  digital_silence_suspected: false,
  last_signal_sample: 0,
  head_silence_phase: 'idle',
  head_silence_armed_sample: 0,
  head_silence_progress_samples: 0,
  required_head_silence_samples: 0,
  head_silence_passed_sample: 0,
  content_started_sample: 0,
  silence_threshold_dbfs: -42,
  silence_duration_ms: 1_000,
  waveform: [],
};

function errorMessage(error: unknown): string {
  return userFacingEngineError(error);
}

function activationErrorCopy(kind: ClassifiedEngineError['kind']): { title: string; body: string } {
  switch (kind) {
    case 'exclusive_busy':
      return { title: t('activationError.busyTitle'), body: t('activationError.busyBody') };
    case 'exclusive_format':
      return { title: t('activationError.formatTitle'), body: t('activationError.formatBody') };
    case 'exclusive_policy':
      return { title: t('activationError.policyTitle'), body: t('activationError.policyBody') };
    case 'exclusive_empty':
      return { title: t('activationError.emptyTitle'), body: t('activationError.emptyBody') };
    case 'exclusive_open':
      return { title: t('activationError.exclusiveTitle'), body: t('activationError.exclusiveBody') };
    default:
      return { title: t('activationError.genericTitle'), body: t('activationError.genericBody') };
  }
}

function recoveryWarning(label: string, warnings: string[] | undefined): string {
  if (!warnings?.length) return '';
  const first = warnings[0];
  const extra = warnings.length > 1 ? t('notice.extraWarnings', { count: warnings.length - 1 }) : '';
  return t('notice.recoveryPrefix', { label, first, extra });
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

function describeCaptureFault(meter: Meter): { title: string; detail: string } {
  if (meter.fault_kind === 'device_unavailable') {
    return {
      title: '所选声卡已断开或不可用',
      detail: meter.fault_reason || '录音已立即停止并保留已落盘母轨。请检查声卡供电、USB 连接和 Windows 驱动状态。',
    };
  }
  if (meter.fault_kind === 'device_stalled') {
    return {
      title: '声卡已停止输送音频',
      detail: meter.fault_reason || '连续 5 秒未收到音频数据，已停录并保留已落盘母轨。请检查声卡和驱动。',
    };
  }
  if (meter.fault_kind === 'input_discontinuity') {
    return {
      title: '音频输入出现不连续',
      detail: meter.fault_reason || '驱动报告音频数据丢失，已停录并保留已落盘母轨。请检查声卡、USB 连接和系统负载。',
    };
  }
  if (meter.fault_kind === 'input_stream_error') {
    return {
      title: '音频输入流故障',
      detail: meter.fault_reason || '已停录并保留已落盘母轨。请检查声卡、驱动和系统音频设置。',
    };
  }
  if (meter.storage_status === 'critical') {
    return {
      title: '保存磁盘余量不足',
      detail: '已保护停录并保留可恢复母轨。请安全结束任务后更换保存位置。',
    };
  }
  if (meter.overflow_samples > 0) {
    return {
      title: '写盘队列溢出，当前录音需要检查',
      detail: '已保留可恢复的原始母轨和故障证据，请安全结束任务后人工检查。',
    };
  }
  return {
    title: '音频采集已触发数据保护',
    detail: meter.fault_reason || '录音已停止写入，已落盘的原始母轨会保留。请安全结束任务并检查故障标记。',
  };
}

function describeEffectiveCaptureFault(
  kind: EffectiveCaptureFaultKind,
  meter: Meter,
): { title: string; detail: string } {
  if (kind === 'engine_recovering') {
    return {
      title: '录音引擎正在恢复',
      detail: '请立即停止朗读。恢复结果确认前，不能确认、跳过或开始新的录音；若安全结束暂时失败，请保持应用开启并等待引擎状态确认。',
    };
  }
  if (kind === 'engine_offline') {
    return {
      title: '录音引擎连接已中断',
      detail: '请立即停止朗读。当前写入状态无法确认；请安全结束并保留已落盘母轨。若按钮暂时失败，请保持应用开启并等待引擎状态确认。',
    };
  }
  return describeCaptureFault(meter);
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
  return ({
    pending: t('itemStatus.pending'),
    review: t('itemStatus.review'),
    accepted: t('itemStatus.accepted'),
    skipped: t('itemStatus.skipped'),
  } as Record<string, string>)[status] ?? status;
}

function AutomationRuleRow(props: {
  testId: string;
  checked: boolean;
  title: string;
  hint: string;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="silence-review-toggle automation-rule">
      <input
        type="checkbox"
        data-testid={props.testId}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span><strong>{props.title}</strong><small>{props.hint}</small></span>
    </label>
  );
}

function SilencePairReadout({ pair, hint }: { pair: SilencePairView; hint?: boolean }) {
  return <span className="silence-pair">
    <span className={pair.headWarn ? 'silence-readout short' : 'silence-readout'}>{pair.headText}</span>
    <span className={pair.tailMet ? 'silence-readout met' : 'silence-readout'}>{pair.tailText}</span>
    {pair.extra ? <span className="silence-readout note">{pair.extra}</span> : null}
    {hint && pair.hint ? <small className="silence-hint" title={pair.hint}>{pair.hint}</small> : null}
  </span>;
}

function LiveSilenceHint({ liveMs, requiredMs }: { liveMs: number; requiredMs: number }) {
  const hint = liveSilenceHint({ liveMs, requiredMs });
  return <div
    className={`scope-silence-hint${hint.met ? ' met' : ''}`}
    data-testid="live-silence-hint"
    data-met={hint.met ? 'true' : 'false'}
    role="status"
    aria-live="off"
    aria-label={hint.text}
    style={{ ['--silence-progress' as string]: `${Math.round(hint.progress * 100)}%` }}
  >
    <i className="scope-silence-fill" aria-hidden="true" />
    <span>{hint.text}</span>
    <b className="scope-silence-mark" aria-hidden="true"><Icon name="check" size={11} /></b>
  </div>;
}

function latestUsableAttempt(item: ItemState): Attempt | undefined {
  for (let index = item.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = item.attempts[index];
    if (!['interrupted', 'needs_rerecord'].includes(attempt.status)
      && attempt.end_sample > attempt.start_sample) return attempt;
  }
  return undefined;
}

function recordingState(recording: RecordingHistoryEntry): { kind: RecordingStateKind; label: string } {
  if (recording.history_issue) return { kind: 'attention', label: t('home.stateNeedsCheck') };
  if (recording.status === 'faulted' || recording.overflow_samples > 0) return { kind: 'attention', label: t('home.stateNeedsCheck') };
  if (recording.is_active && recording.status === 'stopping') {
    return { kind: 'attention', label: t('home.stateSafeStopping') };
  }
  if (recording.is_active) return { kind: 'unfinished', label: t('home.stateCurrent') };
  if (recording.status === 'recording' || recording.status === 'stopping') {
    return { kind: 'attention', label: t('home.stateInterrupted') };
  }
  if (recording.pending_items + recording.review_items > 0) return { kind: 'unfinished', label: t('home.stateUnfinished') };
  return { kind: 'completed', label: t('home.stateCompleted') };
}

function listViewIsPrimary(entry: TaskListEntry): boolean {
  return entry.kind === 'view-only' || (entry.kind === 'view-record' && entry.viewPrimary);
}

function listRecordEnabled(entry: TaskListEntry): boolean {
  return entry.kind === 'view-record' && entry.recordEnabled;
}

function listRecordDisabledReason(entry: TaskListEntry): TaskListRecordDisabledReason | undefined {
  return entry.kind === 'view-only' ? entry.recordDisabledReason : undefined;
}

function recordingMatchesFilter(recording: RecordingHistoryEntry, filter: HistoryFilter): boolean {
  if (filter === 'all') return true;
  const kind = recordingState(recording).kind;
  return filter === 'completed' ? kind === 'completed' : kind !== 'completed';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('common.dash');
  return new Intl.DateTimeFormat(getLocale(), {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function artifactLabel(artifact: ExportArtifact): string {
  if (artifact === 'full_track') return t('notice.exportedFull');
  if (artifact === 'timestamps_json') return t('notice.exportedJson');
  return t('exportDialog.cuts');
}

function artifactOutputCopy(artifact: ExportArtifact, exported?: ExportResult): string {
  if (artifact === 'cuts_zip' && exported) {
    return t('notice.exportedCuts', { count: exported.exported_count, skipped: exported.skipped_count });
  }
  return artifactLabel(artifact);
}

const EXPORT_DESTINATION_KEY = 'databaker-export-destination';

function loadExportDestination(): string {
  try {
    return window.localStorage.getItem(EXPORT_DESTINATION_KEY) ?? '';
  } catch {
    return '';
  }
}

function persistExportDestination(value: string) {
  try {
    if (value) window.localStorage.setItem(EXPORT_DESTINATION_KEY, value);
    else window.localStorage.removeItem(EXPORT_DESTINATION_KEY);
  } catch {
    // preview / restricted storage is best-effort
  }
}

function artifactFilePath(artifact: ExportArtifact, exported: ExportResult): string | undefined {
  if (artifact === 'full_track') return exported.master_file;
  if (artifact === 'timestamps_json') return exported.timestamps_json;
  return exported.cuts_archive;
}

function artifactStatusCopy(recording: RecordingHistoryEntry | undefined, artifact: ExportArtifact): string {
  const state = recording?.export_artifacts?.[artifact];
  if (!state || state.state === 'never') return t('exportDialog.never');
  if (state.state === 'stale') {
    return state.exported_at
      ? t('exportDialog.staleWithTime', { time: formatDateTime(state.exported_at) })
      : t('exportDialog.stale');
  }
  if (state.state === 'failed') return state.message || t('exportDialog.failed');
  return state.exported_at
    ? t('exportDialog.currentWithTime', { time: formatDateTime(state.exported_at) })
    : t('exportDialog.current');
}

export function RecorderApp({ license }: { license?: LicenseStatus } = {}) {
  const { locale, setLocale, t } = useI18n();
  const isBrowserPreview = window.recorder.runtime === 'preview';
  const exclusiveCaptureAvailable = window.recorder.platform === 'win32';
  const [phase, setPhase] = useState<Phase>('home');
  const [engineStatus, setEngineStatus] = useState<EngineStatus>('connecting');
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [sampleRate, setSampleRate] = useState(48_000);
  const [inputSampleFormat, setInputSampleFormat] = useState('i16');
  const [inputChannel, setInputChannel] = useState(1);
  const bitDepth = deliveryBitDepthForCaptureFormat(inputSampleFormat);
  const [captureShareMode, setCaptureShareMode] = useState<CaptureShareMode>('shared');
  const [sessionName, setSessionName] = useState(() => t('setup.defaultSessionName'));
  const [outputDir, setOutputDir] = useState('');
  const [scriptFile, setScriptFile] = useState('');
  const [scriptItems, setScriptItems] = useState<ScriptItem[]>([]);
  const [scriptErrors, setScriptErrors] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [captureActive, setCaptureActive] = useState(false);
  const [devWebCaptureEnabled, setDevWebCaptureEnabled] = useState(false);
  const [devWebCaptureNotice, setDevWebCaptureNotice] = useState('');
  const [workspaceFaulted, setWorkspaceFaulted] = useState(false);
  const [monitorPanelTab, setMonitorPanelTab] = useState<MonitorPanelTab>('monitor');
  const [prompterStatus, setPrompterStatus] = useState({ open: false, ready: false });
  const [sessionDir, setSessionDir] = useState('');
  const [waveformGeneration, setWaveformGeneration] = useState(0);
  const [reviewWaveformBins, setReviewWaveformBins] = useState<Array<[number, number]>>([]);
  const reviewWaveformRequestRef = useRef(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [recording, setRecording] = useState(false);
  const [attemptStartSample, setAttemptStartSample] = useState(0);
  const [attemptRecordingStartedSample, setAttemptRecordingStartedSample] = useState(0);
  const [reviewAttemptId, setReviewAttemptId] = useState<string | null>(null);
  const [reviewPeak, setReviewPeak] = useState(0);
  const [discontinuityToast, setDiscontinuityToast] = useState('');
  const [automationRules, setAutomationRules] = useState<AutomationRules>(DEFAULT_AUTOMATION_RULES);
  const takePeakRef = useRef(0);
  const [meter, setMeter] = useState<Meter>(emptyMeter);
  const [noiseThresholdDbfs, setNoiseThresholdDbfs] = useState(-42);
  const [taskInitialSilenceThresholdDbfs, setTaskInitialSilenceThresholdDbfs] = useState(-42);
  const [taskInitialSilenceDurationMs, setTaskInitialSilenceDurationMs] = useState(1_000);
  const [silenceThresholdDraftDbfs, setSilenceThresholdDraftDbfs] = useState(-42);
  const [silenceDurationDraftMs, setSilenceDurationDraftMs] = useState(1_000);
  const [silenceSettingsSaving, setSilenceSettingsSaving] = useState(false);
  const [silenceSettingsError, setSilenceSettingsError] = useState('');
  const [silenceDurationMs, setSilenceDurationMs] = useState(1_000);
  const [noiseCheckRunning, setNoiseCheckRunning] = useState(false);
  const [noiseCheckProgress, setNoiseCheckProgress] = useState(0);
  const [noiseCheckLive, setNoiseCheckLive] = useState<NoiseCheckProgress | null>(null);
  const [noiseCheckSamples, setNoiseCheckSamples] = useState<number[]>([]);
  const [noiseCheckError, setNoiseCheckError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(() => t('notice.connectingEngine'));
  const [error, setError] = useState('');
  const [dataSafetyAlert, setDataSafetyAlert] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewBins, setPreviewBins] = useState<Array<[number, number]>>([]);
  const [previewingAttemptId, setPreviewingAttemptId] = useState('');
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const [capturePresetStore, setCapturePresetStore] = useState<CapturePresetStore>({ schemaVersion: 1, lastSelectedPresetId: null, presets: [] });
  const [capturePresetsLoaded, setCapturePresetsLoaded] = useState(false);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [presetWarning, setPresetWarning] = useState('');
  const [presetBusy, setPresetBusy] = useState(false);
  const [recordings, setRecordings] = useState<RecordingHistoryEntry[]>([]);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyNextOffset, setHistoryNextOffset] = useState<number | null>(null);
  const [sealingSessionDir, setSealingSessionDir] = useState('');
  const [sealConfirmRecording, setSealConfirmRecording] = useState<RecordingHistoryEntry | null>(null);
  const [deleteConfirmRecording, setDeleteConfirmRecording] = useState<RecordingHistoryEntry | null>(null);
  const [resetConfirmRecording, setResetConfirmRecording] = useState<RecordingHistoryEntry | null>(null);
  const [exportRecording, setExportRecording] = useState<RecordingHistoryEntry | null>(null);
  const [exportDestination, setExportDestination] = useState(loadExportDestination);
  const [taskExportDir, setTaskExportDir] = useState('');
  const [exportFeedback, setExportFeedback] = useState<ExportFeedback | null>(null);
  const [userAlert, setUserAlert] = useState<UserAlert | null>(null);
  const [activationFailure, setActivationFailure] = useState<ClassifiedEngineError | null>(null);
  const [activationFailureOpen, setActivationFailureOpen] = useState(false);
  const [recoveryShareMode, setRecoveryShareMode] = useState<CaptureShareMode>('shared');
  const [recoverySampleFormat, setRecoverySampleFormat] = useState('i16');
  const [deletingSessionDir, setDeletingSessionDir] = useState('');
  const [resettingSessionDir, setResettingSessionDir] = useState('');
  const [openActionsSessionDir, setOpenActionsSessionDir] = useState('');
  const [resumeError, setResumeError] = useState<{ sessionDir: string; message: string } | null>(null);
  const previewPlayerRef = useRef<PreviewPlayerHandle>(null);
  const previewWaveformRequestRef = useRef(0);
  const sealOperationRef = useRef(false);
  const pauseOperationRef = useRef(false);
  const presetOperationRef = useRef(false);
  const noiseCheckActivationRef = useRef(0);
  const noiseCheckRequestSequenceRef = useRef(0);
  const noiseCheckOperationRef = useRef<SessionNoiseCheckOperation | null>(null);
  const silenceSettingsSaveSequenceRef = useRef(0);
  const hadMonitorIssuesRef = useRef(false);
  const discontinuityToastStateRef = useRef(initialDiscontinuityToastState());
  const lastOperationErrorRef = useRef('');
  const discontinuityToastTimerRef = useRef<number | null>(null);
  const activeSessionDirRef = useRef('');
  const initialPresetAppliedRef = useRef(false);
  const outputDirRef = useRef('');
  const phaseRef = useRef<Phase>('home');
  const meterFrameCommitterRef = useRef<LatestFrameCommitter<Meter> | null>(null);
  const historyLoadSequenceRef = useRef(0);
  phaseRef.current = phase;

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
  const workspaceRecording = recordings.find((recording) => recording.session_dir === sessionDir);
  const selectedDevice = devices.find((device) => device.id === deviceId) ?? null;
  const selectedCapturePreset = capturePresetStore.presets.find((preset) => preset.id === capturePresetStore.lastSelectedPresetId) ?? null;
  const modeConfigurations = useMemo(
    () => configurationsForShareMode(selectedDevice, captureShareMode),
    [captureShareMode, selectedDevice],
  );
  const maximumInputChannels = Math.max(1, ...(modeConfigurations.length
    ? modeConfigurations.map((configuration) => configuration.channels)
    : selectedDevice?.input_channels ?? [1]));
  const rateOptions = useMemo(() => {
    const modeRates = modeConfigurations.flatMap((configuration) => [
      configuration.min_sample_rate,
      configuration.max_sample_rate,
    ]);
    const fallbackRates = selectedDevice?.sample_rates ?? [];
    if (!modeRates.length && !fallbackRates.length) return [44_100, 48_000];
    const candidates = [...new Set([
      16_000, 44_100, 48_000, 88_200, 96_000, 176_400, 192_000,
      ...fallbackRates,
      ...modeRates,
    ])].sort((left, right) => left - right);
    if (modeConfigurations.length) {
      return candidates.filter((rate) => modeConfigurations.some((configuration) => (
        configuration.channels >= inputChannel
        && rate >= configuration.min_sample_rate
        && rate <= configuration.max_sample_rate
      )));
    }
    if (captureShareMode === 'exclusive') return [];
    const minimum = Math.min(...fallbackRates);
    const maximum = Math.max(...fallbackRates);
    return candidates.filter((rate) => rate >= minimum && rate <= maximum);
  }, [captureShareMode, inputChannel, modeConfigurations, selectedDevice]);
  const activeInputChannels = modeConfigurations.length
    ? Math.max(1, ...modeConfigurations
      .filter((configuration) => sampleRate >= configuration.min_sample_rate && sampleRate <= configuration.max_sample_rate)
      .map((configuration) => configuration.channels))
    : maximumInputChannels;
  const formatOptions = captureSampleFormatsForConfiguration(
    modeConfigurations,
    sampleRate,
    inputChannel,
  );
  const recoveryFormatOptions = captureSampleFormatsForConfiguration(
    configurationsForShareMode(selectedDevice, recoveryShareMode),
    sampleRate,
    inputChannel,
  );
  const captureFormats = formatOptions.map((format) => format.toUpperCase());
  const captureConfigurationValid = Boolean(
    selectedDevice
    && rateOptions.includes(sampleRate)
    && inputChannel <= activeInputChannels
    && formatOptions.some((format) => format === inputSampleFormat),
  );
  const captureConfigurationIssue = !deviceId
    ? t('setup.pickDevice')
    : !selectedDevice
      ? t('setup.presetDeviceUnavailable')
      : captureShareMode === 'exclusive' && modeConfigurations.length === 0
        ? t('setup.exclusiveUnavailable')
        : !rateOptions.includes(sampleRate)
          ? t('setup.comboUnsupported', {
            mode: captureShareModeLabel(captureShareMode),
            rate: sampleRate.toLocaleString(locale),
            channel: inputChannel,
          })
          : inputChannel > activeInputChannels || formatOptions.length === 0
            ? t('setup.channelUnsupported', {
              mode: captureShareModeLabel(captureShareMode),
              rate: sampleRate.toLocaleString(locale),
              channel: inputChannel,
            })
            : !formatOptions.some((format) => format === inputSampleFormat)
              ? t('setup.formatUnsupported', {
                mode: captureShareModeLabel(captureShareMode),
                rate: sampleRate.toLocaleString(locale),
                channel: inputChannel,
                format: captureSampleFormatLabel(inputSampleFormat),
              })
            : '';
  const presetDirty = Boolean(selectedCapturePreset && (
    selectedCapturePreset.deviceId !== deviceId
    || selectedCapturePreset.deviceName !== deviceName
    || selectedCapturePreset.sampleRate !== sampleRate
    || selectedCapturePreset.bitDepth !== bitDepth
    || (selectedCapturePreset.inputSampleFormat ?? captureSampleFormatFromBitDepth(selectedCapturePreset.bitDepth)) !== inputSampleFormat
    || selectedCapturePreset.inputChannel !== inputChannel
    || normalizeCaptureShareMode(selectedCapturePreset.captureShareMode) !== captureShareMode
    || selectedCapturePreset.silenceDurationMs !== silenceDurationMs
    || selectedCapturePreset.silenceThresholdDbfs !== noiseThresholdDbfs
  ));
  const counts = useMemo(() => items.reduce((result, item) => {
    result[item.status] = (result[item.status] ?? 0) + 1;
    return result;
  }, {} as Record<string, number>), [items]);
  const completed = (counts.accepted ?? 0) + (counts.skipped ?? 0);
  const allHandled = areAllItemsHandled(items);
  const workflowComplete = allHandled && !recording && captureActive && currentIndex < 0;
  const primaryAction = recording ? 'none' : idlePrimaryAction(items, currentIndex);
  const finalReview = isFinalReview(items, currentIndex);
  const acceptButtonLabel = finalReview || !automationRules.autoStartNext
    ? t('recorder.acceptThis')
    : t('recorder.acceptAndNext');
  const sampleRateForDisplay = snapshot?.audio_format.sample_rate ?? sampleRate;
  const bitDepthForDisplay = snapshot?.audio_format.bit_depth ?? bitDepth;
  const sessionDuration = formatDuration(meter.captured_samples, sampleRateForDisplay);
  const attemptDuration = recording ? formatDuration(meter.captured_samples - attemptStartSample, sampleRateForDisplay) : '00:00:00';
  const peakPercent = Math.min(100, Math.max(0, meter.peak * 100));
  const rmsPercent = Math.min(100, Math.max(0, meter.rms * 100));
  const liveRmsDbfs = meter.rms <= 0.00001
    ? -96
    : Math.max(-96, Math.min(0, 20 * Math.log10(meter.rms)));
  const liveRmsOnThresholdScale = Math.min(100, Math.max(0, (liveRmsDbfs + 72) / 60 * 100));
  const effectiveSilenceDurationMs = snapshot?.silence_duration_ms ?? silenceDurationMs;
  const requiredSilenceSamples = sampleRateForDisplay * effectiveSilenceDurationMs / 1_000;
  const headSilenceRequiredSamples = Math.max(1, meter.required_head_silence_samples ?? requiredSilenceSamples);
  const headSilenceProgressSamples = Math.min(
    headSilenceRequiredSamples,
    Math.max(0, meter.head_silence_progress_samples ?? 0),
  );
  const pendingRemainingMs = Math.max(0, Math.round(
    (headSilenceRequiredSamples - headSilenceProgressSamples) / Math.max(sampleRateForDisplay, 1) * 1_000,
  ));
  const isPendingTake = recording && (
    meter.head_silence_phase === 'waiting_for_head_silence'
    || ((meter.head_silence_passed_sample ?? 0) === 0 && (meter.required_head_silence_samples ?? 0) > 0)
  );
  const hasSpoken = recording && (
    (meter.content_started_sample ?? 0) > 0
    || meter.head_silence_phase === 'speech_started'
    || meter.last_signal_sample > attemptRecordingStartedSample
  );
  const liveSilenceMs = Math.round((meter.silence_samples ?? 0) / Math.max(sampleRateForDisplay, 1) * 1_000);
  const tailSilenceMet = liveSilenceMs >= effectiveSilenceDurationMs;
  const reviewAttempt = !recording && currentItem
    ? currentItem.attempts.find((attempt) => attempt.attempt_id === reviewAttemptId)
      ?? currentItem.attempts.find((attempt) => attempt.attempt_id === currentItem.selected_attempt_id)
      ?? latestUsableAttempt(currentItem)
    : undefined;
  const showReviewWaveform = !captureActive && Boolean(reviewAttempt);
  const showInspectSilenceBill = Boolean(reviewAttempt && showsPostTakeQualityBill(automationRules));
  const showReviewSilenceBill = Boolean(
    !recording
    && currentItem?.status === 'review'
    && showInspectSilenceBill,
  );
  const reviewBillPeak = takeReviewPeak({
    livePeak: reviewPeak,
    storedPeak: reviewAttempt?.peak,
    waveformBins: showReviewWaveform ? reviewWaveformBins : (meter.waveform ?? []),
  });
  const reviewBillPair = reviewSilencePair({
    attempt: reviewAttempt,
    sampleRate: sampleRateForDisplay,
    requiredMs: effectiveSilenceDurationMs,
    peak: reviewBillPeak,
    showHeadTailHints: automationRules.headTailSilence,
    showAlmostSilent: automationRules.almostSilent,
    showPeakHigh: automationRules.peakHigh,
  });
  const livePair = liveSilencePair({
    recording,
    pending: isPendingTake,
    spoken: Boolean(hasSpoken),
    pendingRemainingMs,
    requiredMs: effectiveSilenceDurationMs,
    liveSilenceMs,
    headMs: liveHeadMsFromMeter({
      sampleRate: sampleRateForDisplay,
      armedSample: meter.head_silence_armed_sample || attemptRecordingStartedSample,
      contentStartedSample: meter.content_started_sample ?? 0,
      phase: meter.head_silence_phase,
    }),
  });
  const silencePair = shouldUseRecordedSilencePair(recording, reviewAttempt)
    ? reviewBillPair
    : livePair;
  const captureFaultKind = effectiveCaptureFaultKind(phase === 'running' && captureActive, engineStatus, meter);
  const captureFault = captureFaultKind !== null;
  const exitAction = captureExitAction(items, captureFault);
  const captureFaultCopy = captureFaultKind
    ? describeEffectiveCaptureFault(captureFaultKind, meter)
    : describeCaptureFault(meter);
  const qualityWarning = inputQualityWarning(
    phase === 'running' && captureActive,
    captureFault,
    meter.digital_silence_suspected,
  );
  const discontinuityCount = meter.input_discontinuity_count ?? snapshot?.input_discontinuity_count ?? 0;
  const discontinuitySilenceSamples = meter.input_discontinuity_silence_samples
    ?? snapshot?.input_discontinuity_silence_samples
    ?? 0;
  const discontinuityWarning = discontinuityCount > 0
    ? (discontinuitySilenceSamples > 0
      ? t('discontinuity.withSilence', {
        count: discontinuityCount,
        ms: discontinuityDurationMs(discontinuitySilenceSamples, sampleRateForDisplay),
      })
      : t('discontinuity.noSilence', { count: discontinuityCount }))
    : '';
  const hasBlockingMonitorIssues = Boolean(captureFault || workspaceFaulted || qualityWarning || meter.overflow_samples > 0 || meter.storage_status !== 'healthy');
  const hasMonitorIssues = Boolean(hasBlockingMonitorIssues || discontinuityWarning);
  const currentNoiseGate = sessionNoiseGate(snapshot?.noise_check, noiseCheckRunning, automationRules.envCheck);
  const noiseCheckBlocksAttempt = phase === 'running' && captureActive && !recording && currentNoiseGate !== 'ready';
  const showNoiseCheckDialog = noiseCheckBlocksAttempt && !captureFault;
  const noiseLimitDbfs = snapshot?.noise_threshold_dbfs
    ?? snapshot?.noise_check?.threshold_dbfs
    ?? noiseThresholdDbfs;
  const noiseSamples = noiseCheckRunning
    ? noiseCheckSamples
    : (snapshot?.noise_check?.samples ?? noiseCheckSamples);
  const noiseCheckMessage = currentNoiseGate === 'checking'
    ? t('noise.checking', { current: noiseCheckProgress, total: NOISE_CHECK_STEPS })
    : currentNoiseGate === 'failed'
      ? t('noise.failed', { peak: snapshot?.noise_check?.maximum_dbfs.toFixed(1) ?? t('common.dash') })
      : currentNoiseGate === 'pending'
        ? noiseCheckError || t('noise.pending')
        : '';
  const normalCue = phase !== 'running' || !currentItem
    ? 'idle'
    : noiseCheckBlocksAttempt
      ? 'checking'
      : recording
        ? isPendingTake ? 'pending' : 'recording'
      : workflowComplete
        ? 'complete'
        : currentItem.status === 'review'
          ? 'review'
          : 'idle';
  const cue = resolveMonitorCue(captureFault ? 'fault' : normalCue, tailSilenceMet);
  const readerCue = readerFacingCue(cue);
  const liveCueLabel = captureFault
    ? t('cue.stopRead', { title: captureFaultCopy.title })
    : noiseCheckBlocksAttempt
      ? noiseCheckMessage
      : ({
    idle: phase === 'running' && currentItem ? t('cue.waitStart') : t('cue.waitTask'),
    checking: noiseCheckMessage,
    pending: t('cue.pendingEsc'),
    recording: t('cue.read'),
    ready: t('cue.ready'),
    review: t('cue.recorded'),
    complete: t('cue.allHandled'),
      } as const)[cue === 'ready' ? 'ready' : normalCue];
  const cueLabel = recordedMonitorSentenceLabel({
    liveCue: captureFault ? 'fault' : cue,
    itemStatus: currentItem?.status,
    liveLabel: liveCueLabel,
  });
  const readerCueLabel = t(`readerCue.${readerCueKey(cue)}`);
  const prompterState = useMemo<PrompterState>(() => ({
    sessionName: snapshot?.session_id ?? sessionName,
    sequence: workflowComplete ? items.length : currentItem ? currentIndex + 1 : 0,
    total: items.length,
    id: workflowComplete ? '' : currentItem?.id ?? '',
    text: captureFault ? t('readerCue.halt') : noiseCheckBlocksAttempt ? t('readerCue.hush') : workflowComplete ? t('recorder.scriptFinished') : currentItem?.text ?? '',
    label: captureFault ? '' : noiseCheckBlocksAttempt ? '' : workflowComplete ? '' : currentItem?.label ?? '',
    cue: readerCue,
    cueLabel: readerCueLabel,
    readerCueLabel,
    silenceProgress: isPendingTake
      ? 1 - pendingRemainingMs / Math.max(effectiveSilenceDurationMs, 1)
      : 0,
    silenceDurationMs: effectiveSilenceDurationMs,
    qualityWarning: '',
  }), [captureFault, cue, currentIndex, currentItem?.id, currentItem?.label, currentItem?.text, effectiveSilenceDurationMs, isPendingTake, items.length, noiseCheckBlocksAttempt, readerCue, readerCueLabel, sessionName, snapshot?.session_id, t, workflowComplete]);

  async function run<T>(label: string, action: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setError('');
    lastOperationErrorRef.current = '';
    logUserAction('ui.operation', label);
    const startedAt = performance.now();
    try {
      const result = await action();
      logUserAction('ui.operation.ok', t('notice.completedOk', { label }), { duration_ms: Math.round(performance.now() - startedAt) });
      return result;
    } catch (caught) {
      const message = errorMessage(caught);
      lastOperationErrorRef.current = message;
      logUserAction('ui.operation.fail', t('notice.completedFail', { label, error: message }), {
        duration_ms: Math.round(performance.now() - startedAt),
        error_type: caught instanceof Error ? caught.name : typeof caught,
      }, 'error');
      reportRendererError(label, caught);
      setError(message);
      return null;
    } finally {
      setBusy('');
    }
  }

  function showUserAlert(kind: UserAlert['kind'], title: string, body: string) {
    setUserAlert({ kind, title, body });
  }

  function showBlockingError(message: string, title = t('alertDialog.errorTitle')) {
    lastOperationErrorRef.current = message;
    setError(message);
    showUserAlert('error', title, message);
  }

  function raiseDataSafetyAlert(message: string, options?: { popup?: boolean }) {
    setDataSafetyAlert(message);
    if (message && options?.popup !== false) {
      showUserAlert('warning', t('alertDialog.dataSafetyTitle'), message);
    }
  }

  function bindTaskLog(nextSessionDir: string, nextSessionId: string) {
    if (!nextSessionDir || !nextSessionId) return;
    void window.recorder.bindDebugLog?.(nextSessionDir, nextSessionId).catch(() => undefined);
  }

  function unbindTaskLog(reason: string) {
    void window.recorder.unbindDebugLog?.(reason).catch(() => undefined);
  }

  function applyAutomationRule<Key extends keyof AutomationRules>(key: Key, enabled: AutomationRules[Key]) {
    const next = { ...automationRules, [key]: enabled };
    setAutomationRules(next);
    saveAutomationRules(sessionDir, next);
    if (key !== 'envCheck') return;
    if (!enabled) {
      noiseCheckOperationRef.current = null;
      setNoiseCheckRunning(false);
      setNoiseCheckError('');
      return;
    }
    if (snapshot && !snapshot.noise_check?.passed && captureActive && !workspaceFaulted && !captureFault) {
      void runSessionNoiseCheck(sessionDir, snapshot);
    }
  }

  function clearSessionNoiseCheck(activeSessionDir = '') {
    noiseCheckActivationRef.current += 1;
    activeSessionDirRef.current = activeSessionDir;
    noiseCheckOperationRef.current = null;
    setNoiseCheckRunning(false);
    setNoiseCheckProgress(0);
    setNoiseCheckLive(null);
    setNoiseCheckSamples([]);
    setNoiseCheckError('');
  }

  async function runSessionNoiseCheck(targetSessionDir: string, currentSnapshot: SessionSnapshot) {
    if (!targetSessionDir
      || activeSessionDirRef.current !== targetSessionDir
      || noiseCheckOperationRef.current
      || currentSnapshot.noise_check?.passed) return;
    const operation: SessionNoiseCheckOperation = {
      activation: noiseCheckActivationRef.current,
      request: ++noiseCheckRequestSequenceRef.current,
      sessionDir: targetSessionDir,
    };
    noiseCheckOperationRef.current = operation;
    setNoiseCheckRunning(true);
    setNoiseCheckProgress(0);
    setNoiseCheckLive(null);
    setNoiseCheckSamples([]);
    setNoiseCheckError('');
    setError('');
    try {
      const result = await window.recorder.request<NoiseCheckResult>('check_noise', {
        threshold_dbfs: currentSnapshot.noise_threshold_dbfs
          ?? currentSnapshot.noise_check?.threshold_dbfs
          ?? noiseThresholdDbfs,
      });
      if (!isCurrentSessionNoiseCheckOperation(
        noiseCheckOperationRef.current,
        operation,
        noiseCheckActivationRef.current,
        activeSessionDirRef.current,
      )) return;
      setNoiseCheckSamples(result.samples ?? []);
      setSnapshot((previous) => previous ? {
        ...previous,
        noise_check: result,
        noise_threshold_dbfs: result.threshold_dbfs,
      } : previous);
      setNotice(result.passed
        ? t('notice.noisePassed')
        : t('notice.noiseFailed'));
    } catch (caught) {
      if (!isCurrentSessionNoiseCheckOperation(
        noiseCheckOperationRef.current,
        operation,
        noiseCheckActivationRef.current,
        activeSessionDirRef.current,
      )) return;
      setNoiseCheckError(`${t('notice.noiseFailedPrefix')}${errorMessage(caught)}`);
      setError(`${t('notice.noiseFailedPrefix')}${errorMessage(caught)}`);
    } finally {
      if (isCurrentSessionNoiseCheckOperation(
        noiseCheckOperationRef.current,
        operation,
        noiseCheckActivationRef.current,
        activeSessionDirRef.current,
      )) {
        noiseCheckOperationRef.current = null;
        setNoiseCheckRunning(false);
      }
    }
  }

  function activateSessionNoiseCheck(
    nextSnapshot: SessionSnapshot,
    targetSessionDir: string,
    isNewActivation: boolean,
  ) {
    clearSessionNoiseCheck(targetSessionDir);
    const envCheckEnabled = loadAutomationRules(targetSessionDir).envCheck;
    if (shouldAutoRunSessionNoiseCheck(nextSnapshot.noise_check, isNewActivation, envCheckEnabled)) {
      void runSessionNoiseCheck(targetSessionDir, nextSnapshot);
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

  function applyCapturePreset(preset: CapturePreset) {
    setDeviceId(preset.deviceId);
    setDeviceName(preset.deviceName);
    setSampleRate(preset.sampleRate);
    setInputSampleFormat(
      normalizeCaptureSampleFormat(preset.inputSampleFormat)
      ?? captureSampleFormatFromBitDepth(preset.bitDepth),
    );
    setInputChannel(preset.inputChannel);
    setCaptureShareMode(
      exclusiveCaptureAvailable ? normalizeCaptureShareMode(preset.captureShareMode) : 'shared',
    );
    setSilenceDurationMs(preset.silenceDurationMs);
    setNoiseThresholdDbfs(preset.silenceThresholdDbfs);
    setPresetName(preset.name);
  }

  async function loadCapturePresets() {
    try {
      const result = await window.recorder.loadCapturePresets();
      setCapturePresetStore(result.store);
      const selected = result.store.presets.find((preset) => preset.id === result.store.lastSelectedPresetId);
      if (selected) setPresetName(selected.name);
      setPresetWarning(result.warning ?? '');
      return result.store;
    } catch (caught) {
      setError(`${t('notice.loadPresetsPrefix')}${errorMessage(caught)}`);
      return { schemaVersion: 1, lastSelectedPresetId: null, presets: [] } satisfies CapturePresetStore;
    } finally {
      setCapturePresetsLoaded(true);
    }
  }

  async function loadDevices(): Promise<AudioDevice[]> {
    const result = await run(t('notice.detectDevices'), () => window.recorder.request<{
      devices: AudioDevice[];
      default_device_id: string | null;
    }>('list_devices'));
    if (!result) return [];
    setDevices(result.devices);
    const currentDevice = result.devices.find((device) => device.id === deviceId) ?? null;
    if (currentDevice) {
      setDeviceName(currentDevice.name);
    } else if (!deviceId) {
      const preferred = result.devices.find((device) => device.id === result.default_device_id)
        ?? result.devices[0]
        ?? null;
      setDeviceId(preferred?.id ?? '');
      setDeviceName(preferred?.name ?? '');
    }
    setDevicesLoaded(true);
    setEngineStatus('ready');
    setNotice(result.devices.length ? t('notice.engineReady') : t('notice.noInputDevices'));
    return result.devices;
  }

  function currentCapturePresetDraft(name: string, id?: string): CapturePresetDraft | null {
    if (!selectedDevice || !captureConfigurationValid) {
      setError(selectedDevice ? t('notice.presetDeviceInvalid') : t('notice.pickAvailableDevice'));
      return null;
    }
    return {
      id,
      name,
      deviceId: selectedDevice.id,
      deviceName: selectedDevice.name,
      sampleRate,
      bitDepth: bitDepth as 16 | 24 | 32,
      inputSampleFormat: normalizeCaptureSampleFormat(inputSampleFormat) ?? captureSampleFormatFromBitDepth(bitDepth),
      inputChannel,
      captureShareMode,
      silenceDurationMs,
      silenceThresholdDbfs: noiseThresholdDbfs,
    };
  }

  async function selectCapturePreset(id: string) {
    if (presetOperationRef.current) return;
    presetOperationRef.current = true;
    setPresetBusy(true);
    try {
      const selected = capturePresetStore.presets.find((preset) => preset.id === id) ?? null;
      const store = await window.recorder.setLastCapturePreset(selected?.id ?? null);
      setCapturePresetStore(store);
      if (selected) applyCapturePreset(selected);
      else setPresetName('');
      setError('');
      setPresetWarning('');
    } catch (caught) {
      setError(`${t('notice.selectPresetPrefix')}${errorMessage(caught)}`);
    } finally {
      presetOperationRef.current = false;
      setPresetBusy(false);
    }
  }

  async function saveCapturePreset(mode: 'new' | 'update') {
    if (presetOperationRef.current) return;
    const name = presetName.trim();
    const draft = currentCapturePresetDraft(name, mode === 'update' ? selectedCapturePreset?.id : undefined);
    if (!draft) return;
    presetOperationRef.current = true;
    setPresetBusy(true);
    try {
      const store = await window.recorder.saveCapturePreset(draft);
      setCapturePresetStore(store);
      const saved = store.presets.find((preset) => preset.id === store.lastSelectedPresetId);
      if (saved) setPresetName(saved.name);
      setPresetManagerOpen(false);
      setError('');
      setPresetWarning('');
      setNotice(mode === 'update' ? t('notice.presetUpdated', { name }) : t('notice.presetSaved', { name }));
    } catch (caught) {
      setError(`${t('notice.savePresetPrefix')}${errorMessage(caught)}`);
    } finally {
      presetOperationRef.current = false;
      setPresetBusy(false);
    }
  }

  async function deleteCapturePreset() {
    if (!selectedCapturePreset || presetOperationRef.current) return;
    presetOperationRef.current = true;
    setPresetBusy(true);
    try {
      const removedName = selectedCapturePreset.name;
      const store = await window.recorder.deleteCapturePreset(selectedCapturePreset.id);
      setCapturePresetStore(store);
      setPresetName('');
      setPresetManagerOpen(false);
      setError('');
      setPresetWarning('');
      setNotice(t('notice.presetDeleted', { removed: removedName }));
    } catch (caught) {
      setError(`${t('notice.deletePresetPrefix')}${errorMessage(caught)}`);
    } finally {
      presetOperationRef.current = false;
      setPresetBusy(false);
    }
  }

  async function refreshRecordings(root = outputDir) {
    const sequence = ++historyLoadSequenceRef.current;
    setHistoryLoadingMore(false);
    setHistoryNextOffset(null);
    if (!root) {
      setRecordings([]);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const result = await window.recorder.listRecordings(
        root,
        { offset: 0, limit: HISTORY_PAGE_SIZE },
      );
      if (sequence !== historyLoadSequenceRef.current) return;
      setRecordings(result.recordings);
      setHistoryNextOffset(result.next_offset);
      setError((current) => current.startsWith(t('notice.historyPrefix')) ? '' : current);
    } catch (caught) {
      if (sequence !== historyLoadSequenceRef.current) return;
      setRecordings([]);
      setHistoryNextOffset(null);
      setError(`${t('notice.historyPrefix')}${errorMessage(caught)}`);
    } finally {
      if (sequence === historyLoadSequenceRef.current) setHistoryLoading(false);
    }
  }

  async function loadMoreRecordings() {
    if (historyNextOffset === null || historyLoadingMore || !outputDir) return;
    const sequence = historyLoadSequenceRef.current;
    setHistoryLoadingMore(true);
    try {
      const result = await window.recorder.listRecordings(
        outputDir,
        { offset: historyNextOffset, limit: HISTORY_PAGE_SIZE },
      );
      if (sequence !== historyLoadSequenceRef.current) return;
      setRecordings((current) => {
        const known = new Set(current.map((recording) => recording.session_dir));
        return [...current, ...result.recordings.filter((recording) => !known.has(recording.session_dir))];
      });
      setHistoryNextOffset(result.next_offset);
      setError((current) => current.startsWith(t('notice.moreHistoryPrefix')) ? '' : current);
    } catch (caught) {
      if (sequence === historyLoadSequenceRef.current) {
        setError(`${t('notice.moreHistoryPrefix')}${errorMessage(caught)}`);
      }
    } finally {
      if (sequence === historyLoadSequenceRef.current) setHistoryLoadingMore(false);
    }
  }

  async function resetHistoricalRecording(recording: RecordingHistoryEntry) {
    if (!outputDir || recording.is_active || resettingSessionDir || deletingSessionDir) return;
    setResettingSessionDir(recording.session_dir);
    setBusy(t('notice.resettingTask'));
    setError('');
    try {
      logUserAction('ui.reset_task', `重置录制任务 ${recording.session_id}`, {
        session_id: recording.session_id,
        session_dir: recording.session_dir,
        status: recording.status,
      });
      await window.recorder.resetRecording(
        outputDir,
        recording.session_dir,
        recording.session_id,
      );
      setResumeError((current) => current?.sessionDir === recording.session_dir ? null : current);
      setNotice(t('notice.resetTask', { id: recording.session_id }));
      await refreshRecordings();
    } catch (caught) {
      showBlockingError(`${t('notice.resetTaskPrefix')}${errorMessage(caught)}`);
    } finally {
      setResettingSessionDir('');
      setBusy('');
    }
  }

  async function deleteHistoricalRecording(recording: RecordingHistoryEntry) {
    if (!outputDir || recording.is_active || deletingSessionDir) return;
    setDeletingSessionDir(recording.session_dir);
    setBusy(t('notice.deletingTask'));
    setError('');
    try {
      logUserAction('ui.delete_task', `删除录制任务 ${recording.session_id}`, {
        session_id: recording.session_id,
        session_dir: recording.session_dir,
        status: recording.status,
      });
      await window.recorder.deleteRecording(
        outputDir,
        recording.session_dir,
        recording.session_id,
      );
      setRecordings((current) => current.filter((candidate) => (
        candidate.session_dir !== recording.session_dir
      )));
      setResumeError((current) => current?.sessionDir === recording.session_dir ? null : current);
      setNotice(t('notice.deletedTask', { id: recording.session_id }));
      await refreshRecordings();
    } catch (caught) {
      showBlockingError(`${t('notice.deleteTaskPrefix')}${errorMessage(caught)}`);
    } finally {
      setDeletingSessionDir('');
      setBusy('');
    }
  }

  useEffect(() => {
    let active = true;
    const meterFrameCommitter = createLatestFrameCommitter<Meter>(
      (nextMeter) => {
        if (active && shouldHandleLiveMeter(phaseRef.current)) setMeter(nextMeter);
      },
      (callback) => window.requestAnimationFrame(callback),
      (handle) => window.cancelAnimationFrame(handle),
    );
    meterFrameCommitterRef.current = meterFrameCommitter;
    void loadCapturePresets();
    window.recorder.defaultOutput().then((result) => {
      if (!active) return;
      if (result.warning || !result.outputRoot) {
        setHistoryLoading(false);
        setError(`${t('notice.reselectOutputPrefix')}${result.warning ?? t('notice.noOutputReturned')}`);
        return;
      }
      outputDirRef.current = result.outputRoot;
      setOutputDir(result.outputRoot);
      void refreshRecordings(result.outputRoot);
    }).catch((caught) => {
      if (active) {
        setHistoryLoading(false);
        setError(`${t('notice.defaultOutputPrefix')}${errorMessage(caught)}`);
      }
    });
    window.recorder.request('hello').then(() => {
      if (!active) return;
      setEngineStatus('ready');
      logUserAction('ui.engine.ready', '录音引擎握手成功');
      void loadDevices().then((availableDevices) => queryRunningSession().then((current) => {
        if (!active || !current.active) return;
        if (current.snapshot.status !== 'recording') {
          setError(t('notice.stillSealing'));
          void refreshRecordings(outputDirRef.current);
          return;
        }
        enterRunningSession(current, false, availableDevices);
      })).catch(() => undefined);
    }).catch((caught) => {
      if (!active) return;
      setEngineStatus('offline');
      logUserAction('ui.engine.offline', `无法连接录音引擎：${errorMessage(caught)}`, {
        error_type: caught instanceof Error ? caught.name : typeof caught,
      }, 'error');
      setError(`${t('notice.connectEnginePrefix')}${errorMessage(caught)}`);
    });
    const unsubscribeEvent = window.recorder.onEngineEvent((raw) => {
      const message = raw as EngineEvent;
      const terminalRecoveryFailure = engineRecoveryFailure(message);
      if (message.event === 'meter') {
        if (!shouldHandleLiveMeter(phaseRef.current)) return;
        const nextMeter = message.payload as Meter;
        const hydratedMeter = { ...emptyMeter, ...nextMeter };
        const hasCaptureFault = hydratedMeter.faulted
          || hydratedMeter.overflow_samples > 0
          || hydratedMeter.storage_status === 'critical';
        if (hasCaptureFault) {
          // Fault telemetry is state, not a disposable visual frame. Cancel a
          // queued healthy meter and publish the fault immediately.
          meterFrameCommitter.commitImmediately(hydratedMeter);
          const fault = describeCaptureFault(hydratedMeter);
          setError(`${fault.title}：${fault.detail}`);
        } else {
          // Renderer stalls may release many old IPC meter events at once.
          // Commit only the newest one on the next paint instead of visibly
          // replaying stale waveform frames at catch-up speed.
          meterFrameCommitter.enqueue(hydratedMeter);
        }
      } else if (message.event === 'engine_recovered') {
        const payload = message.payload as { state?: RunningSessionState };
        setEngineStatus('ready');
        setError('');
        if (payload.state?.snapshot.status === 'recording') {
          enterRunningSession(payload.state, true);
          setNotice(t('notice.engineRecovered'));
        } else if (payload.state?.snapshot) {
          setPhase('home');
          setError(t('notice.engineStillSealing'));
          void refreshRecordings(outputDirRef.current);
        }
      } else if (terminalRecoveryFailure) {
        sealOperationRef.current = false;
        setEngineStatus('offline');
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
        clearAudioPreview();
        setFinishConfirmOpen(false);
        setPauseConfirmOpen(false);
        clearSessionNoiseCheck();
        setBusy('');
        setDataSafetyAlert('');
        showBlockingError(t('notice.recoveryFailed', { error: terminalRecoveryFailure.error }));
        setNotice(t('notice.returnedNeedRepair'));
        void refreshRecordings(outputDirRef.current);
      } else if (message.event === 'offline_seal_cleanup_finished') {
        setEngineStatus('ready');
        setNotice(t('notice.offlineSealDone'));
      } else if (message.event === 'engine_idle_after_stopping_crash') {
        setEngineStatus('ready');
        setNotice(t('notice.engineRestarted'));
      } else if (message.event === 'noise_check_started') {
        if (!noiseCheckOperationRef.current) return;
        setNoiseCheckLive(null);
        setNoiseCheckSamples([]);
        setNoiseCheckProgress(0);
      } else if (message.event === 'noise_check_progress') {
        if (!noiseCheckOperationRef.current) return;
        const progress = message.payload as Partial<NoiseCheckProgress> | undefined;
        if (!progress || typeof progress.rms_dbfs !== 'number') return;
        const sampleIndex = typeof progress.sample_index === 'number' ? progress.sample_index : 0;
        const rmsDbfs = progress.rms_dbfs;
        setNoiseCheckLive({
          sample_index: sampleIndex,
          sample_count: typeof progress.sample_count === 'number' ? progress.sample_count : NOISE_CHECK_STEPS,
          rms_dbfs: rmsDbfs,
          peak_dbfs: typeof progress.peak_dbfs === 'number' ? progress.peak_dbfs : rmsDbfs,
          threshold_dbfs: typeof progress.threshold_dbfs === 'number' ? progress.threshold_dbfs : -42,
        });
        setNoiseCheckProgress(sampleIndex);
        setNoiseCheckSamples((samples) => [...samples, rmsDbfs].slice(-NOISE_CHECK_STEPS));
      }
    });
    const unsubscribeOffline = window.recorder.onEngineOffline((message) => {
      setEngineStatus('offline');
      logUserAction('ui.engine.offline', message, undefined, 'error');
      setError(message);
    });
    const unsubscribePrompterStatus = window.recorder.onPrompterStatus(setPrompterStatus);
    void window.recorder.getPrompterStatus().then((status) => {
      if (active) setPrompterStatus(status);
    }).catch(() => undefined);
    return () => {
      active = false;
      meterFrameCommitter.dispose();
      if (meterFrameCommitterRef.current === meterFrameCommitter) {
        meterFrameCommitterRef.current = null;
      }
      unsubscribeEvent();
      unsubscribeOffline();
      unsubscribePrompterStatus();
    };
    // Initial engine discovery only runs when the renderer mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    outputDirRef.current = outputDir;
  }, [outputDir]);

  useEffect(() => {
    const session = exportRecording?.session_dir || sessionDir;
    if (!session) {
      setTaskExportDir('');
      return;
    }
    let cancelled = false;
    void window.recorder.joinPath(session, 'export').then((value) => {
      if (!cancelled) setTaskExportDir(value);
    });
    return () => {
      cancelled = true;
    };
  }, [exportRecording?.session_dir, sessionDir]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  useEffect(() => {
    if (!previewOpen) return;
    clearAudioPreview();
  }, [currentIndex]);

  useEffect(() => {
    window.recorder.sendPrompterState(prompterState);
  }, [prompterState]);

  useEffect(() => {
    setAutomationRules(loadAutomationRules(sessionDir));
    takePeakRef.current = 0;
    setReviewPeak(0);
    discontinuityToastStateRef.current = initialDiscontinuityToastState();
    setDiscontinuityToast('');
    if (discontinuityToastTimerRef.current !== null) {
      window.clearTimeout(discontinuityToastTimerRef.current);
      discontinuityToastTimerRef.current = null;
    }
  }, [sessionDir]);

  useEffect(() => {
    if (!recording) return;
    takePeakRef.current = Math.max(takePeakRef.current, meter.peak);
  }, [recording, meter.peak]);

  useEffect(() => {
    const observed = shouldShowDiscontinuityToast(discontinuityToastStateRef.current, {
      count: discontinuityCount,
      silenceSamples: discontinuitySilenceSamples,
      sampleRate: sampleRateForDisplay,
      nowMs: Date.now(),
    });
    discontinuityToastStateRef.current = observed.state;
    if (!observed.show || !discontinuityWarning) return;
    setDiscontinuityToast(discontinuityWarning);
    if (discontinuityToastTimerRef.current !== null) {
      window.clearTimeout(discontinuityToastTimerRef.current);
    }
    discontinuityToastTimerRef.current = window.setTimeout(() => {
      setDiscontinuityToast('');
      discontinuityToastTimerRef.current = null;
    }, DISCONTINUITY_TOAST_MS);
  }, [discontinuityCount, discontinuitySilenceSamples, discontinuityWarning, sampleRateForDisplay]);

  useEffect(() => () => {
    if (discontinuityToastTimerRef.current !== null) {
      window.clearTimeout(discontinuityToastTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!exclusiveCaptureAvailable || !selectedDevice) return;
    if (deviceExclusiveAvailable(selectedDevice)) return;
    setCaptureShareMode((current) => {
      if (current !== 'exclusive') return current;
      setNotice(t('setup.exclusiveFellBack'));
      return 'shared';
    });
  }, [exclusiveCaptureAvailable, selectedDevice]);

  useEffect(() => {
    if (!captureFault || !pauseConfirmOpen) return;
    // A capture/connection fault invalidates the healthy pause promise. Move
    // an already-open back dialog onto the same fault-aware exit path used by
    // the main transport immediately.
    setPauseConfirmOpen(false);
    setFinishConfirmOpen(true);
  }, [captureFault, pauseConfirmOpen]);

  useEffect(() => {
    const issueJustAppeared = hasBlockingMonitorIssues && !hadMonitorIssuesRef.current;
    hadMonitorIssuesRef.current = hasBlockingMonitorIssues;
    if (issueJustAppeared && phase === 'running') setMonitorPanelTab('issues');
    else if (!hasMonitorIssues) setMonitorPanelTab((current) => current === 'issues' ? 'monitor' : current);
  }, [hasBlockingMonitorIssues, hasMonitorIssues, phase]);

  useEffect(() => {
    if (selectedCapturePreset) return;
    if (inputChannel > activeInputChannels) setInputChannel(1);
    if (selectedDevice && !rateOptions.includes(sampleRate)) {
      setSampleRate(rateOptions.includes(48_000) ? 48_000 : rateOptions[0] ?? 48_000);
    }
    if (selectedDevice && formatOptions.length > 0 && !formatOptions.some((format) => format === inputSampleFormat)) {
      setInputSampleFormat(preferredCaptureSampleFormat(formatOptions) ?? formatOptions[0]);
    }
  }, [activeInputChannels, formatOptions, inputChannel, inputSampleFormat, rateOptions, sampleRate, selectedCapturePreset, selectedDevice]);

  useEffect(() => {
    if (!capturePresetsLoaded || !devicesLoaded || initialPresetAppliedRef.current || phase === 'running' || snapshot) return;
    initialPresetAppliedRef.current = true;
    if (selectedCapturePreset) applyCapturePreset(selectedCapturePreset);
  }, [capturePresetsLoaded, devicesLoaded, phase, selectedCapturePreset, snapshot]);

  useEffect(() => {
    let cancelled = false;
    void window.recorder.devWebCapture?.().then((enabled) => {
      if (!cancelled) setDevWebCaptureEnabled(Boolean(enabled));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!devWebCaptureEnabled || !captureActive || !sessionDir || workspaceFaulted) {
      setDevWebCaptureNotice('');
      return;
    }
    const sampleRate = snapshot?.audio_format.sample_rate ?? 48_000;
    const preferredDeviceLabel = snapshot?.device_name ?? '';
    let stopped = false;
    let handle: DevWebCaptureHandle | null = null;
    setDevWebCaptureNotice(t('recorder.devWebCaptureStarting'));
    void startDevWebCapture({
      sampleRate,
      preferredDeviceLabel,
      feed: (samples) => window.recorder.request('dev_feed_pcm', { samples }),
    }).then((started) => {
      if (stopped) {
        started.stop();
        return;
      }
      handle = started;
      setDevWebCaptureNotice(t('recorder.devWebCaptureOn'));
    }).catch((caught) => {
      if (stopped) return;
      const denied = caught instanceof DOMException && caught.name === 'NotAllowedError';
      setDevWebCaptureNotice(denied
        ? t('recorder.devWebCaptureDenied')
        : t('recorder.devWebCaptureFailed', { error: errorMessage(caught) }));
    });
    return () => {
      stopped = true;
      handle?.stop();
    };
  }, [devWebCaptureEnabled, captureActive, sessionDir, workspaceFaulted, snapshot?.audio_format.sample_rate, snapshot?.device_name, t]);

  function enterRunningSession(
    current: RunningSessionState,
    wasRecovered: boolean,
    availableDevices = devices,
    keepItemId?: string | null,
  ) {
    const nextSnapshot = current.snapshot;
    const nextSessionDir = current.session_dir || activeSessionDirRef.current || sessionDir;
    const threshold = nextSnapshot.silence_threshold_dbfs ?? nextSnapshot.noise_check?.threshold_dbfs ?? -42;
    const restoredIndex = resolveRunningItemIndex(
      nextSnapshot.items,
      current.active_attempt?.item_id,
      keepItemId,
    );
    const restoredItem = nextSnapshot.items[restoredIndex];
    // A suspended renderer may still hold a healthy meter from the previous
    // engine/session generation. It must not overwrite this authoritative
    // recovery snapshot on the next animation frame.
    meterFrameCommitterRef.current?.invalidate();
    setSnapshot(nextSnapshot);
    setCaptureActive(true);
    setWorkspaceFaulted(nextSnapshot.status === 'faulted' || nextSnapshot.overflow_samples > 0);
    if (wasRecovered) setWaveformGeneration((generation) => generation + 1);
    if (nextSessionDir) setSessionDir(nextSessionDir);
    setSessionName(nextSnapshot.session_id);
    setScriptFile(nextSnapshot.script_name ?? '');
    setDeviceId(nextSnapshot.device_id ?? availableDevices.find((device) => device.name === nextSnapshot.device_name)?.id ?? '');
    setDeviceName(nextSnapshot.device_name);
    setSampleRate(nextSnapshot.audio_format.sample_rate);
    setInputSampleFormat(
      normalizeCaptureSampleFormat(nextSnapshot.input_sample_format)
      ?? captureSampleFormatFromBitDepth(nextSnapshot.audio_format.bit_depth),
    );
    setInputChannel(nextSnapshot.audio_format.input_channel ?? 1);
    setCaptureShareMode(
      exclusiveCaptureAvailable
        ? normalizeCaptureShareMode(nextSnapshot.capture_share_mode)
        : 'shared',
    );
    setSilenceDurationMs(nextSnapshot.silence_duration_ms ?? 1_000);
    setNoiseThresholdDbfs(threshold);
    setTaskInitialSilenceThresholdDbfs(threshold);
    setTaskInitialSilenceDurationMs(nextSnapshot.silence_duration_ms ?? 1_000);
    setSilenceThresholdDraftDbfs(threshold);
    setSilenceDurationDraftMs(nextSnapshot.silence_duration_ms ?? 1_000);
    setSilenceSettingsError('');
    setCurrentIndex(restoredIndex);
    setRecording(Boolean(current.active_attempt));
    setAttemptStartSample(current.active_attempt?.start_sample ?? 0);
    setAttemptRecordingStartedSample(current.active_attempt?.recording_started_sample ?? current.active_attempt?.start_sample ?? 0);
    setReviewAttemptId(!current.active_attempt && restoredItem?.status === 'review'
      ? latestUsableAttempt(restoredItem)?.attempt_id ?? null
      : null);
    setMeter({
      ...emptyMeter,
      captured_samples: nextSnapshot.captured_samples,
      committed_samples: nextSnapshot.committed_samples,
      overflow_samples: nextSnapshot.overflow_samples,
      silence_threshold_dbfs: threshold,
      silence_duration_ms: nextSnapshot.silence_duration_ms,
      head_silence_phase: current.active_attempt?.head_silence_phase ?? 'idle',
      head_silence_armed_sample: current.active_attempt?.head_silence_armed_sample ?? 0,
      head_silence_progress_samples: current.active_attempt?.head_silence_progress_samples ?? 0,
      required_head_silence_samples: current.active_attempt?.required_head_silence_samples ?? 0,
      head_silence_passed_sample: current.active_attempt?.head_silence_passed_sample ?? 0,
      content_started_sample: current.active_attempt?.content_started_sample ?? 0,
    });
    setFinishConfirmOpen(false);
    setPauseConfirmOpen(false);
    setPhase('running');
    bindTaskLog(nextSessionDir, nextSnapshot.session_id);
    logUserAction('ui.enter_session', wasRecovered ? '已恢复并进入录制任务' : '已进入录制任务', {
      session_id: nextSnapshot.session_id,
      session_dir: nextSessionDir,
      recovered: wasRecovered,
      status: nextSnapshot.status,
      device_name: nextSnapshot.device_name,
      sample_rate: nextSnapshot.audio_format.sample_rate,
      bit_depth: nextSnapshot.audio_format.bit_depth,
      items: nextSnapshot.items.length,
    });
    activateSessionNoiseCheck(nextSnapshot, nextSessionDir, wasRecovered);
    setNotice(current.active_attempt
      ? t('notice.reconnectedItem', { id: current.active_attempt.item_id })
      : wasRecovered
        ? t('notice.taskRestored')
        : t('notice.reconnected'));
    const recovered = splitRecoveryWarnings(current.recovery_warnings);
    if (recovered.benign.length) {
      logUserAction('ui.recovery.journal', recovered.benign.join(' | '));
    }
    if (recovered.serious.length) {
      setDataSafetyAlert(t('notice.usedLatestCopy', {
        warning: recoveryWarning(t('notice.recoveryStorage'), recovered.serious),
      }));
    } else if (recovered.benign.length) {
      setDataSafetyAlert(t('notice.recoveryOk'));
    }
  }

  function enterInspectionWorkspace(current: InspectedSessionState) {
    const nextSnapshot = current.snapshot;
    clearAudioPreview();
    meterFrameCommitterRef.current?.invalidate();
    setSnapshot(nextSnapshot);
    setSessionDir(current.session_dir);
    bindTaskLog(current.session_dir, nextSnapshot.session_id);
    logUserAction('ui.inspect_session', '已打开任务检查工作区', {
      session_id: nextSnapshot.session_id,
      session_dir: current.session_dir,
      status: nextSnapshot.status,
      faulted: current.faulted,
    });
    setSessionName(nextSnapshot.session_id);
    setScriptFile(nextSnapshot.script_name ?? '');
    setDeviceId(nextSnapshot.device_id ?? '');
    setDeviceName(nextSnapshot.device_name);
    setSampleRate(nextSnapshot.audio_format.sample_rate);
    setInputSampleFormat(
      normalizeCaptureSampleFormat(nextSnapshot.input_sample_format)
      ?? captureSampleFormatFromBitDepth(nextSnapshot.audio_format.bit_depth),
    );
    setInputChannel(nextSnapshot.audio_format.input_channel ?? 1);
    setCaptureShareMode(
      exclusiveCaptureAvailable
        ? normalizeCaptureShareMode(nextSnapshot.capture_share_mode)
        : 'shared',
    );
    setSilenceDurationMs(nextSnapshot.silence_duration_ms ?? 1_000);
    const taskThreshold = nextSnapshot.silence_threshold_dbfs ?? -42;
    setNoiseThresholdDbfs(taskThreshold);
    setTaskInitialSilenceThresholdDbfs(taskThreshold);
    setTaskInitialSilenceDurationMs(nextSnapshot.silence_duration_ms ?? 1_000);
    setSilenceThresholdDraftDbfs(taskThreshold);
    setSilenceDurationDraftMs(nextSnapshot.silence_duration_ms ?? 1_000);
    setSilenceSettingsError('');
    setCurrentIndex(0);
    setRecording(false);
    setCaptureActive(false);
    const faulted = current.data_health === 'readonly' || Boolean(
      current.faulted
      || nextSnapshot.status === 'faulted'
      || nextSnapshot.overflow_samples > 0,
    );
    setWorkspaceFaulted(faulted);
    setAttemptStartSample(0);
    setAttemptRecordingStartedSample(0);
    const firstItem = nextSnapshot.items[0];
    setReviewAttemptId(firstItem?.selected_attempt_id ?? (firstItem ? latestUsableAttempt(firstItem)?.attempt_id : null) ?? null);
    setMeter({ ...emptyMeter, captured_samples: nextSnapshot.captured_samples, committed_samples: nextSnapshot.committed_samples, overflow_samples: nextSnapshot.overflow_samples });
    clearSessionNoiseCheck();
    setPhase('running');
    const recovered = splitRecoveryWarnings(current.recovery_warnings);
    if (recovered.benign.length) {
      logUserAction('ui.recovery.journal', recovered.benign.join(' | '));
    }
    if (recovered.serious.length) {
      setDataSafetyAlert(recoveryWarning(t('notice.openStorageHint'), recovered.serious));
    } else if (recovered.benign.length) {
      setDataSafetyAlert(t('notice.recoveryOk'));
    } else {
      setDataSafetyAlert('');
    }
    setNotice(faulted
      ? t('notice.readonlyProtect')
      : current.data_health === 'needs_repair'
        ? t('notice.inspectRepairFirst')
        : t('notice.inspectCardOff'));
  }

  async function chooseScript() {
    const file = await window.recorder.openScript();
    if (!file) return;
    const parsed = parseScript(file.content);
    setScriptFile(file.name);
    setSessionName(file.name.replace(/\.[^.]+$/, '') || t('setup.newSessionName'));
    setScriptItems(parsed.items);
    setScriptErrors(parsed.errors);
    logUserAction(
      parsed.errors.length ? 'ui.import_script.invalid' : 'ui.import_script',
      parsed.errors.length ? `脚本 ${file.name} 需要修正` : `已导入脚本 ${file.name}`,
      { name: file.name, items: parsed.items.length, errors: parsed.errors.slice(0, 8) },
      parsed.errors.length ? 'warn' : 'info',
    );
    setNotice(parsed.errors.length ? t('notice.scriptNeedsFix') : t('notice.importedItems', { count: parsed.items.length }));
  }

  async function chooseScriptFile(file: File | undefined) {
    if (!file) return;
    const parsed = parseScript(await file.text());
    setScriptFile(file.name);
    setSessionName(file.name.replace(/\.[^.]+$/, '') || t('setup.newSessionName'));
    setScriptItems(parsed.items);
    setScriptErrors(parsed.errors);
    logUserAction(
      parsed.errors.length ? 'ui.import_script.invalid' : 'ui.import_script',
      parsed.errors.length ? `脚本 ${file.name} 需要修正` : `已导入脚本 ${file.name}`,
      { name: file.name, items: parsed.items.length, errors: parsed.errors.slice(0, 8) },
      parsed.errors.length ? 'warn' : 'info',
    );
    setNotice(parsed.errors.length ? t('notice.scriptNeedsFix') : t('notice.importedItems', { count: parsed.items.length }));
  }

  async function chooseOutput() {
    try {
      const selected = await window.recorder.chooseOutput();
      if (selected) {
        logUserAction('ui.choose_output', '已更改默认保存位置', { output_dir: selected });
        setOutputDir(selected);
        setError((current) => (
          current.startsWith(t('notice.reselectOutputPrefix')) ? '' : current
        ));
        await refreshRecordings(selected);
      }
    } catch (caught) {
      setError(`${t('notice.changeOutputPrefix')}${errorMessage(caught)}`);
    }
  }

  async function openPrompterPanel() {
    window.recorder.sendPrompterState(prompterState);
    const opened = await run(t('notice.openingPrompter'), () => window.recorder.openPrompter());
    if (opened) {
      setPrompterStatus({ open: true, ready: true });
      setNotice(t('notice.prompterOpened'));
    }
  }

  async function applyTaskSilenceSettings(thresholdValue: number, durationValue: number) {
    const threshold = Math.min(-12, Math.max(-72, Math.round(thresholdValue)));
    const durationMs = Math.min(5_000, Math.max(200, Math.round(durationValue / 100) * 100));
    setSilenceThresholdDraftDbfs(threshold);
    setSilenceDurationDraftMs(durationMs);
    if (!snapshot || !captureActive || workspaceFaulted || captureFault
      || (threshold === noiseThresholdDbfs && durationMs === silenceDurationMs)) return;
    const request = ++silenceSettingsSaveSequenceRef.current;
    setSilenceSettingsSaving(true);
    setSilenceSettingsError('');
    try {
      const result = await window.recorder.request<{
        threshold_dbfs: number;
        silence_duration_ms: number;
        reset_kind: 'idle' | 'head_silence' | 'tail_silence';
        snapshot: SessionSnapshot;
      }>('set_silence_settings', { threshold_dbfs: threshold, silence_duration_ms: durationMs });
      if (request !== silenceSettingsSaveSequenceRef.current) return;
      setSnapshot(result.snapshot);
      setNoiseThresholdDbfs(result.threshold_dbfs);
      setSilenceDurationMs(result.silence_duration_ms);
      setSilenceThresholdDraftDbfs(result.threshold_dbfs);
      setSilenceDurationDraftMs(result.silence_duration_ms);
      setMeter((previous) => ({
        ...previous,
        silence_threshold_dbfs: result.threshold_dbfs,
        silence_duration_ms: result.silence_duration_ms,
        silence_samples: 0,
        ...(result.reset_kind === 'head_silence' ? {
          head_silence_phase: 'waiting_for_head_silence' as HeadSilencePhase,
          head_silence_progress_samples: 0,
          head_silence_passed_sample: 0,
          content_started_sample: 0,
          last_signal_sample: 0,
        } : result.reset_kind === 'tail_silence' ? {
          last_signal_sample: previous.captured_samples,
        } : {}),
      }));
      setNotice(result.reset_kind === 'head_silence'
        ? t('notice.silenceHead')
        : result.reset_kind === 'tail_silence'
          ? t('notice.silenceTail')
          : t('notice.silenceApplied', {
            db: result.threshold_dbfs,
            seconds: (result.silence_duration_ms / 1_000).toFixed(1),
          }));
    } catch (caught) {
      if (request !== silenceSettingsSaveSequenceRef.current) return;
      setSilenceThresholdDraftDbfs(noiseThresholdDbfs);
      setSilenceDurationDraftMs(silenceDurationMs);
      setSilenceSettingsError(`${t('notice.applyFailedPrefix')}${errorMessage(caught)}`);
      reportRendererError('更新任务静音设置', caught);
    } finally {
      if (request === silenceSettingsSaveSequenceRef.current) setSilenceSettingsSaving(false);
    }
  }

  async function startSession(options?: {
    captureShareMode?: CaptureShareMode;
    inputSampleFormat?: string;
    activateAfterCreate?: boolean;
  }): Promise<boolean> {
    const nextShareMode = options?.captureShareMode ?? captureShareMode;
    const nextSampleFormat = options?.inputSampleFormat ?? inputSampleFormat;
    const nextBitDepth = deliveryBitDepthForCaptureFormat(nextSampleFormat);
    if (options?.captureShareMode) setCaptureShareMode(nextShareMode);
    if (options?.inputSampleFormat) setInputSampleFormat(nextSampleFormat);
    const settingsAlreadyChosen = Boolean(options?.captureShareMode || options?.inputSampleFormat);
    if (!scriptItems.length || scriptErrors.length || !selectedDevice || !outputDir || (!settingsAlreadyChosen && !captureConfigurationValid)) {
      if (!settingsAlreadyChosen && captureConfigurationIssue) setError(captureConfigurationIssue);
      return false;
    }
    const sessionId = `${safeSessionName(sessionName.replace(/-\d{8}-\d{6}$/, ''))}-${timestamp()}`;
    const destination = await window.recorder.joinPath(outputDir, sessionId);
    const result = await run(t('notice.creatingTask'), () => window.recorder.request<InspectedSessionState>('create_session', {
      session_dir: destination,
      session_id: sessionId,
      script_name: scriptFile,
      device_id: selectedDevice.id,
      device_name: selectedDevice.name,
      sample_rate: sampleRate,
      bit_depth: nextBitDepth,
      input_sample_format: nextSampleFormat,
      input_channel: inputChannel,
      capture_share_mode: nextShareMode,
      silence_duration_ms: silenceDurationMs,
      noise_threshold_dbfs: noiseThresholdDbfs,
      silence_threshold_dbfs: noiseThresholdDbfs,
      items: scriptItems,
    }));
    if (!result) return false;
    setDataSafetyAlert('');
    logUserAction('ui.create_session', `已创建录制任务 ${sessionId}`, {
      session_id: sessionId,
      session_dir: destination,
      script_name: scriptFile,
      device_id: selectedDevice.id,
      device_name: selectedDevice.name,
      sample_rate: sampleRate,
      bit_depth: nextBitDepth,
      input_sample_format: nextSampleFormat,
      input_channel: inputChannel,
      item_count: scriptItems.length,
    });
    enterInspectionWorkspace(result);
    setNotice(options?.activateAfterCreate ? t('activationError.recreatedNotice') : t('notice.taskCreated'));
    if (options?.activateAfterCreate) {
      return activateCaptureAndPrompter(undefined, result.session_dir);
    }
    return true;
  }

  function presentActivationFailure(error: unknown) {
    const classified = classifyEngineError(error);
    setActivationFailure(classified);
    setActivationFailureOpen(classified.canEditCaptureSettings);
    setRecoveryShareMode(classified.canEditCaptureSettings && exclusiveCaptureAvailable ? 'shared' : captureShareMode);
    setRecoverySampleFormat(inputSampleFormat);
  }

  async function activateCapture(keepItemId?: string | null, targetSessionDir?: string): Promise<boolean> {
    const dir = targetSessionDir || sessionDir;
    if (!dir || captureActive || workspaceFaulted) return captureActive;
    setBusy(t('notice.enablingCard'));
    setError('');
    lastOperationErrorRef.current = '';
    logUserAction('ui.operation', t('notice.enablingCard'));
    const startedAt = performance.now();
    try {
      const result = await window.recorder.request<RunningSessionState>('activate_session', {
        session_dir: dir,
      });
      logUserAction('ui.operation.ok', t('notice.completedOk', { label: t('notice.enablingCard') }), {
        duration_ms: Math.round(performance.now() - startedAt),
      });
      setActivationFailure(null);
      setActivationFailureOpen(false);
      enterRunningSession(result, true, devices, keepItemId);
      setNotice(t('notice.cardEnabled'));
      return true;
    } catch (caught) {
      const message = errorMessage(caught);
      lastOperationErrorRef.current = message;
      logUserAction('ui.operation.fail', t('notice.completedFail', { label: t('notice.enablingCard'), error: message }), {
        duration_ms: Math.round(performance.now() - startedAt),
        error_type: caught instanceof Error ? caught.name : typeof caught,
      }, 'error');
      reportRendererError(t('notice.enablingCard'), caught);
      setError(message);
      presentActivationFailure(caught);
      return false;
    } finally {
      setBusy('');
    }
  }

  async function activateCaptureAndPrompter(
    keepItemId?: string | null,
    targetSessionDir?: string,
  ): Promise<boolean> {
    const ok = await activateCapture(keepItemId, targetSessionDir);
    if (ok) void openPrompterPanel();
    return ok;
  }

  function clearActivationFailure() {
    setActivationFailure(null);
    setActivationFailureOpen(false);
  }

  function returnToSetupFromInspection() {
    unbindTaskLog('return_to_setup');
    setCaptureShareMode(recoveryShareMode);
    setInputSampleFormat(recoverySampleFormat);
    resetForNewSession();
    clearActivationFailure();
    setNotice(t('activationError.editSettingsNotice'));
    logUserAction('ui.edit_capture_settings', '独占开流失败后返回修改采集设置', {
      capture_share_mode: recoveryShareMode,
      input_sample_format: recoverySampleFormat,
    });
  }

  async function recreateFromActivationFailure() {
    const created = await startSession({
      captureShareMode: recoveryShareMode,
      inputSampleFormat: recoverySampleFormat,
      activateAfterCreate: true,
    });
    if (created) {
      clearActivationFailure();
      logUserAction('ui.recreate_capture_settings', '已用新采集设置重新创建任务', {
        capture_share_mode: recoveryShareMode,
        input_sample_format: recoverySampleFormat,
      });
    }
  }

  async function refreshState(): Promise<SessionSnapshot | null> {
    const result = await window.recorder.request<{ snapshot: SessionSnapshot }>('get_state');
    setSnapshot(result.snapshot);
    return result.snapshot;
  }

  async function startAttempt(item = currentItem) {
    if (!item || recording || phase !== 'running' || captureFault || !captureActive) return;
    if (currentNoiseGate !== 'ready') return;
    clearAudioPreview();
    const result = await run(t('notice.starting'), () => window.recorder.request<{
      attempt_id: string;
      start_sample: number;
      recording_started_sample: number;
      head_silence_armed_sample?: number;
      head_silence_passed_sample?: number;
      head_silence_progress_samples?: number;
      required_head_silence_samples?: number;
      head_silence_phase?: HeadSilencePhase;
      content_started_sample?: number;
    }>('start_attempt', { item_id: item.id }));
    if (!result) return;
    takePeakRef.current = 0;
    setReviewPeak(0);
    setRecording(true);
    setAttemptStartSample(result.start_sample);
    setAttemptRecordingStartedSample(result.recording_started_sample);
    setMeter((previous) => ({
      ...previous,
      silence_samples: 0,
      last_signal_sample: 0,
      head_silence_phase: result.head_silence_phase ?? 'waiting_for_head_silence',
      head_silence_armed_sample: result.head_silence_armed_sample ?? result.recording_started_sample,
      head_silence_progress_samples: result.head_silence_progress_samples ?? 0,
      required_head_silence_samples: result.required_head_silence_samples ?? requiredSilenceSamples,
      head_silence_passed_sample: result.head_silence_passed_sample ?? 0,
      content_started_sample: result.content_started_sample ?? 0,
    }));
    setReviewAttemptId(null);
    setNotice(t('notice.startedWait', { id: item.id, seconds: (effectiveSilenceDurationMs / 1_000).toFixed(1) }));
  }

  async function stopAttempt(forceOverride?: boolean): Promise<boolean> {
    if (!recording) return true;
    if (!currentItem) return false;
    const cancelingPendingTake = isPendingTake;
    const force = forceOverride ?? true;
    const result = await run(t('notice.sealingTake'), () => window.recorder.request<{
      item_id: string;
      attempt: Attempt | null;
      discarded?: boolean;
      interrupted?: boolean;
      forced?: boolean;
      auto_selected?: boolean;
      recovered_discontinuity?: boolean;
    }>('stop_attempt', {
      item_id: currentItem.id,
      force,
      discard_empty: automationRules.discardEmpty,
    }));
    if (!result) return false;
    setRecording(false);
    setAttemptRecordingStartedSample(0);
    if (!result.attempt) {
      setReviewAttemptId(null);
      try {
        await refreshState();
      } catch (caught) {
        setError(`${t('notice.sealedRefreshPrefix')}${errorMessage(caught)}`);
        return true;
      }
      if (result.discarded && !result.interrupted) {
        setNotice(cancelingPendingTake ? t('notice.pendingCanceled') : t('notice.noSpeechCanceled'));
        return true;
      }
      setNotice(t('notice.writeFaultNoAudio'));
      return true;
    }
    if (result.interrupted || result.attempt.status === 'interrupted') {
      setReviewAttemptId(null);
      try {
        await refreshState();
      } catch (caught) {
        setError(`${t('notice.interruptedRefreshPrefix')}${errorMessage(caught)}`);
        return true;
      }
      setDataSafetyAlert('音频采集故障已触发保护；当前句已标记为异常中断，不会进入切片导出。');
      setNotice('已封存可恢复的母轨，请结束本次录制并检查原始文件。');
      return true;
    }
    if (result.attempt.status === 'needs_rerecord') {
      setReviewAttemptId(null);
      try {
        await refreshState();
      } catch (caught) {
        setError(`${t('notice.jitterRefreshPrefix')}${errorMessage(caught)}`);
        return true;
      }
      setNotice(t('notice.jitterRetake'));
      return true;
    }
    setReviewPeak(Math.max(takePeakRef.current, result.attempt.peak ?? 0));
    setReviewAttemptId(result.attempt.attempt_id);
    try {
      await refreshState();
    } catch (caught) {
      setError(`${t('notice.sealedRefreshPrefix')}${errorMessage(caught)}`);
      return true;
    }
    setNotice(result.recovered_discontinuity
      ? t('notice.jitterRetake')
      : result.auto_selected
        ? t('notice.retakeSaved')
        : t('notice.takeReady'));
    return true;
  }

  function moveToNext(snapshotValue: SessionSnapshot) {
    const next = findNextActionableItemIndex(snapshotValue.items, currentIndex);
    if (next >= 0) {
      setCurrentIndex(next);
      setNotice(snapshotValue.items[next].status === 'review'
        ? t('notice.savedNeedConfirm')
        : t('notice.savedNext'));
    } else if (areAllItemsHandled(snapshotValue.items)) {
      setCurrentIndex(-1);
      setNotice(t('notice.allProcessedFinish'));
    } else {
      setNotice(t('notice.abnormalCheckList'));
    }
  }

  async function acceptAttempt() {
    // This is deliberately repeated behind the disabled button / shortcut
    // gates: a fault event may arrive after a click was queued but before the
    // handler executes.
    if (captureFault || !currentItem || currentItem.status !== 'review' || recording) return;
    const attemptId = reviewAttemptId
      ?? currentItem.selected_attempt_id
      ?? latestUsableAttempt(currentItem)?.attempt_id;
    if (!attemptId) return;
    const accepted = await run(t('notice.savingAccept'), () => window.recorder.request('accept_attempt', {
      item_id: currentItem.id,
      attempt_id: attemptId,
    }));
    if (!accepted) return;
    const latest = await refreshState();
    setReviewAttemptId(null);
    if (!latest) return;
    const continuation = continuationAfterAccept(latest.items, currentIndex);
    if (continuation.kind === 'start') {
      const nextItem = latest.items[continuation.nextIndex];
      setCurrentIndex(continuation.nextIndex);
      if (shouldAutoStartAfterAccept(continuation, automationRules.autoStartNext)) {
        await startAttempt(nextItem);
      } else {
        setNotice(t('notice.acceptedReady'));
      }
    } else if (continuation.kind === 'review') {
      setCurrentIndex(continuation.nextIndex);
      setNotice(t('notice.acceptedNeedConfirm'));
    } else if (continuation.kind === 'finish') {
      setCurrentIndex(-1);
      setNotice(t('notice.allProcessedFinish'));
    } else {
      setNotice(t('notice.abnormalCheckList'));
    }
  }

  async function skipItem() {
    // Keep a second mutation gate in the handler for stale DOM and queued
    // keyboard events. The engine performs the authoritative final guard.
    if (captureFault || !currentItem || !['pending', 'review'].includes(currentItem.status) || recording) return;
    const skipped = await run(t('notice.savingSkip'), () => window.recorder.request('skip_item', { item_id: currentItem.id }));
    if (!skipped) return;
    const latest = await refreshState();
    setReviewAttemptId(null);
    if (latest) moveToNext(latest);
  }

  function closePreviewPlayer() {
    clearAudioPreview();
  }

  function clearAudioPreview() {
    previewWaveformRequestRef.current += 1;
    setPreviewOpen(false);
    setPreviewBins([]);
    setPreviewingAttemptId('');
    setAudioUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return '';
    });
  }

  async function previewAttempt() {
    if (!currentItem || recording) return;
    const attemptId = reviewAttemptId
      ?? currentItem.selected_attempt_id
      ?? latestUsableAttempt(currentItem)?.attempt_id;
    if (!attemptId) return;
    const command = captureActive ? 'render_attempt' : 'render_session_attempt';
    const waveformCommand = captureActive ? 'preview_attempt_waveform' : 'preview_session_waveform';
    const requestId = previewWaveformRequestRef.current + 1;
    previewWaveformRequestRef.current = requestId;
    const reusedBins = !captureActive && reviewAttempt?.attempt_id === attemptId ? reviewWaveformBins : [];
    const applyPreviewBins = (bins: Array<[number, number]>) => {
      if (requestId !== previewWaveformRequestRef.current) return;
      setPreviewBins(bins);
    };
    const requestPreviewWaveform = () => {
      void window.recorder.request<{ bins: Array<[number, number]> }>(waveformCommand, {
        ...(captureActive ? {} : { session_dir: sessionDir }),
        item_id: currentItem.id,
        attempt_id: attemptId,
      }).then((result) => {
        applyPreviewBins(Array.isArray(result.bins) ? result.bins : []);
      }).catch(() => {
        if (requestId !== previewWaveformRequestRef.current) return;
        if (!reusedBins.length) setPreviewBins([]);
      });
    };
    if (reusedBins.length) applyPreviewBins(reusedBins);
    // Live capture can fetch waveform in parallel. Inspect-mode waveform and
    // render share one exclusive lock, so start render first and only fetch
    // bins after if the review waveform is not already available.
    if (captureActive) requestPreviewWaveform();
    const rendered = await run(t('notice.preparingPreview'), () => window.recorder.request<{ file_path: string }>(command, {
      ...(captureActive ? {} : { session_dir: sessionDir }),
      item_id: currentItem.id,
      attempt_id: attemptId,
    }));
    if (!rendered || requestId !== previewWaveformRequestRef.current) return;
    if (!captureActive && !reusedBins.length) requestPreviewWaveform();
    const audio = await run(t('notice.readingPreview'), () => window.recorder.readAudio(rendered.file_path));
    if (!audio || requestId !== previewWaveformRequestRef.current) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    const url = URL.createObjectURL(new Blob([audio], { type: 'audio/wav' }));
    if (requestId !== previewWaveformRequestRef.current) {
      URL.revokeObjectURL(url);
      return;
    }
    setAudioUrl(url);
    setPreviewingAttemptId(attemptId);
    setPreviewBins((current) => current.length ? current : reusedBins);
    setPreviewOpen(true);
    setNotice(t('notice.previewing', { id: attemptId }));
  }

  async function openHistoricalRecording(
    recording: RecordingHistoryEntry,
    options: { activate?: boolean } = {},
  ) {
    if (recording.is_active) {
      await returnToActiveRecording(recording);
      return;
    }
    const inspected = await run(t('notice.openingTask'), () => window.recorder.request<InspectedSessionState>('inspect_session', {
      session_dir: recording.session_dir,
    }));
    if (!inspected) return;
    enterInspectionWorkspace(inspected);
    if (options.activate) await activateCaptureAndPrompter();
  }

  async function exportRecordingArtifact(
    task: Pick<RecordingHistoryEntry, 'session_id' | 'session_dir'>,
    artifact: ExportArtifact,
  ) {
    const failExport = (error: string) => {
      setExportFeedback({
        sessionId: task.session_id,
        sessionDir: task.session_dir,
        artifact,
        status: 'failed',
        output: artifactLabel(artifact),
        error,
      });
    };
    setUserAlert(null);
    setExportFeedback({
      sessionId: task.session_id,
      sessionDir: task.session_dir,
      artifact,
      status: 'working',
      output: artifactLabel(artifact),
    });
    if (captureActive && snapshot && sessionDir === task.session_dir) {
      if (recording && !(await stopAttempt(true))) {
        failExport(lastOperationErrorRef.current || t('exportDialog.resultPauseFailed'));
        return;
      }
      const stopped = await stopSessionWithReconciliation(t('notice.pausingToExport'), snapshot.session_id, sessionDir);
      if (!stopped) {
        failExport(lastOperationErrorRef.current || t('exportDialog.resultPauseFailed'));
        return;
      }
      enterInspectionWorkspace({ snapshot: stopped.snapshot, session_dir: task.session_dir, mode: 'inspect' });
    }
    const exported = await run(t('notice.exportingFiles'), () => window.recorder.request<ExportResult>('export_session_artifact', {
      session_dir: task.session_dir,
      artifact,
    }));
    if (!exported) {
      failExport(lastOperationErrorRef.current || t('exportDialog.resultFailedGeneric'));
      return;
    }
    const sourceFile = artifactFilePath(artifact, exported);
    let deliveredDir = exported.export_dir;
    let deliveredFile = sourceFile;
    let copyWarning = '';
    const destination = exportDestination || exported.export_dir;
    if (sourceFile && destination) {
      const delivered = await run(t('notice.copyingExport'), () => (
        window.recorder.deliverExportArtifact(sourceFile, destination)
      ));
      if (!delivered) {
        copyWarning = translateExportDeliverError(lastOperationErrorRef.current || t('exportDialog.copyFailed'));
      } else {
        deliveredDir = delivered.directory;
        deliveredFile = delivered.file_path;
      }
    }
    const warning = recoveryWarning(t('notice.exportStorage'), exported.recovery_warnings);
    if (warning) setDataSafetyAlert(t('notice.exportSpotCheck', { warning }));
    const output = artifactOutputCopy(artifact, exported);
    setNotice(t('notice.exported', {
      id: task.session_id,
      output,
      note: warning || copyWarning ? t('notice.exportNeedCheck') : '',
    }));
    const dialogWarning = [
      warning ? `${t('exportDialog.spotCheck')}\n${warning}` : '',
      copyWarning,
    ].filter(Boolean).join('\n');
    setExportFeedback({
      sessionId: task.session_id,
      sessionDir: task.session_dir,
      artifact,
      status: 'ok',
      output,
      exportDir: deliveredDir,
      filePath: deliveredFile,
      warning: dialogWarning || undefined,
    });
    await refreshRecordings();
  }

  function commitExportDestination(value: string) {
    setExportDestination(value);
    persistExportDestination(value);
  }

  async function chooseExportDestination(defaultPath?: string) {
    let selected: string | null;
    try {
      selected = await window.recorder.chooseExportDir(
        defaultPath || taskExportDir || undefined,
        t('exportDialog.chooseFolderTitle'),
      );
    } catch (caught) {
      showBlockingError(translateExportDeliverError(errorMessage(caught)));
      return;
    }
    if (!selected) return;
    commitExportDestination(selected);
  }

  async function openExportFeedbackFolder() {
    if (!exportFeedback) return;
    const target = exportFeedback.exportDir
      || await window.recorder.joinPath(exportFeedback.sessionDir, 'export');
    const opened = await run(t('notice.openingExport'), async () => {
      await window.recorder.openPath(target);
      return true;
    });
    if (opened) {
      setNotice(t('notice.openedExport', { id: exportFeedback.sessionId }));
      return;
    }
    showBlockingError(translateExportDeliverError(lastOperationErrorRef.current || t('notice.openingExport')));
  }

  function showExport(recording: RecordingHistoryEntry) {
    setExportRecording(recording);
  }

  function showTaskDetails(recording: RecordingHistoryEntry) {
    setOpenActionsSessionDir('');
    void openHistoricalRecording(recording);
  }

  async function sealHistoricalRecording(recording: RecordingHistoryEntry) {
    if (sealOperationRef.current) return;
    sealOperationRef.current = true;
    setSealingSessionDir(recording.session_dir);
    setBusy(t('notice.sealingTask'));
    setError('');
    setDataSafetyAlert('');
    let sealed: SealInterruptedSessionResult;
    try {
      sealed = await window.recorder.request<SealInterruptedSessionResult>(
        'seal_interrupted_session',
        { session_dir: recording.session_dir, session_id: recording.session_id },
      );
    } catch (caught) {
      const message = `${t('notice.sealFailedPrefix', { id: recording.session_id })}${errorMessage(caught)}`;
      showBlockingError(message);
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
    const warning = recoveryWarning(t('notice.sealStorage'), sealed.warnings);
    const durableDuration = formatDuration(sealed.durable_frames, recording.sample_rate);
    if (sealed.fault_preserved || sealed.snapshot.status === 'faulted') {
      raiseDataSafetyAlert(
        t('notice.sealedFaulted', { duration: durableDuration }),
      );
      return;
    }
    if (warning) raiseDataSafetyAlert(t('notice.sealedSpotCheck', { warning }));
    const recovered = sealed.recovered_attempts
      ? t('notice.recoveredTakes', { count: sealed.recovered_attempts })
      : '';
    const canExportNow = recording.pending_items + recording.review_items === 0;
    const scope = canExportNow ? t('notice.exportAll') : t('notice.exportExisting');
    setNotice(sealed.no_op
      ? t('notice.alreadySafe', { id: recording.session_id, scope })
      : t('notice.sealedNow', { id: recording.session_id, duration: durableDuration, recovered, scope }));
  }

  async function returnToActiveRecording(recording: RecordingHistoryEntry) {
    const current = await run(t('notice.returningCurrent'), () => window.recorder.request<RunningSessionState>('get_state'));
    if (!current) return;
    if (current.snapshot.session_id !== recording.session_id
      || !current.session_dir
      || current.session_dir !== recording.session_dir) {
      showBlockingError(t('notice.sessionMismatch'));
      await refreshRecordings();
      return;
    }
    if (current.snapshot.status !== 'recording') {
      showBlockingError(t('notice.stillSealingEnter'));
      await refreshRecordings();
      return;
    }
    enterRunningSession(current, false);
  }

  async function continuePendingStop(recording: RecordingHistoryEntry) {
    const stopped = await run(t('notice.continuingSeal'), () => (
      window.recorder.request<StoppedSessionState>('stop_session', {
        expected_session_id: recording.session_id,
        expected_session_dir: recording.session_dir,
      })
    ));
    await refreshRecordings();
    if (!stopped) return;
    setEngineStatus('ready');
    setNotice(t('notice.finishedSeal', { id: recording.session_id }));
  }

  async function openRecordingExport(recording: RecordingHistoryEntry) {
    const target = await window.recorder.joinPath(recording.session_dir, 'export');
    const opened = await run(t('notice.openingExport'), async () => {
      await window.recorder.openPath(target);
      return true;
    });
    if (opened) setNotice(t('notice.openedExport', { id: recording.session_id }));
  }

  async function openRecordingDirectory(recording: RecordingHistoryEntry) {
    const opened = await run(t('notice.openingDir'), async () => {
      await window.recorder.openPath(recording.session_dir);
      return true;
    });
    if (opened) setNotice(t('notice.openedDir', { id: recording.session_id }));
  }

  function finishSession() {
    if (!sessionDir) return;
    if (!captureActive) {
      leaveInspectionWorkspace();
      return;
    }
    const dialog = captureExitDialog(recording, captureFault, exitAction);
    if (dialog === 'finish') {
      setPauseConfirmOpen(false);
      setFinishConfirmOpen(true);
    } else {
      // This entry point must stay usable during a take. The confirmation
      // flow closes/cancels the active sentence first and only returns to the
      // task list after stop_session has durably sealed the continuous track.
      setPauseConfirmOpen(true);
    }
  }

  function requestSafePause() {
    if (phase !== 'running' || busy || !sessionDir) return;
    if (!captureActive) {
      leaveInspectionWorkspace();
      return;
    }
    if (captureFault) {
      setPauseConfirmOpen(false);
      setFinishConfirmOpen(true);
    } else {
      setPauseConfirmOpen(true);
    }
  }

  function leaveInspectionWorkspace() {
    clearAudioPreview();
    setPhase('home');
    setSnapshot(null);
    setSessionDir('');
    setCaptureActive(false);
    setWorkspaceFaulted(false);
    setMonitorPanelTab('monitor');
    setRecording(false);
    setCurrentIndex(0);
    setReviewAttemptId(null);
    setMeter(emptyMeter);
    clearSessionNoiseCheck();
    clearActivationFailure();
    setNotice(t('notice.leftTask'));
    unbindTaskLog('leave_inspection');
    logUserAction('ui.leave_task', '已退出任务检查工作区');
    void refreshRecordings();
  }

  async function stopSessionWithReconciliation(
    label: string,
    expectedSessionId: string,
    expectedSessionDir: string,
  ): Promise<StoppedSessionState | null> {
    setBusy(label);
    setError('');
    try {
      return await window.recorder.request<StoppedSessionState>('stop_session', {
        expected_session_id: expectedSessionId,
        expected_session_dir: expectedSessionDir,
      });
    } catch (caught) {
      const stopError = errorMessage(caught);
      lastOperationErrorRef.current = stopError;
      setError(stopError);
      if (!isReconciliableInactiveStopError(stopError)) return null;

      // Only a narrow terminal-stop error is eligible, and the independent
      // optional-state query must still prove there is no live session. This
      // does not claim the metadata is sealed: it deliberately returns a
      // faulted result which routes the task to offline repair/seal.
      try {
        const current = await queryRunningSession();
        if (current.active || !snapshot) return null;
        setEngineStatus('ready');
        setError('');
        return {
          session_dir: sessionDir,
          snapshot: {
            ...snapshot,
            status: 'faulted',
            captured_samples: Math.max(snapshot.captured_samples, meter.captured_samples),
            committed_samples: Math.max(snapshot.committed_samples, meter.committed_samples),
            overflow_samples: Math.max(snapshot.overflow_samples, meter.overflow_samples),
            updated_at: new Date().toISOString(),
          },
          warnings: ['已确认录音引擎不再采集，但最终元数据未证明完整封存；请从任务列表执行“检查并修复”。'],
          reconciled_inactive_after_error: true,
        };
      } catch (reconciliationError) {
        const message = `${stopError}；且无法确认录音引擎已停止：${errorMessage(reconciliationError)}`;
        lastOperationErrorRef.current = message;
        setError(message);
        return null;
      }
    } finally {
      setBusy('');
    }
  }

  async function safeStopAndReturn(mode: CaptureExitMode) {
    if (pauseOperationRef.current || phase !== 'running' || !sessionDir || !snapshot) return;
    pauseOperationRef.current = true;
    setPauseConfirmOpen(false);
    setFinishConfirmOpen(false);
    const faultAtRequest = mode === 'fault' || captureFault;
    try {
      const stopped = await executeSafePause<StoppedSessionState>({
        // A capture fault seals an active take as interrupted inside
        // stop_session. Do not issue a forbidden attempt mutation first.
        hasActiveAttempt: recording && !faultAtRequest,
        closeActiveAttempt: () => stopAttempt(true),
        stopSession: () => stopSessionWithReconciliation(
          mode === 'pause' ? t('notice.pauseSealing') : t('notice.finishSealing'),
          snapshot.session_id,
          sessionDir,
        ),
        closePrompter: () => window.recorder.closePrompter(),
      });
      if (!stopped) return;

      const stoppedWithFault = faultAtRequest
        || stopped.reconciled_inactive_after_error
        || stopped.snapshot.status === 'faulted'
        || stopped.snapshot.overflow_samples > 0;
      const warning = recoveryWarning(mode === 'pause' ? t('notice.pauseWarning') : t('notice.finishWarning'), stopped.warnings);
      clearAudioPreview();
      meterFrameCommitterRef.current?.invalidate();
      setResumeError(null);
      setSealConfirmRecording(null);
      setPhase('home');
      clearSessionNoiseCheck();
      setSnapshot(null);
      setSessionDir('');
      setCaptureActive(false);
      setWorkspaceFaulted(false);
      setRecording(false);
      setAttemptStartSample(0);
      setAttemptRecordingStartedSample(0);
      setReviewAttemptId(null);
      setMeter(emptyMeter);
      setFinishConfirmOpen(false);
      setPauseConfirmOpen(false);
      unbindTaskLog(mode);
      logUserAction('ui.safe_stop', mode === 'pause' ? '已安全暂停并返回任务列表' : '已安全结束并返回任务列表', {
        mode,
        fault: Boolean(stoppedWithFault),
        reconciled: Boolean(stopped.reconciled_inactive_after_error),
      });
      if (stopped.reconciled_inactive_after_error) {
        raiseDataSafetyAlert('已确认录音引擎不再采集，但本任务尚未安全收尾；请立即执行“检查并修复”，再继续录制或导出。');
        setNotice('已返回任务列表，当前任务需要修复。');
      } else if (stoppedWithFault) {
        raiseDataSafetyAlert('采集故障已结束：原始母轨和故障证据已保留，请在任务列表先执行“检查并修复”。');
        setNotice('故障任务已返回列表，已落盘母轨仍保留。');
      } else if (mode === 'pause') {
        if (warning) raiseDataSafetyAlert(`${warning}。已落盘母音频仍已封存，继续前请抽检。`);
        else setDataSafetyAlert('');
        setNotice(t('notice.pausedSafe'));
      } else {
        if (warning) raiseDataSafetyAlert(`${warning}。原始母轨已封存，请抽检。`);
        else setDataSafetyAlert('');
        setNotice(t('notice.captureFinished'));
      }
      await refreshRecordings();
    } catch (caught) {
      showBlockingError(t('notice.stayRetry', { error: `${t('notice.stopFailedPrefix')}${errorMessage(caught)}` }));
    } finally {
      pauseOperationRef.current = false;
    }
  }

  async function safePauseAndReturn() {
    await safeStopAndReturn(captureFault ? 'fault' : 'pause');
  }

  async function confirmFinishSession() {
    if ((recording && !captureFault) || !sessionDir) return;
    await safeStopAndReturn(captureFault ? 'fault' : 'finish');
  }

  function resetForNewSession() {
    clearAudioPreview();
    meterFrameCommitterRef.current?.invalidate();
    setResumeError(null);
    setSealConfirmRecording(null);
    setDeleteConfirmRecording(null);
    setOpenActionsSessionDir('');
    setPhase('setup');
    clearSessionNoiseCheck();
    setSnapshot(null);
    setSessionDir('');
    setCaptureActive(false);
    setWorkspaceFaulted(false);
    setRecording(false);
    setAttemptStartSample(0);
    setAttemptRecordingStartedSample(0);
    setReviewAttemptId(null);
    setMeter(emptyMeter);
    setFinishConfirmOpen(false);
    setPauseConfirmOpen(false);
    clearActivationFailure();
    setNotice(t('notice.reuseScript'));
  }

  function beginNewRecording() {
    resetForNewSession();
    setCaptureShareMode('shared');
    setInputSampleFormat('i16');
    if (selectedCapturePreset) applyCapturePreset(selectedCapturePreset);
    setScriptFile('');
    setScriptItems([]);
    setScriptErrors([]);
    setSessionName(t('setup.newSessionName'));
    logUserAction('ui.new_recording', '开始新建录制');
    setNotice(t('notice.pickScriptToStart'));
  }

  function returnToRecordings() {
    clearAudioPreview();
    meterFrameCommitterRef.current?.invalidate();
    setResumeError(null);
    setSealConfirmRecording(null);
    setDeleteConfirmRecording(null);
    setOpenActionsSessionDir('');
    clearActivationFailure();
    setPhase('home');
    clearSessionNoiseCheck();
    setSnapshot(null);
    setSessionDir('');
    setRecording(false);
    setAttemptStartSample(0);
    setAttemptRecordingStartedSample(0);
    setReviewAttemptId(null);
    setMeter(emptyMeter);
    setFinishConfirmOpen(false);
    setPauseConfirmOpen(false);
    setNotice(t('notice.historyRefreshed'));
    unbindTaskLog('return_home');
    logUserAction('ui.return_home', '已返回任务列表');
    void refreshRecordings();
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (logPanelOpen) {
        if (event.key === 'Escape') setLogPanelOpen(false);
        return;
      }
      if (settingsOpen) {
        if (event.key === 'Escape') setSettingsOpen(false);
        return;
      }
      if (resetConfirmRecording) {
        if (event.key === 'Escape' && !resettingSessionDir) setResetConfirmRecording(null);
        return;
      }
      if (deleteConfirmRecording) {
        if (event.key === 'Escape' && !deletingSessionDir) setDeleteConfirmRecording(null);
        return;
      }
      if (sealConfirmRecording) {
        if (event.key === 'Escape' && !sealingSessionDir) setSealConfirmRecording(null);
        return;
      }
      if (finishConfirmOpen) {
        if (event.key === 'Escape') setFinishConfirmOpen(false);
        return;
      }
      if (pauseConfirmOpen) {
        if (event.key === 'Escape' && !pauseOperationRef.current) setPauseConfirmOpen(false);
        return;
      }
      if (openActionsSessionDir && event.key === 'Escape') {
        setOpenActionsSessionDir('');
        return;
      }
      if (previewOpen) {
        const previewAction = previewShortcutAction(event.code, event.key);
        if (previewAction === 'close') {
          event.preventDefault();
          closePreviewPlayer();
          return;
        }
        if (previewAction === 'confirm') {
          event.preventDefault();
          closePreviewPlayer();
          if (captureActive && !captureFault && !recording) {
            const action = workflowShortcutAction('Space', ' ', primaryAction, Boolean(currentItem));
            if (action === 'finish') finishSession();
            else if (action === 'accept') void acceptAttempt();
            else if (action === 'start') void startAttempt();
          }
          return;
        }
        if (previewAction === 'pause') {
          event.preventDefault();
          previewPlayerRef.current?.toggle();
          return;
        }
        if (previewAction === 'nudge-left') {
          event.preventDefault();
          previewPlayerRef.current?.nudge(-1);
          return;
        }
        if (previewAction === 'nudge-right') {
          event.preventDefault();
          previewPlayerRef.current?.nudge(1);
          return;
        }
        return;
      }
      if (phase !== 'running' || busy) return;
      if (captureActive && !captureFault && !showNoiseCheckDialog && event.key === 'Escape' && recording && isPendingTake) {
        event.preventDefault();
        void stopAttempt();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, button, audio')) return;
      if (!captureActive) {
        const viewAction = viewShortcutAction(event.code, event.key);
        if (viewAction === 'preview') {
          event.preventDefault();
          void previewAttempt();
        } else if (viewAction === 'enter-capture' && !workspaceFaulted) {
          event.preventDefault();
          void activateCaptureAndPrompter(currentItem?.id);
        } else if (event.key === 'ArrowLeft') {
          setCurrentIndex((index) => Math.max(0, index - 1));
          setReviewAttemptId(null);
        } else if (event.key === 'ArrowRight') {
          setCurrentIndex((index) => Math.min(items.length - 1, index + 1));
          setReviewAttemptId(null);
        }
        return;
      }
      if (captureFault) {
        // During a live fault every recording shortcut is captured by the
        // stop-reading state. Space opens the sole safe action; navigation,
        // retake, preview, accept and skip do nothing.
        if (event.code === 'Space') {
          event.preventDefault();
          finishSession();
        }
        return;
      }
      if (showNoiseCheckDialog) {
        if (event.code === 'Space' && !noiseCheckRunning && snapshot) {
          event.preventDefault();
          void runSessionNoiseCheck(sessionDir, snapshot);
        }
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        if (recording) void stopAttempt();
        else {
          const action = workflowShortcutAction(event.code, event.key, primaryAction, Boolean(currentItem));
          if (action === 'finish') finishSession();
          else if (action === 'accept') void acceptAttempt();
          else if (action === 'start') void startAttempt();
        }
      } else if (!recording && workflowShortcutAction(event.code, event.key, primaryAction, Boolean(currentItem)) === 'retake') {
        void startAttempt();
      } else if (event.key.toLowerCase() === 'p' && !recording) {
        void previewAttempt();
      } else if (event.key.toLowerCase() === 's' && !recording && captureActive) {
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

  useEffect(() => {
    if (!openActionsSessionDir) return undefined;
    function closeActionsMenu(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.home-actions-menu-wrap')) setOpenActionsSessionDir('');
    }
    window.addEventListener('pointerdown', closeActionsMenu);
    return () => window.removeEventListener('pointerdown', closeActionsMenu);
  }, [openActionsSessionDir]);

  useEffect(() => {
    if (captureActive || !reviewAttempt || !sessionDir || !currentItem) {
      setReviewWaveformBins([]);
      return undefined;
    }
    const requestId = reviewWaveformRequestRef.current + 1;
    reviewWaveformRequestRef.current = requestId;
    void window.recorder.request<{ bins: Array<[number, number]> }>('preview_session_waveform', {
      session_dir: sessionDir,
      item_id: currentItem.id,
      attempt_id: reviewAttempt.attempt_id,
    }).then((result) => {
      if (requestId !== reviewWaveformRequestRef.current) return;
      setReviewWaveformBins(Array.isArray(result.bins) ? result.bins : []);
    }).catch(() => {
      if (requestId !== reviewWaveformRequestRef.current) return;
      setReviewWaveformBins([]);
    });
    return () => {
      if (reviewWaveformRequestRef.current === requestId) reviewWaveformRequestRef.current += 1;
    };
  }, [captureActive, sessionDir, currentItem?.id, reviewAttempt?.attempt_id]);

  const settingsDialog = settingsOpen && <div className="dialog-backdrop" role="presentation">
    <section className="studio-dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">
      <header><span className="dialog-icon"><Icon name="settings" size={19} /></span><div><h2 id="settings-dialog-title">{t('settings.title')}</h2></div></header>
      <div className="settings-content">
        <section>
          <div><strong>{t('settings.language')}</strong><small>{t('settings.languageHint')}</small></div>
          <select
            className="settings-locale"
            data-testid="app-locale"
            aria-label={t('settings.language')}
            value={locale}
            onChange={(event) => void setLocale(event.target.value as typeof locale)}
          >
            {APP_LOCALES.map((code) => (
              <option key={code} value={code}>{LOCALE_NATIVE_NAMES[code]}</option>
            ))}
          </select>
        </section>
        <section>
          <div><strong>{t('settings.outputTitle')}</strong><small>{t('settings.outputHint')}</small></div>
          <code title={outputDir}>{outputDir || t('settings.outputUnset')}</code>
          <button className="button" onClick={() => void chooseOutput()} disabled={Boolean(busy) || phase === 'running'}><Icon name="folder" size={14} />{t('settings.changeLocation')}</button>
          {phase === 'running' && <p>{t('settings.outputLocked')}</p>}
        </section>
        <section>
          <div><strong>{t('settings.engineTitle')}</strong><small>{t('settings.engineHint')}</small></div>
          <span className={`settings-engine ${engineStatus}`}><i />{engineStatus === 'ready' ? t('settings.engineReady') : engineStatus === 'connecting' ? t('settings.engineConnecting') : t('settings.engineOffline')}</span>
        </section>
        <section>
          <div><strong>{t('settings.logsTitle')}</strong><small>{t('settings.logsHint')}</small></div>
          <button
            data-testid="open-debug-log"
            className="button"
            onClick={() => {
              logUserAction('ui.open_log_panel', '打开运行日志面板');
              setLogPanelOpen(true);
            }}
          >
            <Icon name="log" size={14} />{t('settings.viewLogs')}
          </button>
        </section>
        {license && <section className="settings-license">
          <div>
            <strong>{t('settings.licenseTitle')}</strong>
            <small>{t('settings.licenseHint')}</small>
          </div>
          <span className="settings-engine ready" data-testid="settings-license-status">
            <i />
            {license.licensee ? `${t('settings.licenseValid')} · ${license.licensee}` : t('settings.licenseValid')}
          </span>
          <code title={license.machineCode}>{licenseSummary(license)} · {license.machineCode || t('license.machineUnavailable')}</code>
        </section>}
      </div>
      <footer><button className="button primary" onClick={() => setSettingsOpen(false)}>{t('common.done')}</button></footer>
    </section>
  </div>;

  const shownExportDestination = exportDestination || taskExportDir;
  const exportDestinationPicker = (defaultPath?: string) => <div className="export-destination-block">
    <div className="export-destination">
      <span>{t('exportDialog.destination')}</span>
      <code title={shownExportDestination}>{shownExportDestination || t('common.dash')}</code>
      <div className="export-destination-actions">
        <button type="button" className="button" data-testid="choose-export-dir" onClick={() => void chooseExportDestination(shownExportDestination || defaultPath)} disabled={Boolean(busy)}>{t('exportDialog.changeDestination')}</button>
        {exportDestination ? <button type="button" className="button" data-testid="reset-export-dir" onClick={() => commitExportDestination('')} disabled={Boolean(busy)}>{t('exportDialog.useTaskFolder')}</button> : null}
      </div>
    </div>
    <p className="export-destination-hint">{t('exportDialog.destinationHint')}</p>
  </div>;

  const exportFeedbackDialog = exportFeedback && <div className="dialog-backdrop export-feedback-backdrop" role="presentation">
    <section className="studio-dialog export-result-dialog" role="dialog" aria-modal="true" aria-labelledby="export-result-title" data-testid="export-result-dialog">
      <header>
        <span className={`dialog-icon ${exportFeedback.status === 'failed' ? 'danger' : exportFeedback.status === 'ok' && exportFeedback.warning ? 'warning' : exportFeedback.status === 'ok' ? 'success' : ''}`}>
          <Icon name={exportFeedback.status === 'failed' ? 'stop' : exportFeedback.status === 'ok' ? 'check' : 'export'} size={19} />
        </span>
        <div>
          <h2 id="export-result-title">
            {exportFeedback.status === 'working'
              ? t('exportDialog.resultWorkingTitle')
              : exportFeedback.status === 'failed'
                ? t('exportDialog.resultFailedTitle')
                : t('exportDialog.resultOkTitle')}
          </h2>
        </div>
      </header>
      <p>
        {exportFeedback.status === 'working'
          ? t('exportDialog.resultWorkingBody', { output: exportFeedback.output })
          : exportFeedback.status === 'failed'
            ? t('exportDialog.resultFailedBody', { id: exportFeedback.sessionId, output: exportFeedback.output })
            : t('exportDialog.resultOkBody', { id: exportFeedback.sessionId, output: exportFeedback.output })}
      </p>
      {exportFeedback.status === 'failed' && exportFeedback.error && <div className="dialog-warning danger">{exportFeedback.error}</div>}
      {exportFeedback.status === 'ok' && exportFeedback.warning && <div className="dialog-warning">{exportFeedback.warning}</div>}
      {exportFeedback.status === 'ok' && (exportFeedback.filePath || exportFeedback.exportDir) && <div className="export-result-meta">
        {exportFeedback.filePath && <div><span>{t('exportDialog.resultFile')}</span><code title={exportFeedback.filePath}>{exportFeedback.filePath}</code></div>}
        {exportFeedback.exportDir && <div><span>{t('exportDialog.resultPath')}</span><code title={exportFeedback.exportDir}>{exportFeedback.exportDir}</code></div>}
      </div>}
      <footer>
        {exportFeedback.status === 'ok' && <button data-testid="export-result-open-folder" className="button" onClick={() => void openExportFeedbackFolder()} disabled={Boolean(busy)}>{t('exportDialog.openFolder')}</button>}
        <button data-testid="export-result-close" className="button primary" onClick={() => setExportFeedback(null)} disabled={exportFeedback.status === 'working'}>
          {exportFeedback.status === 'working' ? t('common.loading') : t('common.done')}
        </button>
      </footer>
    </section>
  </div>;

  const userAlertDialog = userAlert && <div className="dialog-backdrop user-alert-backdrop" role="presentation">
    <section className="studio-dialog user-alert-dialog" role="dialog" aria-modal="true" aria-labelledby="user-alert-title" data-testid="user-alert-dialog">
      <header>
        <span className={`dialog-icon ${userAlert.kind === 'error' ? 'danger' : 'warning'}`}>
          <Icon name={userAlert.kind === 'error' ? 'stop' : 'meter'} size={19} />
        </span>
        <div>
          <h2 id="user-alert-title">{userAlert.title}</h2>
        </div>
      </header>
      <p>{userAlert.body}</p>
      <footer>
        <button data-testid="user-alert-close" className="button primary" onClick={() => setUserAlert(null)}>{t('common.close')}</button>
      </footer>
    </section>
  </div>;

  const activationCopy = activationFailure ? activationErrorCopy(activationFailure.kind) : null;
  const activationFailureDialog = activationFailureOpen && activationFailure && activationCopy && <div className="dialog-backdrop user-alert-backdrop" role="presentation">
    <section className="studio-dialog activation-failure-dialog" role="dialog" aria-modal="true" aria-labelledby="activation-failure-title" data-testid="activation-failure-dialog">
      <header>
        <span className="dialog-icon danger"><Icon name="stop" size={19} /></span>
        <div>
          <h2 id="activation-failure-title">{activationCopy.title}</h2>
        </div>
      </header>
      <p>{activationCopy.body}</p>
      <dl className="dialog-summary activation-failure-summary">
        <div><dt>{t('setup.inputDevice')}</dt><dd title={deviceName}>{deviceName || t('common.dash')}</dd></div>
        <div><dt>{t('setup.sampleRate')}</dt><dd>{sampleRate.toLocaleString(locale)} Hz</dd></div>
        <div><dt>{t('setup.inputChannel')}</dt><dd>{inputChannel}</dd></div>
      </dl>
      <div className="activation-failure-settings">
        <p>{t('activationError.changeHint')}</p>
        {exclusiveCaptureAvailable && <label className="field"><span>{t('setup.shareMode')}</span><select data-testid="activation-recovery-share-mode" value={recoveryShareMode} onChange={(event) => {
          const next = normalizeCaptureShareMode(event.target.value);
          setRecoveryShareMode(next);
          const formats = captureSampleFormatsForConfiguration(
            configurationsForShareMode(selectedDevice, next),
            sampleRate,
            inputChannel,
          );
          if (!formats.some((format) => format === recoverySampleFormat)) {
            setRecoverySampleFormat(preferredCaptureSampleFormat(formats) ?? recoverySampleFormat);
          }
        }}><option value="shared">{t('setup.sharedRecommended')}</option><option value="exclusive">{t('setup.exclusive')}</option></select></label>}
        <label className="field"><span>{t('setup.bitDepth')}</span><select data-testid="activation-recovery-format" value={recoverySampleFormat} onChange={(event) => setRecoverySampleFormat(event.target.value)}>{!recoveryFormatOptions.some((format) => format === recoverySampleFormat) && <option value={recoverySampleFormat}>{captureSampleFormatLabel(recoverySampleFormat)}</option>}{(recoveryFormatOptions.length ? recoveryFormatOptions : [recoverySampleFormat]).map((format) => <option value={format} key={format}>{captureSampleFormatLabel(format)}</option>)}</select></label>
      </div>
      <details className="activation-failure-detail">
        <summary>{t('activationError.detail')}</summary>
        <p>{activationFailure.message}</p>
      </details>
      <footer>
        <button className="button" onClick={() => setActivationFailureOpen(false)} disabled={Boolean(busy)}>{t('common.close')}</button>
        <button data-testid="activation-back-to-setup" className="button" onClick={returnToSetupFromInspection} disabled={Boolean(busy)}>{t('activationError.backToSetup')}</button>
        <button data-testid="activation-recreate" className="button primary" onClick={() => void recreateFromActivationFailure()} disabled={Boolean(busy)}>{t('activationError.recreateAndEnter')}</button>
      </footer>
    </section>
  </div>;

  if (phase === 'home') {
    const filters: Array<{ id: HistoryFilter; label: string }> = [
      { id: 'all', label: t('home.filterAll') },
      { id: 'completed', label: t('home.filterCompleted') },
      { id: 'unfinished', label: t('home.filterUnfinished') },
    ];
    return <div className="home-shell">
      <HomeHeader preview={isBrowserPreview} onOpenSettings={() => setSettingsOpen(true)} />
      <main id="main" className="home-main" data-testid="recordings-workspace">
        <header className="home-titlebar">
          <div><h1>{t('home.title')}</h1><p>{isBrowserPreview ? t('home.subtitlePreview') : t('home.subtitle')}</p></div>
          <button data-testid="new-recording" className="home-primary" onClick={beginNewRecording} disabled={Boolean(busy)}><Icon name="plus" size={16} />{t('home.newRecording')}</button>
        </header>

        <section className="home-controls" aria-label={t('home.filtersAria')}>
          <nav className="home-filters" aria-label={t('home.statusFilterAria')}>
            {filters.map((filter) => <button key={filter.id} className={historyFilter === filter.id ? 'active' : ''} onClick={() => setHistoryFilter(filter.id)}>
              <span>{filter.label}</span><em>{recordings.filter((recording) => recordingMatchesFilter(recording, filter.id)).length}</em>
            </button>)}
          </nav>
          <div className="home-storage"><Icon name="folder" size={14} /><span>{t('home.saveTo')}</span><code title={outputDir}>{outputDir || (historyLoading ? t('home.readingDefaultLocation') : t('home.locationUnset'))}</code><button onClick={() => void chooseOutput()} disabled={Boolean(busy)}>{t('common.change')}</button><button title={t('home.refreshTasks')} aria-label={t('home.refreshTasks')} onClick={() => void refreshRecordings()} disabled={Boolean(busy) || !outputDir}><Icon name="refresh" size={14} /></button></div>
        </section>

        <section className="home-list" aria-label={t('home.listAria')}>
          <div className="home-list-header"><span>{t('home.colTask')}</span><span>{t('home.colProgress')}</span><span>{t('home.colUpdated')}</span><span>{t('home.colStatus')}</span><span className="home-actions-heading">{t('home.colActions')}</span></div>
          {historyLoading && <div className="home-loading" aria-busy="true" aria-live="polite"><strong className="home-loading-label">{t('home.readingTasks')}</strong><i className="home-skeleton-row" /><i className="home-skeleton-row" /><i className="home-skeleton-row" /></div>}
          {!historyLoading && !filteredRecordings.length && <div className="home-empty"><span className="home-empty-icon"><Icon name="microphone" size={24} /></span><strong>{recordings.length ? t('home.emptyFilteredTitle') : t('home.emptyTitle')}</strong><p>{recordings.length ? t('home.emptyFilteredBody') : t('home.emptyBody')}</p>{!recordings.length && <button className="home-primary" onClick={beginNewRecording} disabled={Boolean(busy)}><Icon name="plus" size={15} />{t('home.newRecording')}</button>}</div>}
          {!historyLoading && filteredRecordings.map((recording) => {
            const state = recordingState(recording);
            const handled = recording.accepted_items + recording.skipped_items;
            const progress = recording.total_items ? handled / recording.total_items * 100 : 0;
            const isSealing = sealingSessionDir === recording.session_dir;
            const isDeleting = deletingSessionDir === recording.session_dir;
            const isResetting = resettingSessionDir === recording.session_dir;
            const actionsOpen = openActionsSessionDir === recording.session_dir;
            const rowResumeError = resumeError?.sessionDir === recording.session_dir ? resumeError.message : '';
            const recoveryPlan = planHistoryRecovery(recording);
            const listEntry = planTaskListEntry(recording);
            const recordDisabledReason = listRecordDisabledReason(listEntry);
            const recordDisabledCopy = recordDisabledReason === 'fault'
              ? t('home.recordDisabledFault')
              : recordDisabledReason === 'issue'
                ? t('home.recordDisabledIssue')
                : recordDisabledReason === 'readonly'
                  ? t('home.recordDisabledReadonly')
                  : undefined;
            return <article key={recording.session_dir} className={`home-recording-row ${rowResumeError ? 'has-error' : ''} ${actionsOpen ? 'menu-open' : ''}`}>
              <button className="home-recording-name" onClick={() => showTaskDetails(recording)} aria-label={t('home.openTaskAria', { id: recording.session_id })}><i className={`recording-dot ${state.kind}`} /><div><strong>{recording.session_id}</strong><small title={recording.history_issue}>{recording.history_issue || <>{recording.script_name || t('home.unknownSource')} · {recording.sample_rate ? `${recording.sample_rate.toLocaleString(locale)} Hz / ${recording.bit_depth}-bit` : t('home.unknownFormat')}</>}</small></div></button>
              <div className="home-recording-progress"><span><b>{handled}</b><small> / {recording.total_items}</small></span><i><em style={{ width: `${progress}%` }} /></i></div>
              <time>{formatDateTime(recording.updated_at)}</time>
              <span><em className={`recording-status ${state.kind}`}>{state.label}</em></span>
              <div className="home-row-actions">
                {listEntry.kind === 'continue-stop'
                  ? <button className="row-primary" onClick={() => void continuePendingStop(recording)} disabled={Boolean(busy)}>{t('home.continueSafeStop')}</button>
                  : listEntry.kind === 'return'
                    ? <button className="row-primary" onClick={() => void returnToActiveRecording(recording)} disabled={Boolean(busy)}>{t('home.returnToRecording')}</button>
                    : <>
                      <button data-testid="view-recording" className={listViewIsPrimary(listEntry) ? 'row-primary' : 'row-secondary'} onClick={() => showTaskDetails(recording)} disabled={Boolean(busy)} aria-label={t('home.viewTaskAria', { id: recording.session_id })}>{t('home.viewTask')}</button>
                      <button data-testid="record-recording" className={listRecordEnabled(listEntry) && !listViewIsPrimary(listEntry) ? 'row-primary' : 'row-secondary'} onClick={() => void openHistoricalRecording(recording, { activate: true })} disabled={Boolean(busy) || Boolean(sealingSessionDir) || !listRecordEnabled(listEntry)} title={recordDisabledCopy} aria-label={t('home.recordTaskAria', { id: recording.session_id })}>{t('home.recordTask')}</button>
                    </>}
                <button className="row-folder" title={t('home.openFolder')} aria-label={t('home.openFolderAria', { id: recording.session_id })} onClick={() => void openRecordingDirectory(recording)} disabled={Boolean(busy)}><Icon name="folder" size={15} /></button>
                <div className="home-actions-menu-wrap">
                  <button data-testid="recording-actions-menu" className="row-more" title={t('common.moreActions')} aria-label={t('home.moreAria', { id: recording.session_id })} aria-haspopup="menu" aria-expanded={actionsOpen} onClick={() => setOpenActionsSessionDir(actionsOpen ? '' : recording.session_dir)} disabled={Boolean(busy) || Boolean(deletingSessionDir) || Boolean(resettingSessionDir)}><Icon name="more" size={16} /></button>
                  {actionsOpen && <div className="home-actions-menu" role="menu" aria-label={t('home.actionsAria', { id: recording.session_id })}>
                    {!recording.is_active && recording.export_exists && <button role="menuitem" onClick={() => { setOpenActionsSessionDir(''); void openRecordingExport(recording); }}><Icon name="export" size={14} /><span>{t('home.openExportDir')}</span></button>}
                    {!recording.is_active && (recoveryPlan.secondary === 'seal' || recoveryPlan.primary === 'seal') && <button data-testid="seal-recording" role="menuitem" onClick={() => { setOpenActionsSessionDir(''); setSealConfirmRecording(recording); }} disabled={Boolean(busy) || Boolean(sealingSessionDir)}><Icon name="history" size={14} /><span>{isSealing ? t('common.checking') : t('home.inspectAndRepair')}</span></button>}
                    {!recording.is_active && <><i className="home-actions-divider" /><button data-testid="reset-recording" className="danger" role="menuitem" aria-busy={isResetting} onClick={() => { setOpenActionsSessionDir(''); setResetConfirmRecording(recording); }} disabled={Boolean(busy) || Boolean(sealingSessionDir) || Boolean(deletingSessionDir) || Boolean(resettingSessionDir)}><Icon name="refresh" size={14} /><span>{t('home.resetTask')}</span></button><button data-testid="delete-recording" className="danger" role="menuitem" aria-busy={isDeleting} onClick={() => { setOpenActionsSessionDir(''); setDeleteConfirmRecording(recording); }} disabled={Boolean(busy) || Boolean(sealingSessionDir) || Boolean(deletingSessionDir) || Boolean(resettingSessionDir)}><Icon name="trash" size={14} /><span>{t('home.deleteTask')}</span></button></>}
                  </div>}
                </div>
              </div>
              {rowResumeError && <div className="home-row-error" role="alert"><strong>{t('home.captureNotArmed')}</strong><span title={rowResumeError}>{rowResumeError}</span><div className="home-row-error-actions"><button data-testid="seal-recording" className="seal" aria-busy={isSealing} onClick={() => setSealConfirmRecording(recording)} disabled={Boolean(busy) || Boolean(sealingSessionDir)}>{isSealing ? t('common.checking') : t('home.inspectAndRepair')}</button><button onClick={() => setResumeError(null)} disabled={Boolean(busy)}>{t('common.close')}</button></div></div>}
            </article>;
          })}
          {!historyLoading && historyNextOffset !== null && <div className="home-load-more"><button onClick={() => void loadMoreRecordings()} disabled={historyLoadingMore}>{historyLoadingMore ? t('common.loading') : t('home.loadMore')}</button></div>}
        </section>

        {(error || dataSafetyAlert || presetWarning || busy || notice) && <div className={`home-notice ${error || dataSafetyAlert ? 'error' : ''}`}><i />{error || dataSafetyAlert || presetWarning || busy || notice}</div>}
      </main>
      {exportRecording && <div className="dialog-backdrop" role="presentation">
        <section className="studio-dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-dialog-title">
          <header><span className="dialog-icon"><Icon name="export" size={19} /></span><div><h2 id="export-dialog-title">{t('exportDialog.title')}</h2></div></header>
          <p>{t('exportDialog.intro')}</p>
          {exportDestinationPicker(exportRecording.session_dir)}
          <div className="export-options" aria-label={t('exportDialog.optionsAria')}>
            <button onClick={() => { const task = exportRecording; setExportRecording(null); void exportRecordingArtifact(task, 'full_track'); }} disabled={Boolean(busy)}><span><Icon name="meter" size={16} /></span><div><strong>{t('exportDialog.fullTrack')}</strong><small>full-track.wav · {artifactStatusCopy(exportRecording, 'full_track')}</small></div></button>
            <button onClick={() => { const task = exportRecording; setExportRecording(null); void exportRecordingArtifact(task, 'timestamps_json'); }} disabled={Boolean(busy)}><span><Icon name="file" size={16} /></span><div><strong>{t('exportDialog.timestamps')}</strong><small>timestamps.json · {artifactStatusCopy(exportRecording, 'timestamps_json')}</small></div></button>
            <button onClick={() => { const task = exportRecording; setExportRecording(null); void exportRecordingArtifact(task, 'cuts_zip'); }} disabled={Boolean(busy) || recordingState(exportRecording).kind === 'attention'}><span><Icon name="export" size={16} /></span><div><strong>{t('exportDialog.cuts')}</strong><small>{recordingState(exportRecording).kind === 'attention' ? t('exportDialog.cutsBlocked') : `cuts.zip · ${artifactStatusCopy(exportRecording, 'cuts_zip')}`}</small></div></button>
          </div>
          <div className="dialog-warning">{t('exportDialog.taskLine', { id: exportRecording.session_id })}<br />{t('exportDialog.warning')}</div>
          <footer><button className="button" onClick={() => setExportRecording(null)} disabled={Boolean(busy)}>{t('common.close')}</button></footer>
        </section>
      </div>}
      {sealConfirmRecording && <div className="dialog-backdrop" role="presentation">
        <section className="studio-dialog seal-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="seal-confirm-title">
          <header><span className="dialog-icon"><Icon name="history" size={19} /></span><div><h2 id="seal-confirm-title">{t('sealDialog.title')}</h2></div></header>
          <p>{t('sealDialog.body')}</p>
          <div className="dialog-warning">{t('sealDialog.taskLine', { id: sealConfirmRecording.session_id })}<br />{sealConfirmRecording.status === 'faulted' || sealConfirmRecording.overflow_samples > 0 ? t('sealDialog.keepFault') : t('sealDialog.canContinue')}</div>
          <footer><button className="button" onClick={() => setSealConfirmRecording(null)} disabled={Boolean(busy)}>{t('common.cancel')}</button><button data-testid="confirm-seal-recording" className="button primary" onClick={() => { const recording = sealConfirmRecording; setSealConfirmRecording(null); void sealHistoricalRecording(recording); }} disabled={Boolean(busy)}>{t('sealDialog.confirm')}</button></footer>
        </section>
      </div>}
      {resetConfirmRecording && <div className="dialog-backdrop" role="presentation">
        <section className="studio-dialog delete-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-confirm-title">
          <header><span className="dialog-icon danger"><Icon name="refresh" size={19} /></span><div><h2 id="reset-confirm-title">{t('resetDialog.title')}</h2></div></header>
          <p>{t('resetDialog.body')}</p>
          <div className="dialog-warning danger">{t('resetDialog.taskLine', { id: resetConfirmRecording.session_id })}<br />{t('resetDialog.warning')}</div>
          <footer><button className="button" onClick={() => setResetConfirmRecording(null)} disabled={Boolean(resettingSessionDir)}>{t('common.cancel')}</button><button data-testid="confirm-reset-recording" className="button danger" onClick={() => { const recording = resetConfirmRecording; setResetConfirmRecording(null); void resetHistoricalRecording(recording); }} disabled={Boolean(resettingSessionDir)}>{t('resetDialog.confirm')}</button></footer>
        </section>
      </div>}
      {deleteConfirmRecording && <div className="dialog-backdrop" role="presentation">
        <section className="studio-dialog delete-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
          <header><span className="dialog-icon danger"><Icon name="trash" size={19} /></span><div><h2 id="delete-confirm-title">{t('deleteDialog.title')}</h2></div></header>
          <p>{t('deleteDialog.body')}</p>
          <div className="dialog-warning danger">{t('deleteDialog.taskLine', { id: deleteConfirmRecording.session_id })}<br />{t('deleteDialog.warning')}</div>
          <footer><button className="button" onClick={() => setDeleteConfirmRecording(null)} disabled={Boolean(deletingSessionDir)}>{t('common.cancel')}</button><button data-testid="confirm-delete-recording" className="button danger" onClick={() => { const recording = deleteConfirmRecording; setDeleteConfirmRecording(null); void deleteHistoricalRecording(recording); }} disabled={Boolean(deletingSessionDir)}>{t('deleteDialog.confirm')}</button></footer>
        </section>
      </div>}
      {settingsDialog}
      {exportFeedbackDialog}
      {userAlertDialog}
      {activationFailureDialog}
      <LogPanel open={logPanelOpen} onClose={() => setLogPanelOpen(false)} />
    </div>;
  }

  if (phase === 'setup') {
    const readyToStart = engineStatus === 'ready' && scriptItems.length > 0 && !scriptErrors.length && Boolean(outputDir) && captureConfigurationValid && !busy && !presetBusy;
    return <div className="studio-shell">
      <StudioChrome phase={phase} title={t('setup.title')} onBack={returnToRecordings} onOpenSettings={() => setSettingsOpen(true)} />
      <div className="studio-workspace setup-workspace" data-testid="setup-workspace">
        <aside className="tool-rail" aria-label={t('setup.toolsAria')}><button className="active" title={t('setup.toolNew')}><Icon name="file" /></button><button title={t('setup.toolDevice')}><Icon name="microphone" /></button><button title={t('setup.toolParams')}><Icon name="sliders" /></button><span /><button title={t('setup.toolHistory')} onClick={returnToRecordings}><Icon name="history" /></button></aside>
        <aside className="panel setup-outline">
          <div className="panel-tabs"><button className="active">{t('setup.tabPrepare')}</button><button>{t('setup.tabPresets')}</button></div>
          <div className="panel-section-title">{t('setup.title')}</div>
          <ol className="setup-steps">
            <li className={scriptFile && !scriptErrors.length ? 'complete' : 'active'}><span>{scriptFile && !scriptErrors.length ? <Icon name="check" size={13} /> : '1'}</span><div><strong>{t('setup.stepImportTitle')}</strong><small>{scriptFile || t('setup.stepImportHint')}</small></div></li>
            <li className={deviceName ? 'complete' : ''}><span>{deviceName ? <Icon name="check" size={13} /> : '2'}</span><div><strong>{t('setup.stepAudioTitle')}</strong><small>{deviceName || t('setup.stepAudioHint')}</small></div></li>
            <li className={outputDir ? 'complete' : ''}><span>{outputDir ? <Icon name="check" size={13} /> : '3'}</span><div><strong>{t('setup.stepSaveTitle')}</strong><small>{t('setup.stepSaveHint')}</small></div></li>
          </ol>
          <div className="outline-note"><Icon name="meter" /><p>{t('setup.outlineNote')}</p></div>
        </aside>
        <main id="main" className="setup-document">
          <div className="document-tabs"><span className="active"><Icon name="sliders" size={13} /> {t('setup.documentTab')} <i>×</i></span></div>
          <div className="document-canvas">
            <section className="property-group">
              <div className="property-heading"><span>01</span><div><h2>{t('setup.scriptHeading')}</h2><p>{t('setup.scriptHelp')}</p></div></div>
              <label className={`script-picker ${busy ? 'disabled' : ''}`}><input data-testid="script-file" className="file-input" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" disabled={Boolean(busy)} onChange={(event) => void chooseScriptFile(event.target.files?.[0])} /><span className="picker-icon"><Icon name="file" size={19} /></span><span className="picker-copy"><strong>{scriptFile || t('setup.pickScript')}</strong><small>{scriptFile ? t('setup.scriptLoaded', { count: scriptItems.length }) : t('setup.scriptColumns')}</small></span><span className="button subtle">{t('common.browse')}</span></label>
              {scriptErrors.length > 0 && <div className="validation-errors">{scriptErrors.slice(0, 5).map((message) => <p key={message}>{message}</p>)}</div>}
            </section>
            <section className="property-group">
              <div className="property-heading"><span>02</span><div><h2>{t('setup.audioHeading')}</h2><p>{t('setup.audioHelp')}</p></div></div>
              <div className="capture-preset-stack">
                <div className="capture-preset-bar">
                  <label><span>{t('setup.capturePreset')}</span><select data-testid="capture-preset-select" value={capturePresetStore.lastSelectedPresetId ?? ''} onChange={(event) => void selectCapturePreset(event.target.value)} disabled={Boolean(busy) || presetBusy}><option value="">{t('setup.unsavedConfig')}</option>{capturePresetStore.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
                  <span className={`preset-state ${presetDirty ? 'dirty' : ''}`}>{selectedCapturePreset ? presetDirty ? t('setup.presetDirty') : t('setup.presetApplied', { name: selectedCapturePreset.name }) : t('setup.presetUnsaved')}</span>
                  <button className="button subtle" onClick={() => { setPresetName(selectedCapturePreset?.name ?? ''); setPresetManagerOpen((open) => !open); }} disabled={Boolean(busy) || presetBusy}>{presetManagerOpen ? t('common.collapse') : t('setup.managePresets')}</button>
                </div>
                {presetManagerOpen && <div className="capture-preset-editor">
                  <label className="field"><span>{t('setup.presetName')}</span><input data-testid="capture-preset-name" maxLength={40} value={presetName} placeholder={t('setup.presetNamePlaceholder')} onChange={(event) => setPresetName(event.target.value)} disabled={Boolean(busy) || presetBusy} /></label>
                  <div><button className="button" onClick={() => void saveCapturePreset('new')} disabled={!presetName.trim() || Boolean(busy) || presetBusy}>{selectedCapturePreset ? t('setup.saveAsNew') : t('setup.saveAsPreset')}</button>{selectedCapturePreset && <><button className="button primary" onClick={() => void saveCapturePreset('update')} disabled={!presetName.trim() || Boolean(busy) || presetBusy}>{t('setup.updatePreset')}</button><button className="button danger-button" onClick={() => void deleteCapturePreset()} disabled={Boolean(busy) || presetBusy}>{t('common.delete')}</button></>}</div>
                </div>}
              </div>
              <div className="form-grid audio-form"><label className="field span-2"><span>{t('setup.deviceLabel')}</span><div className="field-row"><select value={deviceId} onChange={(event) => { const device = devices.find((candidate) => candidate.id === event.target.value); setDeviceId(event.target.value); setDeviceName(device?.name ?? ''); }} disabled={Boolean(busy)}>{!devices.length && <option value="">{t('setup.noDevices')}</option>}{deviceId && !selectedDevice && <option value={deviceId}>{t('setup.deviceUnavailable', { name: deviceName || deviceId })}</option>}{devices.map((device) => <option value={device.id} key={device.id}>{device.name}{device.is_default ? t('setup.systemDefault') : ''}</option>)}</select><button className="square-button" title={t('setup.refreshDevices')} onClick={() => void loadDevices()}><Icon name="refresh" /></button></div></label>{exclusiveCaptureAvailable ? <label className="field"><span>{t('setup.shareMode')}</span><select data-testid="capture-share-mode" value={captureShareMode} onChange={(event) => setCaptureShareMode(normalizeCaptureShareMode(event.target.value))} disabled={Boolean(busy)}><option value="shared">{t('setup.sharedRecommended')}</option><option value="exclusive">{t('setup.exclusive')}</option></select></label> : <label className="field"><span>{t('setup.shareMode')}</span><input value={t('setup.shareModeDev')} readOnly /></label>}<label className={`field ${selectedDevice && !rateOptions.includes(sampleRate) ? 'invalid' : ''}`}><span>{t('setup.sampleRate')}</span><select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))}>{!rateOptions.includes(sampleRate) && <option value={sampleRate}>{t('setup.rateIncompatible', { rate: sampleRate.toLocaleString(locale) })}</option>}{rateOptions.map((rate) => <option value={rate} key={rate}>{rate.toLocaleString(locale)} Hz</option>)}</select></label><label className={`field ${selectedDevice && !formatOptions.some((format) => format === inputSampleFormat) ? 'invalid' : ''}`}><span>{t('setup.bitDepth')}</span><select data-testid="capture-sample-format" value={inputSampleFormat} onChange={(event) => setInputSampleFormat(event.target.value)}>{!formatOptions.some((format) => format === inputSampleFormat) && <option value={inputSampleFormat}>{t('setup.formatIncompatible', { format: captureSampleFormatLabel(inputSampleFormat) })}</option>}{formatOptions.map((format) => <option value={format} key={format}>{captureSampleFormatLabel(format)}</option>)}</select></label><label className={`field ${selectedDevice && inputChannel > activeInputChannels ? 'invalid' : ''}`}><span>{t('setup.inputChannel')}</span><select value={inputChannel} onChange={(event) => setInputChannel(Number(event.target.value))}>{inputChannel > activeInputChannels && <option value={inputChannel}>{t('setup.inputIncompatible', { n: inputChannel })}</option>}{Array.from({ length: activeInputChannels }, (_, index) => <option value={index + 1} key={index + 1}>{t('setup.inputN', { n: index + 1 })}</option>)}</select></label><label className="field"><span>{t('setup.silenceThreshold')}</span><input type="number" min="-72" max="-12" step="1" value={noiseThresholdDbfs} onChange={(event) => setNoiseThresholdDbfs(Math.min(-12, Math.max(-72, Number(event.target.value) || -42)))} /></label><label className="field"><span>{t('setup.silenceDuration')}</span><input type="number" min="0.2" max="5" step="0.1" value={silenceDurationMs / 1_000} onChange={(event) => setSilenceDurationMs(Math.round(Math.min(5, Math.max(.2, Number(event.target.value) || 1)) * 1_000))} /></label></div>
              <div className={`hardware-line ${captureConfigurationIssue ? 'invalid' : ''}`}><span className={captureConfigurationValid ? 'ok' : ''}><i />{captureConfigurationIssue || t('setup.configOk')}</span><em>{captureShareModeLabel(captureShareMode)}</em><em>{t('setup.inputChannelOf', { channel: inputChannel, total: activeInputChannels })}</em><em>{t('setup.driverFormats', { formats: captureFormats.join(' / ') || t('setup.driverIncompatible') })}</em><em>{captureSampleFormatLabel(inputSampleFormat)}</em></div>
              <p className="hardware-hint">{captureShareMode === 'shared' || !exclusiveCaptureAvailable ? t('setup.sharedFormatHint') : t('setup.exclusiveFormatHint')}</p>
              {!exclusiveCaptureAvailable && window.recorder.runtime === 'desktop' && <p className="dev-web-capture-hint">{t('setup.devWebCaptureHint')}</p>}
            </section>
            <section className="property-group">
              <div className="property-heading"><span>03</span><div><h2>{t('setup.storageHeading')}</h2><p>{t('setup.storageHelp')}</p></div></div>
              <div className="form-grid storage-form"><label className="field"><span>{t('setup.sessionName')}</span><input value={sessionName} onChange={(event) => setSessionName(event.target.value)} /></label><label className="field span-2"><span>{t('setup.localLocation')}</span><div className="field-row"><input value={outputDir} readOnly /><button className="button" onClick={() => void chooseOutput()}><Icon name="folder" size={14} />{t('common.selectEllipsis')}</button></div></label></div>
            </section>
            <div className="document-actions"><p><Icon name="check" size={14} />{t('setup.createHint')}</p><button data-testid="start-session" className="button primary" onClick={() => void startSession({ activateAfterCreate: true })} disabled={!readyToStart}><Icon name="record" size={14} />{t('setup.createTask')}</button></div>
          </div>
        </main>
        <aside className="panel inspector setup-inspector">
          <div className="panel-tabs"><button className="active">{t('setup.inspector')}</button></div>
          <div className="inspector-section"><h3>{t('setup.summary')}</h3><dl className="property-list"><div><dt>{t('setup.scriptItems')}</dt><dd>{scriptItems.length || t('common.dash')}</dd></div><div><dt>{t('setup.shareMode')}</dt><dd>{captureShareModeLabel(captureShareMode)}</dd></div><div><dt>{t('setup.sampleRate')}</dt><dd>{sampleRate.toLocaleString(locale)} Hz</dd></div><div><dt>{t('setup.bitDepth')}</dt><dd>{captureSampleFormatLabel(inputSampleFormat)}</dd></div><div><dt>{t('setup.inputChannel')}</dt><dd>{inputChannel}</dd></div><div><dt>{t('setup.channels')}</dt><dd>{t('setup.mono')}</dd></div><div><dt>{t('setup.noiseCeiling')}</dt><dd>{noiseThresholdDbfs} dBFS</dd></div><div><dt>{t('setup.headTailSilence')}</dt><dd>{(silenceDurationMs / 1_000).toFixed(1)} s</dd></div></dl></div>
          <div className="inspector-section"><h3>{t('setup.inputDevice')}</h3><div className="device-summary"><span><Icon name="microphone" /></span><div><strong>{deviceName || t('setup.noDeviceSelected')}</strong><small>{selectedDevice?.is_default ? t('setup.defaultInput') : t('setup.externalInput')}</small></div></div></div>
          <div className="inspector-section"><h3>{t('setup.dataPolicy')}</h3><ul className="feature-list"><li><Icon name="check" />{t('setup.policyMaster')}</li><li><Icon name="check" />{t('setup.policyInteger')}</li><li><Icon name="check" />{t('setup.policyRetake')}</li><li><Icon name="check" />{t('setup.policySnapshot')}</li></ul></div>
        </aside>
      </div>
      <StudioStatus engineStatus={engineStatus} message={error || dataSafetyAlert || presetWarning || busy || notice} isError={Boolean(error || dataSafetyAlert)} />
      {settingsDialog}
      {exportFeedbackDialog}
      {userAlertDialog}
      {activationFailureDialog}
      <LogPanel open={logPanelOpen} onClose={() => setLogPanelOpen(false)} />
    </div>;
  }

  return <div className="studio-shell">
    <StudioChrome phase={phase} title={snapshot?.session_id ?? t('home.stateCurrent')} onBack={requestSafePause} onOpenSettings={() => setSettingsOpen(true)} backTitle={t('chrome.leaveTask')} activityLabel={workspaceFaulted ? t('chrome.inspectReadonly') : captureActive ? t('chrome.consoleCapturing') : t('chrome.consoleView')} />
    <div className="studio-workspace recording-workspace" data-testid="recording-workspace">
      <aside className="tool-rail" aria-label={t('recorder.toolsAria')} />
      <aside className="panel item-browser">
        <div className="panel-tabs"><button className="active">{t('recorder.tabScript')}</button><button>{t('recorder.tabMarks')}</button></div>
        <div className="browser-summary"><span>{t('recorder.completedOf', { done: completed, total: items.length })}</span><div className="mini-progress"><i style={{ width: `${items.length ? completed / items.length * 100 : 0}%` }} /></div></div>
        <div className="item-filter"><span>{t('recorder.allItems')}</span><em>{items.length}</em></div>
        <div className="professional-item-list">{items.map((item, index) => <button key={item.id} className={`professional-item ${index === currentIndex ? 'active' : ''}`} disabled={recording || captureFault} onClick={() => { setCurrentIndex(index); setReviewAttemptId(null); }}><span className={`item-state ${item.status}`}>{item.status === 'accepted' ? <Icon name="check" size={12} /> : item.status === 'skipped' ? '—' : String(index + 1).padStart(2, '0')}</span><span><strong>{item.id}</strong><small>{item.text}</small></span><em>{statusLabel(item.status)}</em></button>)}</div>
      </aside>
      <main id="main" className="editor-document">
        <div className="document-tabs"><span className="active"><Icon name="microphone" size={13} /> {workflowComplete ? t('recorder.taskComplete') : currentItem?.id ?? 'Item'} <i>×</i></span></div>
        <div className="editor-toolbar"><div className="editor-nav"><button title={t('recorder.prevItem')} disabled={recording || currentIndex === 0} onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}><Icon name="chevron-left" /></button><span>{currentIndex + 1} / {items.length}</span><button title={t('recorder.nextItem')} disabled={recording || currentIndex >= items.length - 1} onClick={() => setCurrentIndex((index) => Math.min(items.length - 1, index + 1))}><Icon name="chevron-right" /></button></div><div className="editor-time"><strong className={recording ? 'recording' : ''}>{recording ? attemptDuration : sessionDuration}</strong></div><div className="editor-toolbar-actions"><button className="prompter-launch" onClick={() => void openPrompterPanel()}><Icon name="play" size={13} />{prompterStatus.ready ? t('recorder.locatePrompter') : t('recorder.openPrompter')}</button></div><div className={`save-health ${workspaceFaulted || captureFault ? 'fault' : meter.storage_status === 'warning' ? 'warning' : ''}`}><i />{workspaceFaulted ? t('recorder.healthReadonly') : !captureActive ? t('recorder.healthView') : captureFault ? t('recorder.healthFaultStop', { title: captureFaultCopy.title }) : meter.storage_status === 'warning' ? t('recorder.healthWarning', { minutes: Math.max(0, Math.floor(meter.storage_safe_remaining_seconds / 60)) }) : t('recorder.healthLive')}</div></div>
        <div className="editor-canvas">
          {(activationFailure || captureFault || discontinuityToast || qualityWarning || (captureActive && !prompterStatus.ready && !workspaceFaulted)) && <div className="workspace-toasts" aria-live="polite">
            {captureActive && !prompterStatus.ready && !workspaceFaulted && !captureFault && <div className="session-noise-banner" role="status" data-testid="prompter-missing-banner"><Icon name="play" size={16} /><div><strong>{t('recorder.prompterMissingTitle')}</strong><span>{t('recorder.prompterMissingBody')}</span></div><button className="button" onClick={() => void openPrompterPanel()} disabled={Boolean(busy)}>{t('recorder.openPrompter')}</button></div>}
            {activationFailure && !captureActive && <div className="session-noise-banner failed" role="alert" data-testid="activation-failure-banner"><Icon name="stop" size={16} /><div><strong>{activationErrorCopy(activationFailure.kind).title}</strong><span>{activationErrorCopy(activationFailure.kind).body}</span></div><button className="button" onClick={() => setActivationFailureOpen(true)} disabled={Boolean(busy)}>{t('activationError.openEditor')}</button></div>}
            {captureFault && <div className="capture-fault-banner" role="alert"><Icon name="stop" size={16} /><div><strong>{captureFaultCopy.title}</strong><span>{captureFaultCopy.detail}{snapshot?.device_name ? ` ${t('issues.currentDevice', { name: snapshot.device_name })}` : ' '}{t('issues.stopThenFinish')}</span></div></div>}
            {discontinuityToast && !captureFault && <div className="input-quality-banner workspace-toast" data-testid="discontinuity-toast" role="status"><Icon name="meter" size={16} /><div><strong>{t('discontinuity.bannerTitle')}</strong><span>{discontinuityToast}. {t('discontinuity.bannerHint')}</span></div></div>}
            {qualityWarning && <div className="input-quality-banner" role="alert"><Icon name="meter" size={16} /><div><strong>{t('quality.bannerTitle')}</strong><span>{qualityWarning}. {t('quality.bannerHint')}</span></div></div>}
          </div>}
          <section className="script-monitor"><header><span>{t('recorder.currentSentence')}</span><div><span className="studio-cue">{cueLabel}</span><em>{workflowComplete ? t('recorder.itemsCount', { count: items.length }) : `${currentIndex + 1} / ${items.length}`}</em></div></header><div className={`prompt-surface ${captureFault ? 'fault' : cue === 'pending' || cue === 'checking' ? 'pending' : cue === 'ready' ? 'ready' : cue === 'recording' ? 'live' : ''}`}>{captureFault ? <span className="label-chip">{t('recorder.stopReadingChip')}</span> : noiseCheckBlocksAttempt ? <span className="label-chip">{t('recorder.envChip')}</span> : (workflowComplete || currentItem?.label) && <span className="label-chip">{workflowComplete ? t('recorder.allDoneChip') : currentItem?.label}</span>}<p>{captureFault ? captureFaultCopy.title : noiseCheckBlocksAttempt ? t('recorder.keepQuiet') : workflowComplete ? t('recorder.scriptFinished') : currentItem?.text ?? t('recorder.noText')}</p><small>{captureFault ? captureFaultCopy.detail : noiseCheckBlocksAttempt ? noiseCheckMessage : workflowComplete ? t('recorder.exportLater') : <>{currentItem?.id}</>}</small></div></section>
          <section className="signal-monitor"><header><div><strong>{t('recorder.waveform')}</strong>{captureActive || shouldUseRecordedSilencePair(recording, reviewAttempt) ? <SilencePairReadout pair={silencePair} /> : null}</div><div>{captureActive ? <><span>RMS <b>{db(meter.rms)}</b></span><span>PEAK <b className={meter.peak > .92 ? 'clip' : ''}>{db(meter.peak)}</b></span></> : <span>{reviewAttempt ? formatDuration(reviewAttempt.end_sample - reviewAttempt.start_sample, sampleRateForDisplay) : t('recorder.noTakeWaveform')}</span>}</div></header><div className="signal-scope"><WebGLWaveform key={showReviewWaveform ? `${sessionDir}:${reviewAttempt?.attempt_id}` : `${sessionDir}:${waveformGeneration}`} mode={showReviewWaveform ? 'review' : 'live'} bins={showReviewWaveform ? reviewWaveformBins : (meter.waveform ?? [])} capturedSamples={meter.captured_samples} waveformEndSample={meter.waveform_end_sample} recording={waveformTakeIsActive(recording && !captureFault, hasSpoken)} takeStartSample={recording && !captureFault ? attemptStartSample : undefined} sampleRate={sampleRateForDisplay} />{captureActive ? <LiveSilenceHint liveMs={liveSilenceMs} requiredMs={effectiveSilenceDurationMs} /> : null}<div className="scope-scale"><span>−1.0</span><span>−0.5</span><span>0</span><span>+0.5</span><span>+1.0</span></div></div><div className="horizontal-meter"><i className="meter-rms" style={{ width: `${rmsPercent}%` }} /><i className="meter-peak" style={{ left: `${peakPercent}%` }} /></div></section>
          <section className="transport-panel">
            <div className="transport-review">
              {showReviewSilenceBill && <span className={`silence-bill${silencePair.hint || silencePair.extra ? ' has-issue' : ''}`} data-testid="review-silence-bill"><SilencePairReadout pair={silencePair} hint /></span>}
            </div>
            <div className="transport-controls">
              <div className="transport-secondary">
              <button title={t('recorder.previewKey')} onClick={() => void previewAttempt()} disabled={recording || !currentItem?.attempts.length || Boolean(busy)}><Icon name="play" /><span>{t('recorder.preview')}</span><kbd>P</kbd></button>
              {captureActive && <button title={t('recorder.retakeKey')} onClick={() => void startAttempt()} disabled={workspaceFaulted || captureFault || noiseCheckBlocksAttempt || recording || !currentItem || Boolean(busy)}><Icon name="retake" /><span>{t('recorder.retake')}</span><kbd>R</kbd></button>}
              </div>
              <div className="transport-primary">
              {!captureActive
                ? workspaceFaulted
                  ? <button data-testid="main-transport" className="main-transport start" disabled><span><Icon name="microphone" /></span><strong>{t('recorder.readonlyRepair')}</strong></button>
                  : <button data-testid="main-transport" className="main-transport start" onClick={() => void previewAttempt()} disabled={Boolean(busy) || !currentItem?.attempts.length}><span><Icon name="play" /></span><strong>{t('recorder.previewThis')}</strong><kbd>SPACE</kbd></button>
                : captureFault
                ? <button data-testid="main-transport" className="main-transport stop" onClick={finishSession} disabled={Boolean(busy)}><span><Icon name="stop" /></span><strong>{t('recorder.finishKeepMaster')}</strong><kbd>SPACE</kbd></button>
                : noiseCheckBlocksAttempt && primaryAction === 'start'
                  ? <button data-testid="main-transport" className="main-transport waiting" onClick={() => snapshot && void runSessionNoiseCheck(sessionDir, snapshot)} disabled={noiseCheckRunning || Boolean(busy)}><span><Icon name="meter" /></span><strong>{noiseCheckRunning ? t('recorder.noiseChecking') : t('recorder.finishNoiseFirst')}</strong></button>
                : recording
                  ? <button data-testid="main-transport" className={`main-transport ${isPendingTake ? 'waiting' : 'stop'}`} onClick={() => void stopAttempt()} disabled={Boolean(busy)}><span><Icon name="stop" /></span><strong>{isPendingTake ? t('recorder.pendingCancel') : t('recorder.finishSentence')}</strong>{isPendingTake ? <><kbd>ESC</kbd><kbd>SPACE</kbd></> : <kbd>SPACE</kbd>}</button>
                : primaryAction === 'accept'
                  ? <button data-testid="main-transport" className="main-transport accept" onClick={() => void acceptAttempt()} disabled={Boolean(busy)}><span><Icon name="check" /></span><strong>{acceptButtonLabel}</strong><kbd>SPACE</kbd></button>
                  : primaryAction === 'finish'
                    ? <button data-testid="main-transport" className="main-transport complete" onClick={finishSession} disabled={Boolean(busy)}><span><Icon name="check" /></span><strong>{t('recorder.finishAll')}</strong><kbd>SPACE</kbd></button>
                    : primaryAction === 'start'
                      ? <button data-testid="main-transport" className="main-transport start" onClick={() => void startAttempt()} disabled={Boolean(busy)}><span><Icon name="record" /></span><strong>{t('recorder.startRecording')}</strong><kbd>SPACE</kbd></button>
                      : <button data-testid="main-transport" className="main-transport handled" disabled><span><Icon name="check" /></span><strong>{t('recorder.itemHandled')}</strong><kbd>R</kbd></button>}
            </div>
              <div className="transport-secondary right">{captureActive && <button title={t('recorder.skipKey')} onClick={() => void skipItem()} disabled={captureFault || recording || Boolean(busy) || !currentItem || !['pending', 'review'].includes(currentItem.status)}><Icon name="skip" /><span>{t('recorder.skip')}</span><kbd>S</kbd></button>}</div>
            </div>
          </section>
        </div>
      </main>
      <aside className="panel inspector recording-inspector">
        <div className={`monitor-status-strip ${captureFault || workspaceFaulted ? 'fault' : meter.storage_status === 'warning' ? 'warning' : ''}`}>
          <span><i />{captureFault ? captureFaultCopy.title : workspaceFaulted ? t('recorder.monitorReadonly') : captureActive ? t('recorder.monitorLive') : t('recorder.monitorView')}</span>
          <span className={prompterStatus.ready ? 'ready' : ''}><i />{prompterStatus.ready ? t('recorder.prompterConnected') : t('recorder.prompterDisconnected')}</span>
        </div>
        <div className="monitor-panel-body">
          <div className="monitor-tab-content">
            {monitorPanelTab === 'monitor' && <>
              <section className="monitor-section input-inspector"><h3>{t('recorder.listenInput')}</h3><div className="vertical-meter-wrap"><div className="vertical-meter"><i className="safe-zone" /><i className="vertical-fill" style={{ height: `${peakPercent}%` }} /></div><div className="vertical-scale"><span>0</span><span>−6</span><span>−12</span><span>−24</span><span>−48</span></div><div className="level-readout"><strong className={meter.peak > .92 ? 'clip' : ''}>{db(meter.peak)}</strong><small>PEAK</small><strong>{db(meter.rms)}</strong><small>RMS</small></div></div><p className={`level-hint ${captureFault || meter.peak > .92 ? 'danger' : meter.peak > .04 ? 'good' : ''}`}><i />{!captureActive ? t('recorder.cardOff') : captureFault ? t('recorder.inputStopped') : meter.peak > .92 ? t('recorder.inputClip') : meter.peak > .04 ? t('recorder.inputOk') : t('recorder.inputWait')}</p>{devWebCaptureEnabled && captureActive && <p className="dev-web-capture-hint">{devWebCaptureNotice || t('recorder.devWebCaptureOn')}</p>}</section>
              <section className="monitor-section"><h3>{t('recorder.currentState')}</h3><dl className="property-list"><div><dt>{t('recorder.sentence')}</dt><dd>{cueLabel}</dd></div><div><dt>{t('recorder.headTail')}</dt><dd><SilencePairReadout pair={silencePair} /></dd></div><div><dt>{t('recorder.disk')}</dt><dd>{meter.storage_status === 'healthy' ? t('recorder.diskHealthy') : meter.storage_status === 'warning' ? t('recorder.diskWarning') : t('recorder.diskCritical')}</dd></div></dl></section>
              <button className="detection-summary" onClick={() => setMonitorPanelTab('detection')}><span><strong>{t('recorder.silenceJudge')}</strong><small>{noiseThresholdDbfs} dBFS / {(effectiveSilenceDurationMs / 1_000).toFixed(1)} {t('recorder.seconds')}</small></span><em>{t('recorder.adjust')}</em></button>
            </>}
            {monitorPanelTab === 'detection' && <section className="monitor-section detection-settings"><h3>{t('recorder.detectionTitle')}</h3><p>{t('recorder.detectionHelp')}</p><div className="detection-setting"><header><span><strong>{t('recorder.threshold')}</strong><small>{t('recorder.currentRms', { value: liveRmsDbfs <= -96 ? '−∞' : `${liveRmsDbfs.toFixed(1)} dBFS` })}</small></span><output>{silenceThresholdDraftDbfs} <small>dBFS</small></output></header><div className="threshold-track"><i style={{ left: `${liveRmsOnThresholdScale}%` }} title={t('quality.currentRmsTitle', { value: liveRmsDbfs.toFixed(1) })} /><input data-testid="task-silence-threshold" aria-label={t('recorder.threshold')} aria-valuetext={`${silenceThresholdDraftDbfs} dBFS`} type="range" min="-72" max="-12" step="1" value={silenceThresholdDraftDbfs} onChange={(event) => setSilenceThresholdDraftDbfs(Number(event.target.value))} onPointerUp={(event) => void applyTaskSilenceSettings(Number(event.currentTarget.value), silenceDurationDraftMs)} onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void applyTaskSilenceSettings(Number(event.currentTarget.value), silenceDurationDraftMs); }} disabled={!captureActive || workspaceFaulted || captureFault || silenceSettingsSaving} /></div><div className="threshold-labels"><span>{t('recorder.moreSensitive')}</span><span>{t('recorder.moreReject')}</span></div></div><div className="detection-setting"><header><span><strong>{t('recorder.duration')}</strong><small>{t('recorder.sameDuration')}</small></span><output>{(silenceDurationDraftMs / 1_000).toFixed(1)} <small>{t('recorder.seconds')}</small></output></header><input data-testid="task-silence-duration" aria-label={t('recorder.duration')} aria-valuetext={`${(silenceDurationDraftMs / 1_000).toFixed(1)} ${t('recorder.seconds')}`} type="range" min="200" max="5000" step="100" value={silenceDurationDraftMs} onChange={(event) => setSilenceDurationDraftMs(Number(event.target.value))} onPointerUp={(event) => void applyTaskSilenceSettings(silenceThresholdDraftDbfs, Number(event.currentTarget.value))} onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void applyTaskSilenceSettings(silenceThresholdDraftDbfs, Number(event.currentTarget.value)); }} disabled={!captureActive || workspaceFaulted || captureFault || silenceSettingsSaving} /><div className="threshold-labels"><span>0.2 {t('recorder.seconds')}</span><span>5.0 {t('recorder.seconds')}</span></div></div><div className="automation-rules"><header><strong>{t('recorder.automationRules')}</strong><small>{t('recorder.automationRulesHelp')}</small></header><AutomationRuleRow testId="rule-auto-start-next" checked={automationRules.autoStartNext} title={t('recorder.ruleAutoStartNext')} hint={t('recorder.ruleAutoStartNextHint')} onChange={(enabled) => applyAutomationRule('autoStartNext', enabled)} /><AutomationRuleRow testId="rule-head-tail" checked={automationRules.headTailSilence} title={t('recorder.ruleHeadTail')} hint={t('recorder.ruleHeadTailHint')} onChange={(enabled) => applyAutomationRule('headTailSilence', enabled)} /><AutomationRuleRow testId="rule-discard-empty" checked={automationRules.discardEmpty} title={t('recorder.ruleDiscardEmpty')} hint={t('recorder.ruleDiscardEmptyHint')} onChange={(enabled) => applyAutomationRule('discardEmpty', enabled)} /><AutomationRuleRow testId="rule-env-check" checked={automationRules.envCheck} title={t('recorder.ruleEnvCheck')} hint={t('recorder.ruleEnvCheckHint')} onChange={(enabled) => applyAutomationRule('envCheck', enabled)} /><AutomationRuleRow testId="rule-almost-silent" checked={automationRules.almostSilent} title={t('recorder.ruleAlmostSilent')} hint={t('recorder.ruleAlmostSilentHint')} onChange={(enabled) => applyAutomationRule('almostSilent', enabled)} /><AutomationRuleRow testId="rule-peak-high" checked={automationRules.peakHigh} title={t('recorder.rulePeakHigh')} hint={t('recorder.rulePeakHighHint')} onChange={(enabled) => applyAutomationRule('peakHigh', enabled)} /></div><p className={`settings-apply-state ${silenceSettingsError ? 'error' : ''}`}>{silenceSettingsSaving ? t('recorder.applyingSettings') : silenceSettingsError || t('recorder.appliedSettings', { db: noiseThresholdDbfs, seconds: (effectiveSilenceDurationMs / 1_000).toFixed(1) })}</p><button className="restore-settings" onClick={() => void applyTaskSilenceSettings(taskInitialSilenceThresholdDbfs, taskInitialSilenceDurationMs)} disabled={!captureActive || workspaceFaulted || captureFault || silenceSettingsSaving || (noiseThresholdDbfs === taskInitialSilenceThresholdDbfs && silenceDurationMs === taskInitialSilenceDurationMs)}>{t('recorder.restoreInitial')}</button></section>}
            {monitorPanelTab === 'task' && <section className="monitor-section"><h3>{t('recorder.taskParams')}</h3><dl className="property-list"><div><dt>{t('setup.inputDevice')}</dt><dd title={snapshot?.device_name}>{snapshot?.device_name || t('common.dash')}</dd></div><div><dt>{t('setup.shareMode')}</dt><dd>{captureShareModeLabel(snapshot?.capture_share_mode ?? captureShareMode)}</dd></div><div><dt>{t('setup.inputChannel')}</dt><dd>{snapshot?.audio_format.input_channel ?? 1}</dd></div><div><dt>{t('recorder.exportFormat')}</dt><dd>{sampleRateForDisplay / 1000}k / {snapshot?.audio_format.bit_depth}-bit {snapshot?.audio_format.encoding ?? ''}</dd></div><div><dt>{t('recorder.driverInputFormat')}</dt><dd>{snapshot?.input_sample_format?.toUpperCase() ?? t('common.dash')}</dd></div><div><dt>{t('recorder.envCeiling')}</dt><dd>{snapshot?.noise_threshold_dbfs ?? snapshot?.noise_check?.threshold_dbfs ?? t('common.dash')} dBFS</dd></div><div><dt>{t('recorder.accepted')}</dt><dd>{counts.accepted ?? 0} / {items.length}</dd></div><div><dt>{t('recorder.skipped')}</dt><dd>{counts.skipped ?? 0}</dd></div></dl><button className="button panel-action" onClick={() => void openPrompterPanel()}><Icon name="play" size={13} />{prompterStatus.ready ? t('recorder.locatePrompter') : t('recorder.openPrompter')}</button></section>}
            {monitorPanelTab === 'export' && snapshot && <section className="monitor-section monitor-export"><h3>{t('recorder.exportCurrent')}</h3><p>{captureActive ? recording ? t('recorder.exportWhileRecording') : t('recorder.exportWillPause') : t('recorder.exportIndependent')}</p>{exportDestinationPicker(sessionDir)}<div>
              <button onClick={() => void exportRecordingArtifact({ session_id: snapshot.session_id, session_dir: sessionDir }, 'full_track')} disabled={Boolean(busy) || recording}><Icon name="meter" /><span><strong>{t('recorder.fullTrackShort')}</strong><small>{artifactStatusCopy(workspaceRecording, 'full_track')}</small></span></button>
              <button onClick={() => void exportRecordingArtifact({ session_id: snapshot.session_id, session_dir: sessionDir }, 'timestamps_json')} disabled={Boolean(busy) || recording}><Icon name="file" /><span><strong>{t('recorder.timestampsShort')}</strong><small>{artifactStatusCopy(workspaceRecording, 'timestamps_json')}</small></span></button>
              <button onClick={() => void exportRecordingArtifact({ session_id: snapshot.session_id, session_dir: sessionDir }, 'cuts_zip')} disabled={Boolean(busy) || recording || workspaceFaulted}><Icon name="export" /><span><strong>{t('recorder.cutsShort')}</strong><small>{workspaceFaulted ? t('recorder.cutsAfterRepair') : artifactStatusCopy(workspaceRecording, 'cuts_zip')}</small></span></button>
            </div></section>}
            {monitorPanelTab === 'issues' && <section className="monitor-section monitor-issues"><h3>{t('recorder.issuesTitle')}</h3>{captureFault && <p><strong>{captureFaultCopy.title}</strong><span>{captureFaultCopy.detail}</span></p>}{discontinuityWarning && <p><strong>{t('issues.discontinuityTitle')}</strong><span>{discontinuityWarning}。</span></p>}{workspaceFaulted && <p><strong>{t('issues.readonlyTitle')}</strong><span>{t('issues.readonlyBody')}</span></p>}{qualityWarning && <p><strong>{t('quality.bannerTitle')}</strong><span>{qualityWarning}</span></p>}{meter.storage_status !== 'healthy' && <p><strong>{t('issues.storageTitle')}</strong><span>{meter.storage_status === 'warning' ? t('issues.storageWarning', { minutes: Math.max(0, Math.floor(meter.storage_safe_remaining_seconds / 60)) }) : t('issues.storageCritical')}</span></p>}</section>}
          </div>
          <nav className="monitor-tabs" aria-label={t('recorder.tabsAria')}>
            <button className={monitorPanelTab === 'monitor' ? 'active' : ''} onClick={() => setMonitorPanelTab('monitor')} title={t('recorder.tabMonitor')}><Icon name="headphones" /><span>{t('recorder.tabMonitor')}</span></button>
            <button className={monitorPanelTab === 'detection' ? 'active' : ''} onClick={() => setMonitorPanelTab('detection')} title={t('recorder.tabDetectionTitle')}><Icon name="sliders" /><span>{t('recorder.tabDetection')}</span></button>
            <button className={monitorPanelTab === 'task' ? 'active' : ''} onClick={() => setMonitorPanelTab('task')} title={t('recorder.tabTask')}><Icon name="file" /><span>{t('recorder.tabTask')}</span></button>
            <button className={monitorPanelTab === 'export' ? 'active' : ''} onClick={() => setMonitorPanelTab('export')} title={t('recorder.tabExport')}><Icon name="export" /><span>{t('recorder.tabExport')}</span></button>
            {hasMonitorIssues && <button className={monitorPanelTab === 'issues' ? 'active issue' : 'issue'} onClick={() => setMonitorPanelTab('issues')} title={t('recorder.tabIssues')}><Icon name="stop" /><span>{t('recorder.tabIssues')}</span></button>}
          </nav>
        </div>
        <div className="inspector-footer">
          {!captureActive && <button data-testid="enter-capture" className="button finish-session enter-capture" title={t('recorder.enterCaptureKey')} onClick={() => void activateCaptureAndPrompter(currentItem?.id)} disabled={Boolean(busy) || workspaceFaulted}><Icon name="microphone" size={14} />{t('recorder.enterCapture')}<kbd>R</kbd></button>}
          <button data-testid="finish-session" className={`button finish-session ${captureActive ? '' : 'leave-task'}`} onClick={() => void finishSession()} disabled={Boolean(busy)}><Icon name={captureActive ? 'stop' : 'chevron-left'} size={14} />{!captureActive ? t('recorder.leaveView') : exitAction === 'fault' ? t('recorder.finishAndLeave') : t('recorder.pauseAndLeave')}</button>
        </div>
      </aside>
    </div>
    {showNoiseCheckDialog && <NoiseCheckDialog
      gate={currentNoiseGate}
      running={noiseCheckRunning}
      error={noiseCheckError}
      samples={noiseSamples}
      liveRmsDbfs={noiseCheckLive?.rms_dbfs ?? null}
      thresholdDbfs={noiseLimitDbfs}
      result={snapshot?.noise_check ?? null}
      busy={Boolean(busy)}
      onRetry={() => snapshot && void runSessionNoiseCheck(sessionDir, snapshot)}
    />}
    {pauseConfirmOpen && !captureFault && <div className="dialog-backdrop" role="presentation">
      <section className="studio-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-dialog-title">
        <header><span className="dialog-icon"><Icon name="chevron-left" size={19} /></span><div><h2 id="pause-dialog-title">{recording ? t('pauseDialog.titleRecording') : t('pauseDialog.titleIdle')}</h2></div></header>
        <p>{recording
          ? hasSpoken
            ? t('pauseDialog.spoken')
            : t('pauseDialog.silent')
          : t('pauseDialog.idle')}</p>
        <dl className="dialog-summary"><div><dt>{t('recorder.accepted')}</dt><dd>{counts.accepted ?? 0}</dd></div><div><dt>{t('recorder.skipped')}</dt><dd>{counts.skipped ?? 0}</dd></div><div><dt>{t('recorder.pending')}</dt><dd className={(counts.pending ?? 0) + (counts.review ?? 0) ? 'warning' : ''}>{(counts.pending ?? 0) + (counts.review ?? 0)}</dd></div></dl>
        <div className="dialog-warning">{t('pauseDialog.warning')}</div>
        <footer><button data-testid="pause-cancel" className="button" onClick={() => setPauseConfirmOpen(false)} disabled={Boolean(busy)}>{t('pauseDialog.keepRecording')}</button><button data-testid="pause-confirm" className="button primary" onClick={() => void safePauseAndReturn()} disabled={Boolean(busy)}><Icon name="stop" size={14} />{recording ? t('pauseDialog.endAndLeave') : t('pauseDialog.pauseAndLeave')}</button></footer>
      </section>
    </div>}
    {previewOpen && audioUrl && <PreviewPlayer
      ref={previewPlayerRef}
      url={audioUrl}
      attemptId={previewingAttemptId}
      itemId={currentItem?.id ?? ''}
      itemText={currentItem?.text ?? ''}
      itemLabel={currentItem?.label}
      bins={previewBins}
      sampleRate={sampleRateForDisplay}
      onClose={closePreviewPlayer}
    />}
    {finishConfirmOpen && <div className="dialog-backdrop" role="presentation">
      <section className="studio-dialog" role="dialog" aria-modal="true" aria-labelledby="finish-dialog-title">
        <header><span className="dialog-icon"><Icon name="stop" size={19} /></span><div><h2 id="finish-dialog-title">{captureFault ? t('finishDialog.titleFault') : t('finishDialog.titleNormal')}</h2></div></header>
        <p>{captureFault ? t('finishDialog.bodyFault') : t('finishDialog.bodyNormal')}</p>
        <dl className="dialog-summary"><div><dt>{t('recorder.accepted')}</dt><dd>{counts.accepted ?? 0}</dd></div><div><dt>{t('recorder.skipped')}</dt><dd>{counts.skipped ?? 0}</dd></div><div><dt>{t('recorder.pending')}</dt><dd className={(counts.pending ?? 0) + (counts.review ?? 0) ? 'warning' : ''}>{(counts.pending ?? 0) + (counts.review ?? 0)}</dd></div></dl>
        <footer><button data-testid="finish-cancel" className="button" onClick={() => setFinishConfirmOpen(false)}>{captureFault ? t('finishDialog.stayFault') : t('common.cancel')}</button><button data-testid="finish-confirm" className="button primary" onClick={() => void confirmFinishSession()} disabled={Boolean(busy)}><Icon name="stop" size={14} />{captureFault ? t('finishDialog.confirmFault') : t('finishDialog.confirmNormal')}</button></footer>
      </section>
    </div>}
    <StudioStatus engineStatus={engineStatus} message={error || dataSafetyAlert || busy || notice} isError={Boolean(error || dataSafetyAlert)} />
    {settingsDialog}
    {exportFeedbackDialog}
    {userAlertDialog}
    {activationFailureDialog}
    <LogPanel open={logPanelOpen} onClose={() => setLogPanelOpen(false)} />
  </div>;
}

