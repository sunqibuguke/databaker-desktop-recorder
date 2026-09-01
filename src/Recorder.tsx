import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HomeHeader, Icon, StudioChrome, StudioStatus, type EngineStatus, type Phase } from './studio-chrome';
import {
  effectiveCaptureFaultKind,
  engineRecoveryFailure,
  isReconciliableInactiveStopError,
  planTaskListEntry,
  splitRecoveryWarnings,
} from './history-recovery';
import type { TaskListEntry } from './history-recovery';
import type { EffectiveCaptureFaultKind } from './history-recovery';
import { parseScript, scriptPreviewFromSnapshotItems, type ParseResult } from './script-parser';
import {
  areAllItemsHandled,
  captureExitAction,
  captureExitDialog,
  inspectorFooterModel,
  isLabelBoundary,
  itemHasPendingRetakeDecision,
  itemHasRetainedPreviousWarning,
  itemRequiresRerecord,
  labelTransition,
  findNextRerecordIndex,
  nextPhysicalItemIndex,
  shouldStayInTaskAfterStop,
  continuationAfterAccept,
  executeSafePause,
  findNextActionableItemIndex,
  idlePrimaryAction,
  isCurrentSessionNoiseCheckOperation,
  isFinalReview,
  captureEntryOverlay,
  noiseCheckShortcutAction,
  NOISE_CHECK_STEPS,
  resolveRunningItemIndex,
  retakeSequenceActionReady,
  selectionIndexAfterStoppedRetake,
  sessionNoiseGate,
  shouldAutoRunSessionNoiseCheck,
  shouldShowSessionNoiseCheckDialog,
  shouldAutoStartAfterAccept,
  shouldContinueRetakeSequence,
  viewShortcutAction,
  workflowShortcutAction,
  workflowShortcutTargetAllowed,
} from './recording-workflow';
import { waveformTakeIsActive } from './waveform-buffer';
import { WebGLWaveform } from './WebGLWaveform';
import { PreviewPlayer } from './PreviewPlayer';
import { InputAuditionDialog } from './InputAuditionDialog';
import {
  inputAuditionConfiguration,
  logicalInputAuditionConfigurationKey,
} from './input-audition';
import { inputQualityWarning, shouldHandleLiveMeter } from './input-quality';
import {
  canFinishSpokenTake,
  displayedTakeEndSample,
  displayedTakeStartSample,
  itemSilenceMarks,
  liveHeadMsFromMeter,
  liveSilenceHint,
  liveSilencePair,
  liveSilenceProgress,
  recordedMonitorSentenceLabel,
  reviewSilencePair,
  shouldUseRecordedSilencePair,
  silenceReadoutClass,
  takeReviewPeak,
  type ItemSilenceMarks,
  type SilencePairView,
} from './silence-readout';
import {
  automationRulesEqual,
  loadAutomationRules,
  loadWorkstationAutomationRules,
  saveSessionAutomationRules,
  saveWorkstationAutomationRules,
  showsPostTakeQualityBill,
  skipSessionEnvCheck,
  type AutomationRules,
  type TaskDetectionPolicyKey,
} from './automation-rules.ts';
import {
  DEFAULT_DELIVERY_BIT_DEPTH,
  DELIVERY_BIT_DEPTHS,
  captureConfigurationSupported,
  captureSampleFormatFromBitDepth,
  captureSampleFormatLabel,
  captureSampleFormatsForConfiguration,
  captureShareModeLabel,
  captureShareModeForDevice,
  captureShareModeForSelection,
  classifyInputDevice,
  inputDeviceNeedsWarning,
  preferredInputDevice,
  productionSampleRates,
  configurationsForShareMode,
  deviceExclusiveAvailable,
  deliveryBitDepthLabel,
  normalizeCaptureSampleFormat,
  normalizeCaptureShareMode,
  preferredCaptureSampleFormat,
  type InputDeviceKind,
} from './capture-configuration';
import { createLatestFrameCommitter } from './latest-frame';
import type { LatestFrameCommitter } from './latest-frame';
import type { SessionNoiseCheckOperation } from './recording-workflow';
import { licenseSummary } from './ActivateLicense';
import { normalizeSilenceDetector, type Attempt, type AudioDevice, type CapturePreset, type CapturePresetDraft, type CapturePresetStore, type CaptureShareMode, type DeliveryBitDepth, type EngineEvent, type ExportArtifact, type ExportDeliveryProgress, type ExportDeliveryVerification, type ExportResult, type ExportScope, type HeadSilencePhase, type InputAuditionDecision, type InspectedSessionState, type ItemState, type LicenseStatus, type Meter, type NoiseCheckProgress, type NoiseCheckResult, type PrompterState, type RecordingHistoryEntry, type ScriptItem, type ScriptLabelTransition, type SealInterruptedSessionResult, type SessionSnapshot, type SilenceDetector } from './types';
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
import { captureActivationTarget, type CaptureActivationTarget } from './capture-activation';
import { LogPanel } from './LogPanel';
import { NoiseCheckDialog } from './NoiseCheckDialog';
import { APP_LOCALES, LOCALE_NATIVE_NAMES, getLocale, t, useI18n } from './i18n';
import { startDevWebCapture, type DevWebCaptureHandle } from './dev-web-capture';
import {
  MAX_PROMPTER_FONT_SIZE,
  MAX_PROMPTER_LABEL_FONT_SIZE,
  MIN_PROMPTER_FONT_SIZE,
  MIN_PROMPTER_LABEL_FONT_SIZE,
  prompterFontSizeRem,
  prompterLabelFontSizeRem,
} from './prompter-appearance';
import { PrompterFontSizeControl } from './PrompterFontSizeControl';
import { readerCueKey, readerFacingCue, resolveMonitorCue } from './prompter-cues';
import { usePrompterAppearance } from './usePrompterAppearance';
import {
  adjacentWorkbenchIssue,
  applyHeadTailWarningPreference,
  buildIssueWorkbench,
  deriveTaskWorkflow,
  filterWorkbenchIssues,
  isAttemptPreviewSafe,
  nextWorkbenchIssueAfterResolution,
  setupReadinessIssues,
  type IssueFilter,
  type WorkbenchIssue,
  type WorkflowReasonCode,
} from './p1-workflow';
import { loadWorkspaceContext, saveWorkspaceContext } from './workspace-context';

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
type CaptureStopDestination = 'home' | 'inspect';
type PauseDestination = 'stay' | 'leave';
type MonitorPanelTab = 'monitor' | 'detection' | 'settings' | 'task' | 'export' | 'issues';
type OptionalRunningSessionState = ({ active: true } & RunningSessionState) | { active: false };
type ExportFeedback = {
  sessionId: string;
  sessionDir: string;
  artifact: ExportArtifact;
  status: 'working' | 'ok' | 'preserved' | 'failed';
  output: string;
  exportDir?: string;
  filePath?: string;
  requestId?: string;
  progress?: ExportDeliveryProgress;
  warning?: string;
  error?: string;
};

const DIALOG_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function dialogFocusableElements(dialog: Element): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR))
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}
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
  silence_detector: 'vad',
  waveform: [],
};

function errorMessage(error: unknown): string {
  return userFacingEngineError(error);
}

function activationErrorCopy(kind: ClassifiedEngineError['kind']): { title: string; body: string } {
  switch (kind) {
    case 'input_access_denied':
      return { title: t('activationError.accessDeniedTitle'), body: t('activationError.accessDeniedBody') };
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

function detectionPolicySummary(rules: Pick<AutomationRules, 'envCheck' | 'discardEmpty'>): string {
  return t('setup.detectionSummary', {
    env: t('setup.detectionEnvState', { state: rules.envCheck ? t('setup.policyOn') : t('setup.policyOff') }),
    empty: t('setup.detectionEmptyState', { state: rules.discardEmpty ? t('setup.policyOn') : t('setup.policyOff') }),
  });
}

function DetectionPolicyFields(props: {
  rules: AutomationRules;
  envTestId: string;
  emptyTestId: string;
  onChange: (key: TaskDetectionPolicyKey, enabled: boolean) => void;
}) {
  return <>
    <AutomationRuleRow
      testId={props.envTestId}
      checked={props.rules.envCheck}
      title={t('recorder.ruleEnvCheck')}
      hint={t('recorder.ruleEnvCheckHint')}
      onChange={(enabled) => props.onChange('envCheck', enabled)}
    />
    <AutomationRuleRow
      testId={props.emptyTestId}
      checked={props.rules.discardEmpty}
      title={t('recorder.ruleDiscardEmpty')}
      hint={t('recorder.ruleDiscardEmptyHint')}
      onChange={(enabled) => props.onChange('discardEmpty', enabled)}
    />
  </>;
}

function DetectorSelectCards(props: {
  value: SilenceDetector;
  disabled?: boolean;
  locked?: boolean;
  onChange?: (value: SilenceDetector) => void;
}) {
  const { t } = useI18n();
  const inactive = Boolean(props.disabled || props.locked);
  const options: Array<{ id: SilenceDetector; title: string; hint: string }> = [
    { id: 'energy', title: t('recorder.detectorEnergy'), hint: t('recorder.detectorEnergyHint') },
    { id: 'vad', title: t('recorder.detectorVad'), hint: t('recorder.detectorVadHint') },
  ];
  return (
    <div className="detector-options" role="radiogroup" aria-label={t('recorder.detectorTitle')}>
      {options.map((option) => {
        const active = props.value === option.id;
        return (
          <button
            type="button"
            key={option.id}
            data-testid={`detector-${option.id}`}
            className={active ? 'active' : ''}
            role="radio"
            aria-checked={active}
            disabled={inactive}
            onClick={() => {
              if (inactive || !props.onChange || active) return;
              props.onChange(option.id);
            }}
          >
            <strong>{option.title}</strong>
            <small>{option.hint}</small>
          </button>
        );
      })}
    </div>
  );
}

function DeviceWarningDialog(props: {
  kind: InputDeviceKind;
  deviceName: string;
  busy: boolean;
  onContinue: () => void;
  onLeave: () => void;
}) {
  const { t } = useI18n();
  const copy = props.kind === 'rejected'
    ? t('deviceWarning.rejectedCopy', { name: props.deviceName || t('common.dash') })
    : t('deviceWarning.discouragedCopy', { name: props.deviceName || t('common.dash') });
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="studio-dialog device-warning-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="device-warning-title"
        data-testid="device-warning-dialog"
      >
        <header>
          <span className="dialog-icon warning"><Icon name="microphone" size={19} /></span>
          <div>
            <small>{t('deviceWarning.dialogKicker')}</small>
            <h2 id="device-warning-title">{t('deviceWarning.dialogTitle')}</h2>
          </div>
        </header>
        <p>{copy}</p>
        <div className="dialog-warning">{t('deviceWarning.warning')}</div>
        <footer>
          <button data-testid="device-warning-leave" className="button" onClick={props.onLeave} disabled={props.busy}>
            <Icon name="chevron-left" size={14} />
            {t('deviceWarning.leave')}
          </button>
          <button data-testid="device-warning-continue" data-dialog-default className="button primary" onClick={props.onContinue} disabled={props.busy}>
            {t('deviceWarning.continue')}
          </button>
        </footer>
      </section>
    </div>
  );
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
      <span><strong>{props.title}</strong><small>{props.hint}</small></span>
      <input
        type="checkbox"
        data-testid={props.testId}
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <i className="rule-switch" aria-hidden="true"><b /></i>
    </label>
  );
}

function RecordingRuleGroups(props: {
  rules: AutomationRules;
  testIdPrefix: string;
  discardEmptyHint: string;
  onChange: <Key extends keyof AutomationRules>(key: Key, enabled: AutomationRules[Key]) => void;
}) {
  const summary = !props.rules.autoStartNext
    ? t('recorder.continuousSummaryManual')
    : props.rules.pauseOnLabelChange
      ? t('recorder.continuousSummaryLabelPause')
      : t('recorder.continuousSummaryAll');
  const testId = (name: string) => `${props.testIdPrefix}-${name}`;
  return (
    <div className="recording-rule-groups">
      <section className="recording-rule-group continuous-rule-group">
        <header><strong>{t('recorder.continuousRecording')}</strong><small>{t('recorder.continuousRecordingHint')}</small></header>
        <AutomationRuleRow testId={testId('auto-start-next')} checked={props.rules.autoStartNext} title={t('recorder.ruleAutoStartNext')} hint={t('recorder.ruleAutoStartNextHint')} onChange={(enabled) => props.onChange('autoStartNext', enabled)} />
        <div className="dependent-rule">
          <AutomationRuleRow testId={testId('pause-on-label-change')} checked={props.rules.pauseOnLabelChange} disabled={!props.rules.autoStartNext} title={t('recorder.rulePauseOnLabelChange')} hint={props.rules.autoStartNext ? t('recorder.rulePauseOnLabelChangeHint') : t('recorder.rulePauseOnLabelChangeDisabledHint')} onChange={(enabled) => props.onChange('pauseOnLabelChange', enabled)} />
        </div>
        <p className="continuous-rule-summary"><i />{summary}</p>
      </section>
      <section className="recording-rule-group">
        <header><strong>{t('recorder.recordingProtection')}</strong><small>{t('recorder.recordingProtectionHint')}</small></header>
        <AutomationRuleRow testId={testId('enforce-head-tail')} checked={props.rules.enforceHeadTailSilence} title={t('recorder.ruleEnforceHeadTail')} hint={t('recorder.ruleEnforceHeadTailHint')} onChange={(enabled) => props.onChange('enforceHeadTailSilence', enabled)} />
        <AutomationRuleRow testId={testId('discard-empty')} checked={props.rules.discardEmpty} title={t('recorder.ruleDiscardEmpty')} hint={props.discardEmptyHint} onChange={(enabled) => props.onChange('discardEmpty', enabled)} />
        <AutomationRuleRow testId={testId('env-check')} checked={props.rules.envCheck} title={t('recorder.ruleEnvCheck')} hint={t('recorder.ruleEnvCheckHint')} onChange={(enabled) => props.onChange('envCheck', enabled)} />
      </section>
      <section className="recording-rule-group">
        <header><strong>{t('recorder.recordingFeedback')}</strong><small>{t('recorder.recordingFeedbackHint')}</small></header>
        <AutomationRuleRow testId={testId('head-tail')} checked={props.rules.headTailSilence} title={t('recorder.ruleHeadTail')} hint={t('recorder.ruleHeadTailHint')} onChange={(enabled) => props.onChange('headTailSilence', enabled)} />
        <AutomationRuleRow testId={testId('almost-silent')} checked={props.rules.almostSilent} title={t('recorder.ruleAlmostSilent')} hint={t('recorder.ruleAlmostSilentHint')} onChange={(enabled) => props.onChange('almostSilent', enabled)} />
        <AutomationRuleRow testId={testId('peak-high')} checked={props.rules.peakHigh} title={t('recorder.rulePeakHigh')} hint={t('recorder.rulePeakHighHint')} onChange={(enabled) => props.onChange('peakHigh', enabled)} />
      </section>
      <p className="recording-safety-note"><Icon name="check" size={12} />{t('recorder.dataProtectionAlwaysOn')}</p>
    </div>
  );
}

function SilencePairReadout({ pair, hint, testId }: { pair: SilencePairView; hint?: boolean; testId?: string }) {
  return <span className="silence-pair" data-testid={testId}>
    <span className={silenceReadoutClass(pair.headStatus)}>{pair.headText}</span>
    <span className={silenceReadoutClass(pair.tailStatus)}>{pair.tailText}</span>
    {pair.extra ? <span className="silence-readout note">{pair.extra}</span> : null}
    {hint && pair.hint ? <small className="silence-hint" title={pair.hint}>{pair.hint}</small> : null}
  </span>;
}

function ItemSilenceMarkPills({ marks }: { marks: ItemSilenceMarks }) {
  if (!marks.headShort && !marks.tailShort) return null;
  return <span className="item-silence-marks">
    {marks.headShort ? <i className="item-silence-mark">{t('silence.markHead')}</i> : null}
    {marks.tailShort ? <i className="item-silence-mark">{t('silence.markTail')}</i> : null}
  </span>;
}

function itemStatusMetaClass(status: string): string | undefined {
  if (status === 'accepted' || status === 'review' || status === 'skipped') return status;
  return undefined;
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

function latestReviewCandidate(item: ItemState): Attempt | undefined {
  for (let index = item.attempts.length - 1; index >= 0; index -= 1) {
    const attempt = item.attempts[index];
    if (attempt.status === 'recorded' && attempt.end_sample > attempt.start_sample) return attempt;
  }
  return undefined;
}

function preferredReviewAttemptId(item: ItemState | undefined): string | null {
  if (!item) return null;
  if (item.status === 'review') {
    const candidate = latestReviewCandidate(item);
    if (candidate) return candidate.attempt_id;
  }
  return item.selected_attempt_id ?? latestUsableAttempt(item)?.attempt_id ?? null;
}

function recordingState(
  recording: RecordingHistoryEntry,
  entry: TaskListEntry = planTaskListEntry(historyEntryWithTaskWarningPreference(recording)),
): { kind: RecordingStateKind; label: string } {
  if (recording.is_active && recording.status === 'stopping') {
    return { kind: 'attention', label: t('home.stateSafeStopping') };
  }
  if (recording.is_active) return { kind: 'unfinished', label: t('home.stateCurrent') };
  if (entry.kind === 'repair') return { kind: 'attention', label: t('home.stateInterrupted') };
  if (entry.kind === 'record' || entry.kind === 'issues') return { kind: 'unfinished', label: t('home.stateUnfinished') };
  if (entry.kind === 'export') return { kind: 'completed', label: t('p1.exportReady') };
  if (entry.kind === 'deliver') return { kind: 'unfinished', label: t('p1.deliveryVerification.pending') };
  if (entry.kind === 'delivered') return { kind: 'completed', label: t('p1.deliveryVerification.verified') };
  if (entry.kind === 'inspect') return { kind: 'attention', label: t('home.stateNeedsCheck') };
  return { kind: 'completed', label: t('home.stateCompleted') };
}

function historyEntryWithTaskWarningPreference(
  recording: RecordingHistoryEntry,
): RecordingHistoryEntry {
  if (loadAutomationRules(recording.session_dir).headTailSilence) return recording;
  const warningCodes = (recording.warning_codes ?? []).filter((code) => (
    code !== 'head_silence_short' && code !== 'tail_silence_short'
  ));
  if (warningCodes.length === (recording.warning_codes ?? []).length) return recording;
  const readiness = recording.complete_task_readiness;
  return {
    ...recording,
    warning_codes: warningCodes,
    warning_items: recording.warning_items_without_head_tail ?? recording.warning_items,
    complete_task_readiness: readiness ? {
      ...readiness,
      warning_count: warningCodes.length,
      health: readiness.blocker_count > 0
        ? 'blocked'
        : warningCodes.length > 0
          ? 'warning'
          : 'clear',
    } : readiness,
  };
}

function recordingMatchesFilter(recording: RecordingHistoryEntry, filter: HistoryFilter): boolean {
  if (filter === 'all') return true;
  const kind = recordingState(recording).kind;
  return filter === 'completed' ? kind === 'completed' : kind !== 'completed';
}

function preserveDeliveryVerification(
  next: RecordingHistoryEntry,
  previous: RecordingHistoryEntry | undefined,
): RecordingHistoryEntry {
  if (!previous?.delivery_verifications) return next;
  const verified = (Object.keys(previous.delivery_verifications) as ExportArtifact[]).reduce((result, artifact) => {
    if (previous.export_artifacts?.[artifact]?.export_id
      && previous.export_artifacts?.[artifact]?.export_id === next.export_artifacts?.[artifact]?.export_id) {
      result[artifact] = previous.delivery_verifications?.[artifact];
    }
    return result;
  }, {} as NonNullable<RecordingHistoryEntry['delivery_verifications']>);
  if (!Object.keys(verified).length) return next;
  const verifiedDeliveryDirectories = (Object.keys(verified) as ExportArtifact[]).reduce((result, artifact) => {
    const directory = previous.verified_delivery_directories?.[artifact];
    if (verified[artifact] === 'verified' && directory) result[artifact] = directory;
    return result;
  }, {} as NonNullable<RecordingHistoryEntry['verified_delivery_directories']>);
  return {
    ...next,
    delivery_verifications: verified,
    ...(Object.keys(verifiedDeliveryDirectories).length
      ? { verified_delivery_directories: verifiedDeliveryDirectories }
      : {}),
  };
}

function applyDeliveryVerification(
  recording: RecordingHistoryEntry,
  artifact: ExportArtifact,
  exportId: string,
  verification: ExportDeliveryVerification['verification'],
  directory?: string,
): RecordingHistoryEntry {
  if (recording.export_artifacts?.[artifact]?.export_id !== exportId) return recording;
  const deliveryVerifications = {
    ...(recording.delivery_verifications ?? {}),
    [artifact]: verification,
  };
  const verifiedDeliveryDirectories = {
    ...(recording.verified_delivery_directories ?? {}),
  };
  if (verification === 'verified' && directory?.trim()) {
    verifiedDeliveryDirectories[artifact] = directory;
  } else {
    delete verifiedDeliveryDirectories[artifact];
  }
  return {
    ...recording,
    delivery_verifications: deliveryVerifications,
    verified_delivery_directories: verifiedDeliveryDirectories,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('common.dash');
  return new Intl.DateTimeFormat(getLocale(), {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

function formatListDateTime(value: string): { date: string; time: string; full: string; dateTime: string } {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const dash = t('common.dash');
    return { date: dash, time: '', full: dash, dateTime: '' };
  }
  const datePart = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const timePart = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return {
    date: datePart,
    time: timePart,
    full: `${datePart} ${timePart}`,
    dateTime: date.toISOString(),
  };
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
  const delivery = state.export_id
    ? recording?.delivery_verifications?.[artifact] ?? state.delivery_verification ?? 'pending'
    : null;
  const withDelivery = (copy: string) => delivery
    ? `${copy} · ${t(`p1.deliveryVerification.${delivery}`)}`
    : copy;
  const cutsSummary = artifact === 'cuts_zip'
    && typeof state.exported_count === 'number'
    && typeof state.skipped_count === 'number'
    ? t('notice.exportedCuts', { count: state.exported_count, skipped: state.skipped_count })
    : '';
  const withCutsSummary = (copy: string) => withDelivery(cutsSummary ? `${copy} · ${cutsSummary}` : copy);
  if (state.state === 'stale') {
    return withCutsSummary(state.exported_at
      ? t('exportDialog.staleWithTime', { time: formatDateTime(state.exported_at) })
      : t('exportDialog.stale'));
  }
  if (state.state === 'failed') return state.message || t('exportDialog.failed');
  return withCutsSummary(state.exported_at
    ? t('exportDialog.currentWithTime', { time: formatDateTime(state.exported_at) })
    : t('exportDialog.current'));
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
  const [bitDepth, setBitDepth] = useState<DeliveryBitDepth>(DEFAULT_DELIVERY_BIT_DEPTH);
  const [captureShareMode, setCaptureShareMode] = useState<CaptureShareMode>('exclusive');
  const [sessionName, setSessionName] = useState(() => t('setup.defaultSessionName'));
  const [outputDir, setOutputDir] = useState('');
  const [scriptFile, setScriptFile] = useState('');
  const [scriptItems, setScriptItems] = useState<ScriptItem[]>([]);
  const [scriptErrors, setScriptErrors] = useState<string[]>([]);
  const [scriptPreview, setScriptPreview] = useState<ParseResult | null>(null);
  const [scriptPreviewOpen, setScriptPreviewOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [captureActive, setCaptureActive] = useState(false);
  const [inputAuditionDecision, setInputAuditionDecision] = useState<InputAuditionDecision | null>(null);
  const [inputAuditionOpen, setInputAuditionOpen] = useState(false);
  const [inputAuditionForce, setInputAuditionForce] = useState(false);
  const [inputAuditionDismissed, setInputAuditionDismissed] = useState(false);
  const [devWebCaptureEnabled, setDevWebCaptureEnabled] = useState(false);
  const [devWebCaptureNotice, setDevWebCaptureNotice] = useState('');
  const [workspaceFaulted, setWorkspaceFaulted] = useState(false);
  const [monitorPanelTab, setMonitorPanelTab] = useState<MonitorPanelTab>('monitor');
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('all');
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [prompterStatus, setPrompterStatus] = useState({ open: false, ready: false });
  const { appearance, nudgeFontSize, nudgeLabelFontSize } = usePrompterAppearance();
  const [sessionDir, setSessionDir] = useState('');
  const [waveformGeneration, setWaveformGeneration] = useState(0);
  const [reviewWaveformBins, setReviewWaveformBins] = useState<Array<[number, number]>>([]);
  const reviewWaveformRequestRef = useRef(0);
  const itemRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedItemRowRef = useRef<HTMLButtonElement | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [clearedLabelTransitionKey, setClearedLabelTransitionKey] = useState('');
  const [continuationLabelTransition, setContinuationLabelTransition] = useState<(
    ScriptLabelTransition & { targetItemId: string }
  ) | null>(null);
  const [recording, setRecording] = useState(false);
  const [attemptStartSample, setAttemptStartSample] = useState(0);
  const [attemptRecordingStartedSample, setAttemptRecordingStartedSample] = useState(0);
  const [reviewAttemptId, setReviewAttemptId] = useState<string | null>(null);
  const [retakeItemId, setRetakeItemId] = useState<string | null>(null);
  const [retakeSequenceActive, setRetakeSequenceActive] = useState(false);
  const [reviewPeak, setReviewPeak] = useState(0);
  const [discontinuityToast, setDiscontinuityToast] = useState('');
  const [automationRules, setAutomationRules] = useState<AutomationRules>(loadWorkstationAutomationRules);
  const [taskInitialAutomationRules, setTaskInitialAutomationRules] = useState<AutomationRules>(loadWorkstationAutomationRules);
  const [workstationRules, setWorkstationRules] = useState<AutomationRules>(loadWorkstationAutomationRules);
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
  const [silenceDetector, setSilenceDetector] = useState<SilenceDetector>('vad');
  const [silenceDetectorDraft, setSilenceDetectorDraft] = useState<SilenceDetector>('vad');
  const [deviceWarningKind, setDeviceWarningKind] = useState<InputDeviceKind | null>(null);
  const pendingNoiseCheckRef = useRef<{
    snapshot: SessionSnapshot;
    sessionDir: string;
    isNewActivation: boolean;
  } | null>(null);
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
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const [pauseConfirmOpen, setPauseConfirmOpen] = useState(false);
  const [pauseDestination, setPauseDestination] = useState<PauseDestination>('leave');
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
  const [exportScope, setExportScope] = useState<ExportScope>('confirmed_only');
  const [acknowledgedExportWarnings, setAcknowledgedExportWarnings] = useState<WorkflowReasonCode[]>([]);
  const [userAlert, setUserAlert] = useState<UserAlert | null>(null);
  const [activationFailure, setActivationFailure] = useState<ClassifiedEngineError | null>(null);
  const [activationFailureOpen, setActivationFailureOpen] = useState(false);
  const [recoveryShareMode, setRecoveryShareMode] = useState<CaptureShareMode>('exclusive');
  const [recoverySampleFormat, setRecoverySampleFormat] = useState('i16');
  const [deletingSessionDir, setDeletingSessionDir] = useState('');
  const [resettingSessionDir, setResettingSessionDir] = useState('');
  const [openActionsSessionDir, setOpenActionsSessionDir] = useState('');
  const [resumeError, setResumeError] = useState<{ sessionDir: string; message: string } | null>(null);
  const previewWaveformRequestRef = useRef(0);
  const sealOperationRef = useRef(false);
  const pauseOperationRef = useRef(false);
  const presetOperationRef = useRef(false);
  const noiseCheckActivationRef = useRef(0);
  const noiseCheckRequestSequenceRef = useRef(0);
  const noiseCheckOperationRef = useRef<SessionNoiseCheckOperation | null>(null);
  const silenceSettingsSaveSequenceRef = useRef(0);
  const workbenchIssueQueueRef = useRef<WorkbenchIssue[]>([]);
  const dialogFocusOriginRef = useRef<HTMLElement | null>(null);
  const discontinuityToastStateRef = useRef(initialDiscontinuityToastState());
  const inputAuditionDiscontinuityBaselineRef = useRef({ sessionDir: '', count: 0 });
  const inputAuditionConfigurationKeyRef = useRef('');
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
  const activeInputAuditionConfigurationKey = snapshot
    ? logicalInputAuditionConfigurationKey(inputAuditionConfiguration(snapshot))
    : '';
  const currentItem = items[currentIndex] ?? null;
  const workflowSummary = useMemo(() => applyHeadTailWarningPreference(deriveTaskWorkflow({
    items,
    committed_samples: snapshot?.committed_samples ?? 0,
    capture_provenance: snapshot?.capture_provenance,
    status: snapshot?.status,
    overflow_samples: snapshot?.overflow_samples,
    silence_detector: snapshot?.silence_detector,
    audio_format: snapshot?.audio_format,
  }), automationRules.headTailSilence), [automationRules.headTailSilence, items, snapshot?.audio_format, snapshot?.capture_provenance, snapshot?.committed_samples, snapshot?.overflow_samples, snapshot?.silence_detector, snapshot?.status]);
  // An active but idle capture can be exported through the existing
  // pause-then-export flow. Preview cuts against the exact current item/audio
  // state with only the status projected to the post-pause value; the command
  // still stops the engine and recomputes readiness from its authoritative
  // stopped snapshot before writing anything.
  const exportWorkflowSummary = useMemo(() => applyHeadTailWarningPreference(deriveTaskWorkflow({
    items,
    committed_samples: snapshot?.committed_samples ?? 0,
    capture_provenance: snapshot?.capture_provenance,
    status: captureActive && snapshot?.status === 'recording' ? 'stopped' : snapshot?.status,
    overflow_samples: snapshot?.overflow_samples,
    silence_detector: snapshot?.silence_detector,
    audio_format: snapshot?.audio_format,
  }), automationRules.headTailSilence), [automationRules.headTailSilence, captureActive, items, snapshot?.audio_format, snapshot?.capture_provenance, snapshot?.committed_samples, snapshot?.overflow_samples, snapshot?.silence_detector, snapshot?.status]);
  const currentWorkflow = workflowSummary.items[currentIndex] ?? null;
  const cutsReadiness = exportScope === 'complete_task'
    ? exportWorkflowSummary.completeTask
    : exportWorkflowSummary.confirmedOnly;
  const exportWarningsAcknowledged = cutsReadiness.warningCodes.every((code) => (
    acknowledgedExportWarnings.includes(code)
  ));
  const currentLabelTransition = useMemo(() => {
    if (!currentItem) return null;
    if (continuationLabelTransition?.targetItemId === currentItem.id) {
      return continuationLabelTransition;
    }
    return currentIndex > 0
      ? labelTransition(items[currentIndex - 1]?.label, currentItem.label)
      : null;
  }, [continuationLabelTransition, currentIndex, currentItem, items]);
  const currentLabelTransitionKey = currentLabelTransition?.changed
    ? `${currentItem?.id ?? currentIndex}:${currentLabelTransition.fromLabel}:${currentLabelTransition.toLabel}`
    : '';
  const showCurrentLabelTransition = Boolean(
    currentLabelTransition?.changed
    && currentLabelTransitionKey !== clearedLabelTransitionKey,
  );
  const rerecordCount = useMemo(
    () => items.filter((item) => itemRequiresRerecord(item)).length,
    [items],
  );
  const reviewCount = useMemo(
    () => items.filter((item) => item.status === 'review').length,
    [items],
  );
  const retainedPreviousWarningCount = useMemo(
    () => items.filter((item) => itemHasRetainedPreviousWarning(item)).length,
    [items],
  );
  const workspaceRecording = recordings.find((recording) => recording.session_dir === sessionDir);
  const selectedDevice = devices.find((device) => device.id === deviceId) ?? null;
  const selectedDeviceIsAsio = selectedDevice?.backend?.trim().toLocaleLowerCase('en-US') === 'asio';
  const sharedCaptureAvailable = configurationsForShareMode(selectedDevice, 'shared').length > 0;
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
    const candidates = productionSampleRates([...new Set([
      44_100, 48_000, 88_200, 96_000, 176_400, 192_000,
      ...fallbackRates,
      ...modeRates,
    ])]).sort((left, right) => left - right);
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
  const activationCaptureShareMode = captureShareModeForDevice(
    selectedDevice,
    normalizeCaptureShareMode(snapshot?.capture_share_mode ?? captureShareMode),
    exclusiveCaptureAvailable,
  );
  const activationRecoveryChanged = recoveryShareMode !== activationCaptureShareMode
    || normalizeCaptureSampleFormat(recoverySampleFormat) !== normalizeCaptureSampleFormat(
      snapshot?.input_sample_format ?? inputSampleFormat,
    );
  const activationRecoveryValid = captureConfigurationSupported(
    selectedDevice,
    recoveryShareMode,
    sampleRate,
    inputChannel,
    recoverySampleFormat,
  );
  const selectedDeviceKind = classifyInputDevice(selectedDevice);
  const selectedDeviceNeedsWarning = inputDeviceNeedsWarning(selectedDeviceKind);
  const captureConfigurationValid = captureConfigurationSupported(
    selectedDevice,
    captureShareMode,
    sampleRate,
    inputChannel,
    inputSampleFormat,
  );
  const captureConfigurationIssue = !deviceId
    ? t('setup.pickDevice')
    : !selectedDevice
      ? t('setup.presetDeviceUnavailable')
      : selectedDevice.production_blocked_reason
        ? selectedDevice.production_blocked_reason
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
  const acceptTargetIndex = currentItem?.status === 'review'
    ? findNextActionableItemIndex(items, currentIndex)
    : -1;
  const acceptTarget = acceptTargetIndex >= 0 ? items[acceptTargetIndex] : null;
  const acceptPausesForLabelChange = Boolean(
    automationRules.autoStartNext
    && automationRules.pauseOnLabelChange
    && currentItem
    && acceptTarget?.status === 'pending'
    && labelTransition(currentItem.label, acceptTarget.label).changed,
  );
  const acceptButtonLabel = finalReview || !automationRules.autoStartNext
    ? t('recorder.acceptThis')
    : acceptTarget?.status === 'review' || acceptPausesForLabelChange
      ? t('recorder.acceptAndReviewNext')
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
  const silenceActiveItemIndex = recording ? currentIndex : -1;
  const itemSilenceViews = useMemo(() => items.map((item, index) => (
    index === silenceActiveItemIndex
      ? { headShort: false, tailShort: false, title: '' }
      : itemSilenceMarks(item, sampleRateForDisplay, effectiveSilenceDurationMs, silenceDetector)
  )), [effectiveSilenceDurationMs, items, sampleRateForDisplay, silenceActiveItemIndex, silenceDetector]);
  const flaggedSilenceCount = itemSilenceViews.filter((marks) => marks.headShort || marks.tailShort).length;
  const captureFaultKind = effectiveCaptureFaultKind(phase === 'running' && captureActive, engineStatus, meter);
  const captureFault = captureFaultKind !== null;
  const itemBrowserRows = useMemo(() => items.map((item, index) => {
    const marks = itemSilenceViews[index] ?? { headShort: false, tailShort: false, title: '' };
    const flagged = marks.headShort || marks.tailShort;
    const statusClass = itemStatusMetaClass(item.status);
    const labelBoundary = isLabelBoundary(items, index);
    const requiresRerecord = itemRequiresRerecord(item);
    const retainedWarning = itemHasRetainedPreviousWarning(item);
    const normalizedLabel = item.label.trim();
    const labelValue = normalizedLabel || t('prompter.none');
    const accessibleParts = [
      item.id,
      item.text,
      t('recorder.itemLabelAria', { label: labelValue }),
      statusLabel(item.status),
      labelBoundary ? t('recorder.labelChanged') : '',
      requiresRerecord ? t('recorder.requiresRerecord') : '',
      retainedWarning ? t('recorder.retainedPreviousShort') : '',
    ].filter(Boolean).join('。');
    return <button
      key={item.id}
      ref={(node) => {
        if (node) itemRowRefs.current.set(item.id, node);
        else itemRowRefs.current.delete(item.id);
      }}
      className={`professional-item${item.status === 'skipped' ? ' skipped' : ''}${flagged ? ' has-silence-issue' : ''}${labelBoundary ? ' label-boundary' : ''}${requiresRerecord ? ' requires-rerecord' : ''}${retainedWarning ? ' retained-warning' : ''}`}
      disabled={recording || Boolean(captureFault)}
      tabIndex={-1}
      aria-label={accessibleParts}
      title={[marks.title, item.label].filter(Boolean).join(' · ') || undefined}
      onClick={(event) => {
        const previous = event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('.professional-item.active');
        if (previous && previous !== event.currentTarget) {
          previous.classList.remove('active');
          previous.removeAttribute('aria-current');
          previous.tabIndex = -1;
        }
        event.currentTarget.classList.add('active');
        event.currentTarget.setAttribute('aria-current', 'step');
        event.currentTarget.tabIndex = 0;
        event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        setRetakeSequenceActive(false);
        setCurrentIndex(index);
        setReviewAttemptId(null);
      }}
      onKeyDown={(event) => {
        const nextIndex = event.key === 'ArrowDown'
          ? Math.min(items.length - 1, index + 1)
          : event.key === 'ArrowUp'
            ? Math.max(0, index - 1)
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : -1;
        if (nextIndex < 0 || nextIndex === index) return;
        event.preventDefault();
        setRetakeSequenceActive(false);
        setCurrentIndex(nextIndex);
        setReviewAttemptId(null);
        window.requestAnimationFrame(() => itemRowRefs.current.get(items[nextIndex]?.id ?? '')?.focus());
      }}
    >
      <span className={`item-state ${item.status}`}>{item.status === 'accepted' ? <Icon name="check" size={12} /> : item.status === 'skipped' ? '—' : String(index + 1).padStart(2, '0')}</span>
      <span className="item-copy"><strong>{item.id}</strong><small>{item.text}</small></span>
      {normalizedLabel || labelBoundary ? <span className="item-label-line"><b>{labelBoundary ? t('recorder.labelChanged') : t('recorder.labelShort')}</b><em className="item-label-value" title={normalizedLabel || undefined}>{labelValue}</em></span> : null}
      <span className="item-meta">
        <em className={statusClass}><span className="item-current-flag"><i aria-hidden="true" />{t('recorder.currentSentence')}</span>{statusLabel(item.status)}</em>
        {requiresRerecord ? <i className="item-rerecord-mark">{t('recorder.requiresRerecord')}</i> : null}
        {retainedWarning ? <i className="item-retained-mark">{t('recorder.retainedPreviousShort')}</i> : null}
        <ItemSilenceMarkPills marks={marks} />
      </span>
    </button>;
  }), [captureFault, itemSilenceViews, items, locale, recording]);
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
  const displayedLiveSilenceMs = silenceDetector === 'vad'
    ? Math.min(liveSilenceMs, effectiveSilenceDurationMs)
    : liveSilenceMs;
  const tailSilenceMet = liveSilenceMs >= effectiveSilenceDurationMs;
  const liveTakeStartSample = displayedTakeStartSample({
    detector: silenceDetector,
    enforce: automationRules.enforceHeadTailSilence,
    recordingStartedSample: attemptRecordingStartedSample,
    headSilencePassedSample: meter.head_silence_passed_sample ?? 0,
    contentStartedSample: meter.content_started_sample ?? 0,
    padSamples: requiredSilenceSamples,
  });
  const liveTakeEndSample = displayedTakeEndSample({
    detector: silenceDetector,
    capturedSamples: meter.captured_samples,
    lastSpeechSample: Math.max(meter.last_signal_sample ?? 0, meter.content_started_sample ?? 0),
    padSamples: requiredSilenceSamples,
    startSample: liveTakeStartSample,
  });
  const enforceHeadTailSilence = automationRules.enforceHeadTailSilence;
  const canFinishTake = canFinishSpokenTake({
    enforce: enforceHeadTailSilence,
    pending: isPendingTake,
    spoken: Boolean(hasSpoken),
    tailMet: tailSilenceMet,
  });
  const waitingForTailSilence = Boolean(
    recording && enforceHeadTailSilence && hasSpoken && !tailSilenceMet,
  );
  const silenceProgress = liveSilenceProgress({
    pending: isPendingTake,
    spoken: Boolean(hasSpoken),
    pendingRemainingMs,
    liveSilenceMs: displayedLiveSilenceMs,
    requiredMs: effectiveSilenceDurationMs,
  });
  const reviewAttempt = !recording && currentItem
    ? (currentItem.status === 'review' ? latestReviewCandidate(currentItem) : undefined)
      ?? currentItem.attempts.find((attempt) => attempt.attempt_id === reviewAttemptId)
      ?? currentItem.attempts.find((attempt) => attempt.attempt_id === currentItem.selected_attempt_id)
      ?? latestUsableAttempt(currentItem)
    : undefined;
  const retainedDeliveryAttempt = currentItem?.selected_attempt_id
    ? currentItem.attempts.find((attempt) => attempt.attempt_id === currentItem.selected_attempt_id)
    : undefined;
  const retakeCandidateAttempt = !recording
    && currentItem?.status === 'review'
    && retainedDeliveryAttempt
    && reviewAttempt?.attempt_id !== retainedDeliveryAttempt.attempt_id
    ? reviewAttempt
    : undefined;
  const hasRetakeChoice = Boolean(
    currentItem?.status === 'review'
    && retainedDeliveryAttempt
    && retakeCandidateAttempt
    && retakeCandidateAttempt.attempt_id !== retainedDeliveryAttempt.attempt_id,
  );
  const hasRetakeDecision = Boolean(
    currentItem?.status === 'review'
    && (
      retakeItemId === currentItem.id
      || itemHasPendingRetakeDecision(currentItem)
      || hasRetakeChoice
    ),
  );
  const retakeSequenceReady = retakeSequenceActionReady(
    retakeSequenceActive,
    currentItem,
    hasRetakeDecision,
  );
  const hasRetainedPreviousWarning = Boolean(
    currentItem && itemHasRetainedPreviousWarning(currentItem),
  );
  const safeAttemptIds = useMemo(() => new Set(snapshot && currentWorkflow?.disposition !== 'inconsistent'
    ? (currentItem?.attempts ?? []).filter((attempt) => isAttemptPreviewSafe(attempt, snapshot)).map((attempt) => attempt.attempt_id)
    : []), [currentItem?.attempts, currentWorkflow?.disposition, snapshot]);
  const defaultAcceptAttemptId = retakeCandidateAttempt?.attempt_id
    ?? reviewAttemptId
    ?? currentItem?.selected_attempt_id
    ?? (currentItem ? latestUsableAttempt(currentItem)?.attempt_id : undefined);
  const defaultAcceptAttemptSafe = Boolean(
    defaultAcceptAttemptId && safeAttemptIds.has(defaultAcceptAttemptId),
  );
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
    detector: silenceDetector,
  });
  const retainedDeliveryPair = reviewSilencePair({
    attempt: retainedDeliveryAttempt,
    sampleRate: sampleRateForDisplay,
    requiredMs: effectiveSilenceDurationMs,
    peak: retainedDeliveryAttempt?.peak,
    showHeadTailHints: automationRules.headTailSilence,
    showAlmostSilent: automationRules.almostSilent,
    showPeakHigh: automationRules.peakHigh,
    detector: silenceDetector,
  });
  const retakeCandidatePair = reviewSilencePair({
    attempt: retakeCandidateAttempt,
    sampleRate: sampleRateForDisplay,
    requiredMs: effectiveSilenceDurationMs,
    peak: retakeCandidateAttempt?.attempt_id === reviewAttempt?.attempt_id
      ? reviewBillPeak
      : retakeCandidateAttempt?.peak,
    showHeadTailHints: automationRules.headTailSilence,
    showAlmostSilent: automationRules.almostSilent,
    showPeakHigh: automationRules.peakHigh,
    detector: silenceDetector,
  });
  const livePair = liveSilencePair({
    recording,
    pending: isPendingTake,
    spoken: Boolean(hasSpoken),
    pendingRemainingMs,
    requiredMs: effectiveSilenceDurationMs,
    liveSilenceMs: displayedLiveSilenceMs,
    headMs: liveHeadMsFromMeter({
      sampleRate: sampleRateForDisplay,
      armedSample: meter.head_silence_armed_sample || attemptRecordingStartedSample,
      contentStartedSample: meter.content_started_sample ?? 0,
      passedSample: meter.head_silence_passed_sample,
      requiredSamples: meter.required_head_silence_samples ?? requiredSilenceSamples,
      phase: meter.head_silence_phase,
      detector: silenceDetector,
    }),
  });
  const silencePair = shouldUseRecordedSilencePair(recording, reviewAttempt)
    ? reviewBillPair
    : livePair;
  const exitAction = captureExitAction(items, captureFault);
  const footerActions = inspectorFooterModel(captureActive, Boolean(captureFault));
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
  const persistedVadFaults = snapshot?.vad_diagnostics
    ? snapshot.vad_diagnostics.overflow_count
      + snapshot.vad_diagnostics.classifier_failure_count
      + snapshot.vad_diagnostics.flush_timeout_count
      + snapshot.vad_diagnostics.worker_disconnect_count
    : 0;
  // Cumulative diagnostics describe earlier isolated faults. Only the live
  // meter is authoritative for the current worker's health.
  const vadHealth = meter.vad_health ?? 'healthy';
  const vadBacklogMs = Math.round((meter.vad_backlog_samples ?? 0) / Math.max(sampleRateForDisplay, 1) * 1_000);
  const vadCapacityMs = Math.round((meter.vad_capacity_samples ?? sampleRateForDisplay) / Math.max(sampleRateForDisplay, 1) * 1_000);
  const workbenchIssues = useMemo(() => buildIssueWorkbench(workflowSummary, {
    captureFault,
    storageFault: workspaceFaulted || meter.overflow_samples > 0 || meter.storage_status !== 'healthy',
    inputDiscontinuity: Boolean(discontinuityWarning),
    vadHealth,
    vadDiagnosticFaultCount: persistedVadFaults,
  }), [captureFault, discontinuityWarning, meter.overflow_samples, meter.storage_status, persistedVadFaults, vadHealth, workflowSummary, workspaceFaulted]);
  const visibleWorkbenchIssues = useMemo(
    () => filterWorkbenchIssues(workbenchIssues, issueFilter),
    [issueFilter, workbenchIssues],
  );
  const selectedWorkbenchIssue = visibleWorkbenchIssues.find((issue) => issue.id === selectedIssueId) ?? null;
  // Live input-quality hints stay visible, but they are not workflow blockers.
  // Auto-opening the issue queue for one of these hints can select an older
  // sentence warning and pull currentIndex away from the engine's active item.
  const hasMonitorIssues = Boolean(qualityWarning || workbenchIssues.length > 0);
  const currentNoiseGate = sessionNoiseGate(snapshot?.noise_check, noiseCheckRunning, automationRules.envCheck);
  const noiseCheckBlocksAttempt = phase === 'running' && captureActive && !recording && currentNoiseGate !== 'ready';
  const inputAuditionBlocksAttempt = phase === 'running'
    && captureActive
    && !inputAuditionDecision;
  const inputAuditionStatusLabel = (captureActive
    ? inputAuditionDecision?.status
    : snapshot?.input_audition?.status) === 'confirmed'
    ? t('inputAudition.statusConfirmed')
    : (captureActive ? inputAuditionDecision?.status : snapshot?.input_audition?.status) === 'skipped'
      ? t('inputAudition.statusSkipped')
      : t('inputAudition.statusPending');
  const deviceWarningOpen = Boolean(deviceWarningKind) && captureActive && !captureFault;
  const entryOverlay = captureEntryOverlay({
    deviceWarningOpen,
    noiseCheckBlocksAttempt,
    hasCaptureFault: Boolean(captureFault),
    otherOverlayOpen: pauseConfirmOpen || finishConfirmOpen || inputAuditionOpen,
  });
  const showDeviceWarningDialog = entryOverlay === 'device-warning';
  const showNoiseCheckDialog = shouldShowSessionNoiseCheckDialog(
    noiseCheckBlocksAttempt,
    Boolean(captureFault),
    pauseConfirmOpen || finishConfirmOpen || showDeviceWarningDialog || inputAuditionOpen,
  );
  const activeDialogKey = logPanelOpen
    ? 'log'
    : activationFailureOpen && activationFailure
      ? 'activation-failure'
      : userAlert
        ? 'user-alert'
        : exportFeedback
          ? `export-feedback:${exportFeedback.status}`
          : settingsOpen
            ? 'settings'
            : deleteConfirmRecording
              ? 'delete'
              : resetConfirmRecording
                ? 'reset'
                : sealConfirmRecording
                  ? 'seal'
                  : exportRecording
                    ? 'export'
                    : inputAuditionOpen
                      ? 'input-audition'
                    : finishConfirmOpen
                      ? 'finish'
                      : previewOpen
                        ? 'preview'
                        : pauseConfirmOpen
                          ? 'pause'
                          : showNoiseCheckDialog
                            ? `noise-check:${noiseCheckRunning ? 'running' : currentNoiseGate}`
                            : showDeviceWarningDialog
                              ? 'device-warning'
                              : scriptPreviewOpen
                                ? 'script-preview'
                                : '';

  useEffect(() => {
    const previousIssues = workbenchIssueQueueRef.current;
    workbenchIssueQueueRef.current = visibleWorkbenchIssues;
    if (monitorPanelTab !== 'issues' || recording) return;
    const nextIssue = nextWorkbenchIssueAfterResolution(
      previousIssues,
      selectedIssueId,
      visibleWorkbenchIssues,
    );
    if (!nextIssue) {
      if (selectedIssueId) setSelectedIssueId(null);
      return;
    }
    if (nextIssue.id !== selectedIssueId) locateWorkbenchIssue(nextIssue);
  }, [monitorPanelTab, recording, selectedIssueId, visibleWorkbenchIssues]);
  const entryBlocksAttempt = noiseCheckBlocksAttempt
    || deviceWarningOpen
    || inputAuditionBlocksAttempt
    || inputAuditionOpen;
  const noiseLimitDbfs = snapshot?.noise_threshold_dbfs
    ?? snapshot?.noise_check?.threshold_dbfs
    ?? noiseThresholdDbfs;
  const noiseSamples = noiseCheckRunning
    ? noiseCheckSamples
    : (snapshot?.noise_check?.samples ?? noiseCheckSamples);
  const noiseCheckMessage = currentNoiseGate === 'checking'
    ? t('noise.checking', { current: noiseCheckProgress, total: NOISE_CHECK_STEPS })
    : currentNoiseGate === 'failed'
      ? snapshot?.noise_check?.fail_reason === 'bandwidth'
        ? t('noise.failedBandwidth')
        : t('noise.failed', { peak: snapshot?.noise_check?.maximum_dbfs.toFixed(1) ?? t('common.dash') })
      : currentNoiseGate === 'pending'
        ? noiseCheckError || t('noise.pending')
        : '';
  const entryBlockMessage = deviceWarningOpen
    ? t('deviceWarning.pendingCue')
    : noiseCheckBlocksAttempt
      ? noiseCheckMessage
      : inputAuditionBlocksAttempt || inputAuditionOpen
        ? t('inputAudition.pendingCue')
        : '';
  const normalCue = phase !== 'running' || !currentItem
    ? 'idle'
    : entryBlocksAttempt
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
    : entryBlocksAttempt
      ? entryBlockMessage
      : ({
    idle: phase === 'running' && currentItem ? t('cue.waitStart') : t('cue.waitTask'),
    checking: entryBlockMessage,
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
    text: workflowComplete || !currentItem ? t('recorder.scriptFinished') : currentItem.text,
    label: workflowComplete || !currentItem ? '' : currentItem.label ?? '',
    labelTransition: workflowComplete || !showCurrentLabelTransition
      ? null
      : currentLabelTransition,
    cue: readerCue,
    cueLabel: readerCueLabel,
    readerCueLabel,
    silenceProgress: isPendingTake ? silenceProgress : 0,
    silenceDurationMs: effectiveSilenceDurationMs,
    qualityWarning: '',
    itemDisposition: currentWorkflow?.disposition,
    recommendedAction: currentWorkflow?.recommendedAction,
    deliveryHealth: currentWorkflow?.deliveryHealth,
  }), [captureFault, cue, currentIndex, currentItem?.id, currentItem?.label, currentItem?.text, currentLabelTransition, currentWorkflow?.deliveryHealth, currentWorkflow?.disposition, currentWorkflow?.recommendedAction, effectiveSilenceDurationMs, isPendingTake, items.length, readerCue, readerCueLabel, sessionName, showCurrentLabelTransition, silenceProgress, snapshot?.session_id, t, workflowComplete]);

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

  function applyAutomationRules(next: AutomationRules) {
    const previous = automationRules;
    setAutomationRules(next);
    if (sessionDir) saveSessionAutomationRules(sessionDir, next);
    if (previous.enforceHeadTailSilence !== next.enforceHeadTailSilence && captureActive && !workspaceFaulted && !captureFault) {
      void window.recorder.request('set_silence_settings', {
        threshold_dbfs: snapshot?.silence_threshold_dbfs ?? noiseThresholdDbfs,
        silence_duration_ms: snapshot?.silence_duration_ms ?? silenceDurationMs,
        silence_detector: snapshot?.silence_detector ?? silenceDetector,
        enforce_silence: next.enforceHeadTailSilence,
      }).catch(() => undefined);
    }
    if (previous.envCheck === next.envCheck) return;
    if (!next.envCheck) {
      noiseCheckOperationRef.current = null;
      setNoiseCheckRunning(false);
      setNoiseCheckError('');
      return;
    }
    if (snapshot && !snapshot.noise_check?.passed && captureActive && !workspaceFaulted && !captureFault) {
      void runSessionNoiseCheck(sessionDir, snapshot);
    }
  }

  function applyAutomationRule<Key extends keyof AutomationRules>(key: Key, enabled: AutomationRules[Key]) {
    applyAutomationRules({ ...automationRules, [key]: enabled });
  }

  function restoreTaskAutomationRules() {
    applyAutomationRules({ ...taskInitialAutomationRules });
  }

  function skipCurrentSessionEnvCheck() {
    setAutomationRules(skipSessionEnvCheck(sessionDir, automationRules));
    noiseCheckOperationRef.current = null;
    setNoiseCheckRunning(false);
    setNoiseCheckError('');
  }

  function applyWorkstationAutomationRule<Key extends keyof AutomationRules>(key: Key, enabled: AutomationRules[Key]) {
    const next = { ...workstationRules, [key]: enabled };
    saveWorkstationAutomationRules(next);
    setWorkstationRules(next);
    if (!sessionDir) {
      setAutomationRules(next);
      setTaskInitialAutomationRules(next);
    }
  }

  function clearDeviceWarning() {
    pendingNoiseCheckRef.current = null;
    setDeviceWarningKind(null);
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

  function resetInputAuditionGate(required: boolean) {
    setInputAuditionDecision(null);
    setInputAuditionOpen(false);
    setInputAuditionForce(false);
    setInputAuditionDismissed(false);
    if (!required) {
      inputAuditionDiscontinuityBaselineRef.current = { sessionDir: '', count: 0 };
      inputAuditionConfigurationKeyRef.current = '';
    }
  }

  function openInputAudition(force = false) {
    if (!snapshot || !captureActive || recording || captureFault || workspaceFaulted) return;
    if (force) {
      // Retire both renderer and trusted-main decisions before the dialog can
      // be cancelled. Esc from a manual recheck must leave the gate closed.
      setInputAuditionDecision(null);
      void window.recorder.clearInputAuditionDecision(inputAuditionConfiguration(snapshot))
        .catch((caught) => setError(errorMessage(caught)));
    }
    setInputAuditionForce(force);
    setInputAuditionDismissed(false);
    setInputAuditionOpen(true);
  }

  function resolveInputAudition(
    decision: InputAuditionDecision,
    source: 'current' | 'startup-cache',
  ) {
    setInputAuditionDecision(decision);
    setInputAuditionOpen(false);
    setInputAuditionForce(false);
    setInputAuditionDismissed(false);
    if (source === 'current') {
      setNotice(decision.status === 'confirmed'
        ? t('inputAudition.confirmedNotice')
        : t('inputAudition.skippedNotice'));
      void refreshRecordings(outputDirRef.current);
    }
    logUserAction('ui.input_audition.resolved', decision.status === 'confirmed'
      ? '输入试听已确认'
      : '输入试听已明确跳过', {
      status: decision.status,
      source,
      session_id: snapshot?.session_id,
      capture_fingerprint: decision.captureFingerprint,
    });
  }

  function cancelInputAuditionGate() {
    setInputAuditionOpen(false);
    setInputAuditionForce(false);
    setInputAuditionDismissed(true);
    setNotice(t('inputAudition.cancelledNotice'));
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
      void refreshRecordings(outputDirRef.current);
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

  function beginCaptureEntrySequence(
    nextSnapshot: SessionSnapshot,
    targetSessionDir: string,
    isNewActivation: boolean,
  ) {
    const kind = classifyInputDevice({ name: nextSnapshot.device_name });
    if (inputDeviceNeedsWarning(kind)) {
      pendingNoiseCheckRef.current = {
        snapshot: nextSnapshot,
        sessionDir: targetSessionDir,
        isNewActivation,
      };
      setDeviceWarningKind(kind);
      clearSessionNoiseCheck(targetSessionDir);
      return;
    }
    pendingNoiseCheckRef.current = null;
    setDeviceWarningKind(null);
    activateSessionNoiseCheck(nextSnapshot, targetSessionDir, isNewActivation);
  }

  function acknowledgeDeviceWarning() {
    const pending = pendingNoiseCheckRef.current;
    pendingNoiseCheckRef.current = null;
    setDeviceWarningKind(null);
    if (pending) {
      activateSessionNoiseCheck(pending.snapshot, pending.sessionDir, pending.isNewActivation);
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

  function capturePresetTarget(preset: CapturePreset) {
    const device = devices.find((candidate) => candidate.id === preset.deviceId) ?? null;
    const inputFormat = normalizeCaptureSampleFormat(preset.inputSampleFormat)
      ?? captureSampleFormatFromBitDepth(preset.bitDepth);
    const shareMode = captureShareModeForDevice(
      device,
      normalizeCaptureShareMode(preset.captureShareMode),
      exclusiveCaptureAvailable,
    );
    if (!device || !captureConfigurationSupported(
      device,
      shareMode,
      preset.sampleRate,
      preset.inputChannel,
      inputFormat,
    )) return null;
    return { device, inputFormat, shareMode };
  }

  function applyCapturePreset(preset: CapturePreset): boolean {
    const target = capturePresetTarget(preset);
    if (!target) return false;
    setDeviceId(target.device.id);
    setDeviceName(target.device.name);
    setSampleRate(preset.sampleRate);
    setBitDepth(preset.bitDepth);
    setInputSampleFormat(target.inputFormat);
    setInputChannel(preset.inputChannel);
    setCaptureShareMode(target.shareMode);
    setSilenceDurationMs(preset.silenceDurationMs);
    setNoiseThresholdDbfs(preset.silenceThresholdDbfs);
    setPresetName(preset.name);
    return true;
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
      const preferred = preferredInputDevice(result.devices, result.default_device_id);
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
      bitDepth,
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
      if (selected && !capturePresetTarget(selected)) {
        setError(t('notice.presetDeviceInvalid'));
        setPresetWarning(t('setup.presetDeviceUnavailable'));
        return;
      }
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
      setRecordings((current) => result.recordings.map((recording) => preserveDeliveryVerification(
        recording,
        current.find((candidate) => candidate.session_dir === recording.session_dir),
      )));
      setHistoryNextOffset(result.next_offset);
      setError((current) => current.startsWith(t('notice.historyPrefix')) ? '' : current);
      void verifyHistoryCutsDeliveries(result.recordings, sequence);
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
      void verifyHistoryCutsDeliveries(result.recordings, sequence);
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
        resetInputAuditionGate(false);
        setCurrentIndex(0);
        setRecording(false);
        setAttemptStartSample(0);
        setAttemptRecordingStartedSample(0);
        setReviewAttemptId(null);
        setMeter(emptyMeter);
        clearAudioPreview();
        setFinishConfirmOpen(false);
        setPauseConfirmOpen(false);
        clearDeviceWarning();
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

  useLayoutEffect(() => {
    setClearedLabelTransitionKey('');
    setContinuationLabelTransition((transition) => (
      transition?.targetItemId === currentItem?.id ? transition : null
    ));
    const previousRow = selectedItemRowRef.current;
    const nextRow = phase === 'running' && currentItem
      ? itemRowRefs.current.get(currentItem.id) ?? null
      : null;
    if (previousRow && previousRow !== nextRow) {
      previousRow.classList.remove('active');
      previousRow.removeAttribute('aria-current');
      previousRow.tabIndex = -1;
    }
    if (!nextRow) {
      selectedItemRowRef.current = null;
      return;
    }
    nextRow.classList.add('active');
    nextRow.setAttribute('aria-current', 'step');
    nextRow.tabIndex = 0;
    nextRow.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    });
    selectedItemRowRef.current = nextRow;
  }, [currentIndex, currentItem?.id, itemBrowserRows, phase]);

  useEffect(() => {
    if (phase !== 'running' || !snapshot?.session_id) return;
    try {
      saveWorkspaceContext({
        sessionId: snapshot.session_id,
        currentItemId: currentItem?.id ?? null,
        issueFilter,
        panel: monitorPanelTab,
      });
    } catch {
      // Local workstation context is convenience state; task data never depends on it.
    }
  }, [currentItem?.id, issueFilter, monitorPanelTab, phase, snapshot?.session_id]);

  useEffect(() => {
    setAcknowledgedExportWarnings([]);
  }, [snapshot?.journal_seq, snapshot?.session_id]);

  useEffect(() => {
    setExportScope('confirmed_only');
    setSelectedIssueId(null);
  }, [snapshot?.session_id]);

  useEffect(() => window.recorder.onExportDeliveryProgress?.((progress) => {
    setExportFeedback((current) => current?.requestId === progress.request_id
      ? { ...current, progress }
      : current);
  }), []);

  useEffect(() => {
    if (monitorPanelTab !== 'export' || !workspaceRecording) return;
    const missing = (['full_track', 'timestamps_json', 'cuts_zip'] as const).filter((artifact) => (
      workspaceRecording.export_artifacts?.[artifact]?.export_id
      && !workspaceRecording.delivery_verifications?.[artifact]
    ));
    if (!missing.length) return;
    const delivery_verifications = { ...(workspaceRecording.delivery_verifications ?? {}) };
    for (const artifact of missing) delivery_verifications[artifact] = 'pending';
    const pending = { ...workspaceRecording, delivery_verifications };
    setRecordings((current) => current.map((recording) => (
      recording.session_dir === pending.session_dir ? pending : recording
    )));
    void verifyRecordingDeliveries(pending);
  }, [monitorPanelTab, workspaceRecording]);

  useEffect(() => {
    window.recorder.sendPrompterState(prompterState);
  }, [prompterState]);

  useEffect(() => {
    const loaded = loadAutomationRules(sessionDir);
    setAutomationRules(loaded);
    setTaskInitialAutomationRules(loaded);
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

  useEffect(() => {
    if (!captureActive || !sessionDir) return;
    const baseline = inputAuditionDiscontinuityBaselineRef.current;
    if (baseline.sessionDir !== sessionDir) {
      inputAuditionDiscontinuityBaselineRef.current = {
        sessionDir,
        count: discontinuityCount,
      };
      return;
    }
    if (discontinuityCount > baseline.count) {
      setInputAuditionDecision(null);
      setInputAuditionOpen(false);
      setInputAuditionDismissed(false);
      // Any newly observed input discontinuity invalidates a ready playback as
      // well as a cached decision. Reopen in forced mode so the dialog first
      // cancels the stale non-final check id instead of allowing confirmation.
      setInputAuditionForce(true);
      logUserAction('ui.input_audition.invalidated', '输入不连续已使本次启动的试听结果失效', {
        session_id: snapshot?.session_id,
        previous_count: baseline.count,
        current_count: discontinuityCount,
      }, 'warn');
    }
    inputAuditionDiscontinuityBaselineRef.current = {
      sessionDir,
      count: Math.max(baseline.count, discontinuityCount),
    };
  }, [captureActive, discontinuityCount, sessionDir, snapshot?.session_id]);

  useEffect(() => {
    if (!captureActive || !activeInputAuditionConfigurationKey) return;
    const previous = inputAuditionConfigurationKeyRef.current;
    if (previous && previous !== activeInputAuditionConfigurationKey) {
      setInputAuditionDecision(null);
      setInputAuditionOpen(false);
      setInputAuditionDismissed(false);
      setInputAuditionForce(true);
      logUserAction('ui.input_audition.invalidated', '采集配置变化已使输入试听结果失效', {
        session_id: snapshot?.session_id,
      }, 'warn');
    }
    inputAuditionConfigurationKeyRef.current = activeInputAuditionConfigurationKey;
  }, [activeInputAuditionConfigurationKey, captureActive, snapshot?.session_id]);

  useEffect(() => {
    if (!captureFault) return;
    setInputAuditionDecision(null);
    setInputAuditionOpen(false);
    setInputAuditionDismissed(false);
    setInputAuditionForce(false);
  }, [captureFault]);

  useEffect(() => {
    const canOpen = phase === 'running'
      && captureActive
      && !recording
      && !captureFault
      && !workspaceFaulted
      && !deviceWarningOpen
      && currentNoiseGate === 'ready'
      && !pauseConfirmOpen
      && !finishConfirmOpen
      && !settingsOpen
      && !logPanelOpen
      && !previewOpen
      && !exportRecording
      && !exportFeedback
      && !userAlert
      && !activationFailureOpen;
    if (inputAuditionBlocksAttempt
      && !inputAuditionDismissed
      && !inputAuditionOpen
      && canOpen) {
      setInputAuditionOpen(true);
    }
  }, [
    activationFailureOpen,
    captureActive,
    captureFault,
    currentNoiseGate,
    deviceWarningOpen,
    exportFeedback,
    exportRecording,
    finishConfirmOpen,
    inputAuditionBlocksAttempt,
    inputAuditionDismissed,
    inputAuditionOpen,
    logPanelOpen,
    pauseConfirmOpen,
    phase,
    previewOpen,
    recording,
    settingsOpen,
    userAlert,
    workspaceFaulted,
  ]);

  useEffect(() => () => {
    if (discontinuityToastTimerRef.current !== null) {
      window.clearTimeout(discontinuityToastTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!selectedDevice) return;
    setCaptureShareMode(captureShareModeForSelection(
      selectedDevice,
      selectedCapturePreset,
      exclusiveCaptureAvailable,
    ));
  }, [exclusiveCaptureAvailable, selectedCapturePreset, selectedDevice]);

  useEffect(() => {
    if (!captureFault || !pauseConfirmOpen) return;
    // A capture/connection fault invalidates the healthy pause promise. Move
    // an already-open back dialog onto the same fault-aware exit path used by
    // the main transport immediately.
    setPauseConfirmOpen(false);
    setFinishConfirmOpen(true);
  }, [captureFault, pauseConfirmOpen]);

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
    if (selectedCapturePreset && !applyCapturePreset(selectedCapturePreset)) {
      const presetDeviceStillPresent = devices.some((device) => device.id === selectedCapturePreset.deviceId);
      setCapturePresetStore((current) => ({ ...current, lastSelectedPresetId: null }));
      setPresetName('');
      setPresetWarning(t('setup.presetDeviceUnavailable'));
      if (presetDeviceStillPresent) {
        void window.recorder.setLastCapturePreset(null)
          .then(setCapturePresetStore)
          .catch((caught) => setError(`${t('notice.selectPresetPrefix')}${errorMessage(caught)}`));
      }
    }
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
    let localContext = null as ReturnType<typeof loadWorkspaceContext>;
    try {
      localContext = loadWorkspaceContext(nextSnapshot.session_id);
    } catch {
      // Restricted renderer storage falls back to the workflow-derived location.
    }
    const restoredIndex = resolveRunningItemIndex(
      nextSnapshot.items,
      current.active_attempt?.item_id,
      keepItemId ?? localContext?.currentItemId,
    );
    const restoredItem = nextSnapshot.items[restoredIndex];
    const authoritativeScriptPreview = scriptPreviewFromSnapshotItems(nextSnapshot.items);
    // A suspended renderer may still hold a healthy meter from the previous
    // engine/session generation. It must not overwrite this authoritative
    // recovery snapshot on the next animation frame.
    meterFrameCommitterRef.current?.invalidate();
    resetInputAuditionGate(true);
    inputAuditionDiscontinuityBaselineRef.current = {
      sessionDir: nextSessionDir,
      count: nextSnapshot.input_discontinuity_count ?? 0,
    };
    inputAuditionConfigurationKeyRef.current = logicalInputAuditionConfigurationKey(
      inputAuditionConfiguration(nextSnapshot),
    );
    setSnapshot(nextSnapshot);
    setCaptureActive(true);
    setWorkspaceFaulted(nextSnapshot.status === 'faulted' || nextSnapshot.overflow_samples > 0);
    if (wasRecovered) setWaveformGeneration((generation) => generation + 1);
    if (nextSessionDir) setSessionDir(nextSessionDir);
    setSessionName(nextSnapshot.session_id);
    setScriptFile(nextSnapshot.script_name ?? '');
    setScriptItems(authoritativeScriptPreview.items);
    setScriptPreview(authoritativeScriptPreview);
    setScriptPreviewOpen(false);
    setScriptErrors(authoritativeScriptPreview.errors);
    setDeviceId(nextSnapshot.device_id ?? availableDevices.find((device) => device.name === nextSnapshot.device_name)?.id ?? '');
    setDeviceName(nextSnapshot.device_name);
    setSampleRate(nextSnapshot.audio_format.sample_rate);
    setBitDepth(nextSnapshot.audio_format.bit_depth as DeliveryBitDepth);
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
    const detector = normalizeSilenceDetector(nextSnapshot.silence_detector);
    setSilenceDetector(detector);
    setSilenceDetectorDraft(detector);
    setSilenceSettingsError('');
    setRetakeItemId(restoredItem && (
      (current.active_attempt && restoredItem.status !== 'pending')
      || itemHasPendingRetakeDecision(restoredItem)
    ) ? restoredItem.id : null);
    setRetakeSequenceActive(false);
    setContinuationLabelTransition(null);
    if (localContext) {
      setIssueFilter(localContext.issueFilter);
      setMonitorPanelTab(localContext.panel);
    }
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
      silence_detector: detector,
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
    beginCaptureEntrySequence(nextSnapshot, nextSessionDir, wasRecovered);
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
    const authoritativeScriptPreview = scriptPreviewFromSnapshotItems(nextSnapshot.items);
    clearAudioPreview();
    meterFrameCommitterRef.current?.invalidate();
    resetInputAuditionGate(false);
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
    setScriptItems(authoritativeScriptPreview.items);
    setScriptPreview(authoritativeScriptPreview);
    setScriptPreviewOpen(false);
    setScriptErrors(authoritativeScriptPreview.errors);
    setDeviceId(nextSnapshot.device_id ?? '');
    setDeviceName(nextSnapshot.device_name);
    setSampleRate(nextSnapshot.audio_format.sample_rate);
    setBitDepth(nextSnapshot.audio_format.bit_depth as DeliveryBitDepth);
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
    const detector = normalizeSilenceDetector(nextSnapshot.silence_detector);
    setSilenceDetector(detector);
    setSilenceDetectorDraft(detector);
    setSilenceSettingsError('');
    setContinuationLabelTransition(null);
    let localContext = null as ReturnType<typeof loadWorkspaceContext>;
    try {
      localContext = loadWorkspaceContext(nextSnapshot.session_id);
    } catch {
      // Restricted renderer storage falls back to the workflow-derived location.
    }
    const inspectionIndex = resolveRunningItemIndex(nextSnapshot.items, null, localContext?.currentItemId);
    if (localContext) {
      setIssueFilter(localContext.issueFilter);
      setMonitorPanelTab(localContext.panel);
    }
    setCurrentIndex(inspectionIndex);
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
    const inspectionItem = nextSnapshot.items[inspectionIndex];
    setRetakeItemId(inspectionItem && itemHasPendingRetakeDecision(inspectionItem)
      ? inspectionItem.id
      : null);
    setRetakeSequenceActive(false);
    setReviewAttemptId(preferredReviewAttemptId(inspectionItem));
    setMeter({ ...emptyMeter, captured_samples: nextSnapshot.captured_samples, committed_samples: nextSnapshot.committed_samples, overflow_samples: nextSnapshot.overflow_samples });
    clearDeviceWarning();
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

  function stageScriptPreview(fileName: string, parsed: ParseResult) {
    setScriptFile(fileName);
    setSessionName(fileName.replace(/\.[^.]+$/, '') || t('setup.newSessionName'));
    setScriptItems(parsed.errors.length ? [] : parsed.items);
    setScriptPreview(parsed);
    setScriptPreviewOpen(false);
    setScriptErrors(parsed.errors);
    logUserAction(
      parsed.errors.length ? 'ui.import_script.invalid' : 'ui.import_script',
      parsed.errors.length ? `脚本 ${fileName} 需要修正` : `已导入脚本 ${fileName}`,
      {
        name: fileName,
        items: parsed.items.length,
        errors: parsed.errors.slice(0, 8),
        warnings: parsed.warnings.slice(0, 8),
        mode: parsed.mode,
      },
      parsed.errors.length ? 'warn' : 'info',
    );
    setNotice(parsed.errors.length
      ? t('notice.scriptNeedsFix')
      : t('notice.importedItems', { count: parsed.items.length }));
  }

  async function chooseScript() {
    const file = await window.recorder.openScript();
    if (!file) return;
    stageScriptPreview(file.name, parseScript(file.content, file.name));
  }

  async function chooseScriptFile(file: File | undefined) {
    if (!file) return;
    stageScriptPreview(file.name, parseScript(await file.text(), file.name));
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

  async function applyTaskSilenceSettings(
    thresholdValue: number,
    durationValue: number,
  ) {
    const threshold = Math.min(-12, Math.max(-72, Math.round(thresholdValue)));
    const durationMs = Math.min(5_000, Math.max(200, Math.round(durationValue / 100) * 100));
    const detector = silenceDetector;
    setSilenceThresholdDraftDbfs(threshold);
    setSilenceDurationDraftMs(durationMs);
    setSilenceDetectorDraft(detector);
    if (!snapshot || !captureActive || workspaceFaulted || captureFault
      || (threshold === noiseThresholdDbfs && durationMs === silenceDurationMs && detector === silenceDetector)) return;
    const request = ++silenceSettingsSaveSequenceRef.current;
    setSilenceSettingsSaving(true);
    setSilenceSettingsError('');
    try {
      const result = await window.recorder.request<{
        threshold_dbfs: number;
        silence_duration_ms: number;
        silence_detector?: SilenceDetector;
        reset_kind: 'idle' | 'head_silence' | 'tail_silence';
        snapshot: SessionSnapshot;
      }>('set_silence_settings', {
        threshold_dbfs: threshold,
        silence_duration_ms: durationMs,
        silence_detector: detector,
        enforce_silence: automationRules.enforceHeadTailSilence,
      });
      if (request !== silenceSettingsSaveSequenceRef.current) return;
      setSnapshot(result.snapshot);
      void refreshRecordings(outputDirRef.current);
      setNoiseThresholdDbfs(result.threshold_dbfs);
      setSilenceDurationMs(result.silence_duration_ms);
      setSilenceThresholdDraftDbfs(result.threshold_dbfs);
      setSilenceDurationDraftMs(result.silence_duration_ms);
      const appliedDetector = normalizeSilenceDetector(result.silence_detector ?? detector);
      setSilenceDetector(appliedDetector);
      setSilenceDetectorDraft(appliedDetector);
      setMeter((previous) => ({
        ...previous,
        silence_threshold_dbfs: result.threshold_dbfs,
        silence_duration_ms: result.silence_duration_ms,
        silence_detector: appliedDetector,
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
    items?: ScriptItem[];
    scriptName?: string;
    activateAfterCreate?: boolean;
  }): Promise<boolean> {
    const requestedShareMode = options?.captureShareMode ?? captureShareMode;
    const nextShareMode = captureShareModeForDevice(
      selectedDevice,
      requestedShareMode,
      exclusiveCaptureAvailable,
    );
    const nextSampleFormat = options?.inputSampleFormat ?? inputSampleFormat;
    const nextItems = options?.items ?? scriptItems;
    const nextScriptName = options?.scriptName ?? scriptFile;
    const nextBitDepth = bitDepth;
    if (options?.captureShareMode || nextShareMode !== captureShareMode) setCaptureShareMode(nextShareMode);
    if (options?.inputSampleFormat) setInputSampleFormat(nextSampleFormat);
    const nextConfigurationValid = captureConfigurationSupported(
      selectedDevice,
      nextShareMode,
      sampleRate,
      inputChannel,
      nextSampleFormat,
    );
    if (!nextItems.length
      || (options?.items === undefined && scriptErrors.length > 0)
      || !selectedDevice
      || !outputDir
      || !nextConfigurationValid) {
      if (selectedDevice?.production_blocked_reason) {
        setError(selectedDevice.production_blocked_reason);
      } else if (!nextConfigurationValid) {
        setError(t('setup.comboUnsupported', {
          mode: captureShareModeLabel(nextShareMode),
          rate: sampleRate.toLocaleString(locale),
          channel: inputChannel,
        }));
      } else if (captureConfigurationIssue) {
        setError(captureConfigurationIssue);
      }
      return false;
    }
    const sessionId = `${safeSessionName(sessionName.replace(/-\d{8}-\d{6}$/, ''))}-${timestamp()}`;
    const destination = await window.recorder.joinPath(outputDir, sessionId);
    const result = await run(t('notice.creatingTask'), () => window.recorder.request<InspectedSessionState>('create_session', {
      session_dir: destination,
      session_id: sessionId,
      script_name: nextScriptName,
      device_id: selectedDevice.id,
      device_name: selectedDevice.name,
      sample_rate: sampleRate,
      bit_depth: nextBitDepth,
      input_sample_format: nextSampleFormat,
      input_channel: inputChannel,
      capture_share_mode: nextShareMode,
      capture_buffer_frames: selectedDevice.recommended_buffer_frames,
      silence_duration_ms: silenceDurationMs,
      noise_threshold_dbfs: noiseThresholdDbfs,
      silence_threshold_dbfs: noiseThresholdDbfs,
      silence_detector: silenceDetector,
      items: nextItems,
    }));
    if (!result) return false;
    setDataSafetyAlert('');
    logUserAction('ui.create_session', `已创建录制任务 ${sessionId}`, {
      session_id: sessionId,
      session_dir: destination,
      script_name: nextScriptName,
      device_id: selectedDevice.id,
      device_name: selectedDevice.name,
      sample_rate: sampleRate,
      bit_depth: nextBitDepth,
      input_sample_format: nextSampleFormat,
      input_channel: inputChannel,
      capture_backend: selectedDevice.backend,
      capture_buffer_frames: selectedDevice.recommended_buffer_frames,
      item_count: nextItems.length,
      env_check: automationRules.envCheck,
      discard_empty: automationRules.discardEmpty,
    });
    saveSessionAutomationRules(destination, automationRules);
    enterInspectionWorkspace(result);
    setNotice(options?.activateAfterCreate ? t('activationError.recreatedNotice') : t('notice.taskCreated'));
    if (options?.activateAfterCreate) {
      return activateCapture(undefined, captureActivationTarget(
        result,
        devices,
      ));
    }
    return true;
  }

  function presentActivationFailure(error: unknown, target?: CaptureActivationTarget) {
    const classified = classifyEngineError(error);
    const activationSnapshot = target?.snapshot ?? snapshot;
    const activationDevice = target ? target.device : selectedDevice;
    const activationShareMode = captureShareModeForDevice(
      activationDevice,
      normalizeCaptureShareMode(activationSnapshot?.capture_share_mode ?? captureShareMode),
      exclusiveCaptureAvailable,
    );
    const activationSampleRate = activationSnapshot?.audio_format.sample_rate ?? sampleRate;
    const activationInputChannel = activationSnapshot?.audio_format.input_channel ?? inputChannel;
    const activationInputSampleFormat = activationSnapshot
      ? normalizeCaptureSampleFormat(activationSnapshot.input_sample_format)
        ?? captureSampleFormatFromBitDepth(activationSnapshot.audio_format.bit_depth)
      : inputSampleFormat;
    const sharedRecoveryAvailable = configurationsForShareMode(activationDevice, 'shared').length > 0;
    const requestedRecoveryMode = classified.canEditCaptureSettings
      && exclusiveCaptureAvailable
      && sharedRecoveryAvailable
      ? 'shared'
      : activationShareMode;
    const nextRecoveryMode = captureShareModeForDevice(
      activationDevice,
      requestedRecoveryMode,
      exclusiveCaptureAvailable,
    );
    const recoveryFormats = captureSampleFormatsForConfiguration(
      configurationsForShareMode(activationDevice, nextRecoveryMode),
      activationSampleRate,
      activationInputChannel,
    );
    const normalizedCurrentFormat = normalizeCaptureSampleFormat(activationInputSampleFormat);
    setActivationFailure(classified);
    setActivationFailureOpen(classified.canEditCaptureSettings || classified.kind === 'input_access_denied');
    setRecoveryShareMode(nextRecoveryMode);
    setRecoverySampleFormat(normalizedCurrentFormat && recoveryFormats.includes(normalizedCurrentFormat)
      ? normalizedCurrentFormat
      : preferredCaptureSampleFormat(recoveryFormats) ?? activationInputSampleFormat);
  }

  async function activateCapture(
    keepItemId?: string | null,
    target?: CaptureActivationTarget,
  ): Promise<boolean> {
    const dir = target?.sessionDir || sessionDir;
    const targetWorkspaceFaulted = target ? target.blocked : workspaceFaulted;
    if (!dir || captureActive || targetWorkspaceFaulted) return captureActive;
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
      void refreshRecordings(outputDirRef.current);
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
      presentActivationFailure(caught, target);
      return false;
    } finally {
      setBusy('');
    }
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
    const sourceItems = snapshot?.items.map(({ id, text, label }) => ({ id, text, label }))
      ?? scriptItems;
    const created = await startSession({
      captureShareMode: recoveryShareMode,
      inputSampleFormat: recoverySampleFormat,
      items: sourceItems,
      scriptName: snapshot?.script_name ?? scriptFile,
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
    void refreshRecordings(outputDirRef.current);
    return result.snapshot;
  }

  async function startAttempt(
    item = currentItem,
    options: {
      acknowledgeLabelTransition?: boolean;
      beginRetakeSequence?: boolean;
      allowAfterSealedTake?: boolean;
    } = {},
  ) {
    if (!item || (recording && !options.allowAfterSealedTake) || phase !== 'running' || captureFault || !captureActive) return false;
    if (deviceWarningKind || currentNoiseGate !== 'ready' || !inputAuditionDecision || inputAuditionOpen) {
      if (!deviceWarningKind && currentNoiseGate === 'ready' && !inputAuditionOpen) {
        openInputAudition(false);
      }
      return false;
    }
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
    }>('start_attempt', {
      item_id: item.id,
      enforce_silence: automationRules.enforceHeadTailSilence,
    }));
    if (!result) return false;
    if (
      options.beginRetakeSequence
      && (item.status === 'accepted' || item.status === 'skipped')
    ) {
      setRetakeSequenceActive(true);
    }
    setRetakeItemId(item.status === 'pending' ? null : item.id);
    if (
      options.acknowledgeLabelTransition !== false
      && item.id === currentItem?.id
      && currentLabelTransitionKey
    ) {
      setClearedLabelTransitionKey(currentLabelTransitionKey);
    }
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
    void refreshRecordings(outputDirRef.current);
    setNotice(t('notice.startedWait', { id: item.id, seconds: (effectiveSilenceDurationMs / 1_000).toFixed(1) }));
    return true;
  }

  async function stopAttempt(forceOverride?: boolean): Promise<boolean> {
    if (!recording) return true;
    if (!currentItem) return false;
    const cancelingPendingTake = isPendingTake;
    const force = forceOverride ?? (isPendingTake || !hasSpoken || !enforceHeadTailSilence);
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
      enforce_silence: enforceHeadTailSilence,
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
      let latest: SessionSnapshot | null = null;
      try {
        latest = await refreshState();
      } catch (caught) {
        setError(`${t('notice.jitterRefreshPrefix')}${errorMessage(caught)}`);
        return true;
      }
      const latestItem = latest?.items.find((item) => item.id === currentItem.id);
      if (latest && retakeItemId === currentItem.id && latestItem && itemHasRetainedPreviousWarning(latestItem)) {
        const nextIndex = nextPhysicalItemIndex(currentIndex, latest.items.length);
        const nextItem = latest.items[nextIndex];
        setRetakeItemId(null);
        moveToAutomaticTarget(currentItem, nextItem, nextIndex);
        setRetakeSequenceActive(shouldContinueRetakeSequence(
          retakeSequenceActive,
          currentIndex,
          nextIndex,
          nextItem,
        ));
        setNotice(nextIndex === currentIndex
          ? t('notice.retakeKeptPreviousLast')
          : t('notice.retakeKeptPreviousNext'));
        return true;
      }
      if (!latest) {
        setNotice(t('notice.jitterRetake'));
        return true;
      }
      const nextIndex = nextPhysicalItemIndex(currentIndex, latest.items.length);
      if (nextIndex === currentIndex) {
        setNotice(t('notice.jitterLastItem'));
        return true;
      }
      const nextItem = latest.items[nextIndex];
      const nextLabelTransition = moveToAutomaticTarget(currentItem, nextItem, nextIndex)
        ?? labelTransition(currentItem.label, nextItem.label);
      setRetakeItemId(null);
      setRetakeSequenceActive(false);
      const autoStartsNext = nextItem.status === 'pending' && shouldAutoStartAfterAccept(
        { kind: 'start', nextIndex },
        {
          autoStartNext: automationRules.autoStartNext,
          pauseOnLabelChange: automationRules.pauseOnLabelChange,
          labelChanged: nextLabelTransition.changed,
        },
      );
      const started = autoStartsNext
        ? await startAttempt(nextItem, {
          acknowledgeLabelTransition: false,
          allowAfterSealedTake: true,
        })
        : false;
      setNotice(started
        ? t('notice.jitterMovedAndStarted', { id: nextItem.id })
        : t('notice.jitterMovedNext', { id: nextItem.id }));
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

  function moveToAutomaticTarget(
    sourceItem: ItemState,
    targetItem: ItemState | undefined,
    targetIndex: number,
  ) {
    if (!targetItem || targetIndex < 0) return null;
    const transition = labelTransition(sourceItem.label, targetItem.label);
    setContinuationLabelTransition(sourceItem.id === targetItem.id ? null : {
      ...transition,
      targetItemId: targetItem.id,
    });
    setCurrentIndex(targetIndex);
    return transition;
  }

  function moveToNext(snapshotValue: SessionSnapshot) {
    const next = findNextActionableItemIndex(snapshotValue.items, currentIndex);
    if (next >= 0) {
      if (currentItem) moveToAutomaticTarget(currentItem, snapshotValue.items[next], next);
      else setCurrentIndex(next);
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

  function locateNextRerecord() {
    const nextIndex = findNextRerecordIndex(items, currentIndex);
    if (nextIndex < 0) return;
    setRetakeSequenceActive(false);
    setCurrentIndex(nextIndex);
    setReviewAttemptId(null);
    window.requestAnimationFrame(() => {
      itemRowRefs.current.get(items[nextIndex]?.id ?? '')?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    });
    setNotice(t('notice.locatedRerecord', {
      id: items[nextIndex]?.id ?? String(nextIndex + 1),
      count: rerecordCount,
    }));
  }

  function locateWorkbenchIssue(issue: WorkbenchIssue, wrapped = false) {
    if (recording) return;
    setSelectedIssueId(issue.id);
    setMonitorPanelTab('issues');
    if (issue.itemIndex !== null && items[issue.itemIndex]) {
      setRetakeSequenceActive(false);
      setCurrentIndex(issue.itemIndex);
      setReviewAttemptId(preferredReviewAttemptId(items[issue.itemIndex]));
    }
    setNotice(wrapped ? t('p1.issueWrapped') : t('p1.issueLocated'));
  }

  function moveWorkbenchIssue(direction: 1 | -1) {
    const next = adjacentWorkbenchIssue(visibleWorkbenchIssues, selectedIssueId, direction);
    if (next.issue) locateWorkbenchIssue(next.issue, next.wrapped);
  }

  async function acceptAttempt(
    targetAttemptId?: string,
    options: { autoStartNext?: boolean } = {},
  ) {
    // This is deliberately repeated behind the disabled button / shortcut
    // gates: a fault event may arrive after a click was queued but before the
    // handler executes.
    if (captureFault || !currentItem || currentItem.status !== 'review' || recording) return;
    const retainedAttemptId = currentItem.selected_attempt_id;
    const retakeCandidateId = retakeCandidateAttempt?.attempt_id;
    const isRetakeDecision = hasRetakeDecision;
    const attemptId = targetAttemptId
      ?? retakeCandidateId
      ?? reviewAttemptId
      ?? currentItem.selected_attempt_id
      ?? latestUsableAttempt(currentItem)?.attempt_id;
    if (!attemptId || !currentItem.attempts.some((attempt) => attempt.attempt_id === attemptId)) return;
    if (!safeAttemptIds.has(attemptId)) return;
    const accepted = await run(t('notice.savingAccept'), () => window.recorder.request('accept_attempt', {
      item_id: currentItem.id,
      attempt_id: attemptId,
    }));
    if (!accepted) return;
    const latest = await refreshState();
    setReviewAttemptId(null);
    setRetakeItemId(null);
    if (!latest) return;
    if (isRetakeDecision) {
      const nextIndex = nextPhysicalItemIndex(currentIndex, latest.items.length);
      const nextItem = latest.items[nextIndex];
      if (nextIndex >= 0) moveToAutomaticTarget(currentItem, nextItem, nextIndex);
      setRetakeSequenceActive(shouldContinueRetakeSequence(
        retakeSequenceActive,
        currentIndex,
        nextIndex,
        nextItem,
      ));
      const keptPrevious = attemptId === retainedAttemptId;
      setNotice(nextIndex === currentIndex
        ? t(keptPrevious ? 'notice.retakeKeptPreviousLast' : 'notice.retakeUsedCandidateLast')
        : t(keptPrevious ? 'notice.retakeKeptPreviousNext' : 'notice.retakeUsedCandidateNext'));
      return;
    }
    const continuation = continuationAfterAccept(latest.items, currentIndex);
    if (continuation.kind === 'start') {
      const nextItem = latest.items[continuation.nextIndex];
      const nextLabelTransition = moveToAutomaticTarget(
        currentItem,
        nextItem,
        continuation.nextIndex,
      ) ?? labelTransition(currentItem.label, nextItem.label);
      const autoStartsNext = options.autoStartNext !== false && shouldAutoStartAfterAccept(continuation, {
        autoStartNext: automationRules.autoStartNext,
        pauseOnLabelChange: automationRules.pauseOnLabelChange,
        labelChanged: nextLabelTransition.changed,
      });
      if (autoStartsNext) {
        await startAttempt(nextItem, { acknowledgeLabelTransition: false });
      } else {
        setNotice(
          nextLabelTransition.changed && automationRules.pauseOnLabelChange
            ? t('notice.labelChangedBeforeStart')
            : t('notice.acceptedReady'),
        );
      }
    } else if (continuation.kind === 'review') {
      moveToAutomaticTarget(currentItem, latest.items[continuation.nextIndex], continuation.nextIndex);
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
    if (captureFault
      || !currentItem
      || !['pending', 'review'].includes(currentItem.status)
      || recording
      || inputAuditionOpen
      || !inputAuditionDecision) return;
    const skipped = await run(t('notice.savingSkip'), () => window.recorder.request('skip_item', { item_id: currentItem.id }));
    if (!skipped) return;
    setRetakeSequenceActive(false);
    const latest = await refreshState();
    setReviewAttemptId(null);
    setRetakeItemId(null);
    if (latest) moveToNext(latest);
  }

  function closePreviewPlayer() {
    clearAudioPreview();
  }

  function clearAudioPreview() {
    previewWaveformRequestRef.current += 1;
    setPreviewOpen(false);
    setPreviewBins([]);
    setAudioUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return '';
    });
  }

  async function previewAttempt(targetAttemptId?: string) {
    if (!currentItem || recording) return;
    const attemptId = targetAttemptId
      ?? reviewAttempt?.attempt_id
      ?? reviewAttemptId
      ?? currentItem.selected_attempt_id
      ?? latestUsableAttempt(currentItem)?.attempt_id;
    if (!attemptId) return;
    const targetAttempt = currentItem.attempts.find((attempt) => attempt.attempt_id === attemptId);
    if (!targetAttempt || !snapshot || !isAttemptPreviewSafe(targetAttempt, snapshot)) {
      showUserAlert('warning', t('p1.previewBlockedTitle'), t('p1.previewBlockedBody'));
      return;
    }
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
    setPreviewBins((current) => current.length ? current : reusedBins);
    setPreviewOpen(true);
    setNotice(t('notice.previewing'));
  }

  async function openHistoricalRecording(
    recording: RecordingHistoryEntry,
    options: { activate?: boolean; panel?: 'issues' | 'export' } = {},
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
    if (options.panel === 'issues') {
      setIssueFilter('all');
      setSelectedIssueId(null);
    }
    if (options.panel) setMonitorPanelTab(options.panel);
    if (options.activate) {
      await activateCapture(undefined, captureActivationTarget(
        inspected,
        devices,
      ));
    }
  }

  async function exportRecordingArtifact(
    task: Pick<RecordingHistoryEntry, 'session_id' | 'session_dir'>,
    artifact: ExportArtifact,
    cutsScope: ExportScope = exportScope,
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
    let pausedSnapshot: SessionSnapshot | null = null;
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
      pausedSnapshot = stopped.snapshot;
      enterInspectionWorkspace({ snapshot: stopped.snapshot, session_dir: task.session_dir, mode: 'inspect' });
    }
    let sourceSnapshot = pausedSnapshot ?? (snapshot && sessionDir === task.session_dir ? snapshot : null);
    if (artifact === 'cuts_zip' && !sourceSnapshot) {
      const inspected = await run(t('notice.openingTask'), () => window.recorder.request<InspectedSessionState>('inspect_session', {
        session_dir: task.session_dir,
      }));
      sourceSnapshot = inspected?.snapshot ?? null;
    }
    const exportRequest: Record<string, unknown> = {
      session_dir: task.session_dir,
      expected_session_id: task.session_id,
      artifact,
    };
    if (artifact === 'cuts_zip') {
      if (!sourceSnapshot || typeof sourceSnapshot.journal_seq !== 'number') {
        failExport(t('p1.revisionUnavailable'));
        return;
      }
      const workflow = deriveTaskWorkflow(sourceSnapshot);
      const rawReadiness = workflow[cutsScope === 'complete_task'
        ? 'completeTask'
        : 'confirmedOnly'];
      const readiness = applyHeadTailWarningPreference(
        workflow,
        automationRules.headTailSilence,
      )[cutsScope === 'complete_task'
        ? 'completeTask'
        : 'confirmedOnly'];
      if (!readiness.ready) {
        failExport(t('p1.exportBlockedSummary', { count: readiness.blockers.length }));
        return;
      }
      const missingWarning = readiness.warningCodes.find((code) => !acknowledgedExportWarnings.includes(code));
      if (missingWarning) {
        failExport(t('p1.exportAcknowledgeFirst'));
        return;
      }
      const acknowledgedWarningCodes = new Set(
        acknowledgedExportWarnings.filter((code) => rawReadiness.warningCodes.includes(code)),
      );
      if (!automationRules.headTailSilence) {
        for (const code of rawReadiness.warningCodes) {
          if (code === 'head_silence_short' || code === 'tail_silence_short') {
            acknowledgedWarningCodes.add(code);
          }
        }
      }
      Object.assign(exportRequest, {
        scope: cutsScope,
        expected_journal_seq: sourceSnapshot.journal_seq,
        acknowledged_warning_codes: [...acknowledgedWarningCodes],
      });
    }
    const exported = await run(t('notice.exportingFiles'), () => window.recorder.request<ExportResult>('export_session_artifact', {
      ...exportRequest,
    }));
    if (!exported) {
      failExport(lastOperationErrorRef.current || t('exportDialog.resultFailedGeneric'));
      return;
    }
    const sourceFile = artifactFilePath(artifact, exported);
    let deliveredDir = exported.export_dir;
    let deliveredFile = sourceFile;
    let deliveryVerified = false;
    let copyWarning = '';
    // Empty means "keep the canonical task export only". External delivery is
    // an explicit, separately verified operation and must never copy back into
    // the task's own export directory.
    const destination = exportDestination;
    if (destination) {
      if (!sourceFile) {
        copyWarning = t('p1.exportSourceMissingForDelivery');
      } else if (!exported.export_id) {
        copyWarning = t('p1.exportGenerationMissing');
      } else {
        const requestId = typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `delivery-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        setExportFeedback((current) => current ? { ...current, requestId } : current);
      const delivered = await run(t('notice.copyingExport'), () => (
          window.recorder.deliverExportArtifact({
            request_id: requestId,
            session_id: task.session_id,
            artifact,
            export_id: exported.export_id!,
            destination_dir: destination,
          })
      ));
      if (!delivered) {
        copyWarning = translateExportDeliverError(lastOperationErrorRef.current || t('exportDialog.copyFailed'));
      } else {
        deliveredDir = delivered.directory;
        deliveredFile = delivered.file_path;
        deliveryVerified = delivered.verification === 'verified';
        if (!deliveryVerified) copyWarning = t('p1.deliveryVerificationFailed');
      }
      }
    }
    const warning = recoveryWarning(t('notice.exportStorage'), exported.recovery_warnings);
    if (warning) setDataSafetyAlert(t('notice.exportSpotCheck', { warning }));
    const output = artifactOutputCopy(artifact, exported);
    const externalDeliveryFailed = Boolean(destination) && !deliveryVerified;
    setNotice(externalDeliveryFailed
      ? t('p1.deliveryPreservedNotice', { id: task.session_id })
      : t('notice.exported', {
        id: task.session_id,
        output,
        note: warning ? t('notice.exportNeedCheck') : '',
      }));
    const dialogWarning = [
      warning ? `${t('exportDialog.spotCheck')}\n${warning}` : '',
      copyWarning,
    ].filter(Boolean).join('\n');
    setExportFeedback({
      sessionId: task.session_id,
      sessionDir: task.session_dir,
      artifact,
      status: externalDeliveryFailed ? 'preserved' : 'ok',
      output,
      exportDir: deliveredDir,
      filePath: deliveredFile,
      warning: dialogWarning || undefined,
    });
    await refreshRecordings();
    if (deliveryVerified && exported.export_id && deliveredDir) {
      setRecordings((current) => current.map((recording) => recording.session_id === task.session_id
        ? applyDeliveryVerification(recording, artifact, exported.export_id!, 'verified', deliveredDir)
        : recording));
    }
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

  async function cancelExportDelivery() {
    const requestId = exportFeedback?.requestId;
    if (!requestId) return;
    await window.recorder.cancelExportDelivery(requestId).catch(() => undefined);
    setNotice(t('p1.deliveryCancelRequested'));
  }

  function showExport(recording: RecordingHistoryEntry) {
    const pending = { ...(recording.delivery_verifications ?? {}) };
    for (const artifact of ['full_track', 'timestamps_json', 'cuts_zip'] as const) {
      if (recording.export_artifacts?.[artifact]?.export_id) pending[artifact] = 'pending';
    }
    const next = { ...recording, delivery_verifications: pending };
    setExportRecording(next);
    setRecordings((current) => current.map((candidate) => (
      candidate.session_dir === next.session_dir ? next : candidate
    )));
    void verifyRecordingDeliveries(next);
  }

  async function verifyHistoryCutsDeliveries(
    loadedRecordings: readonly RecordingHistoryEntry[],
    historySequence: number,
  ) {
    // Home only derives its delivered state from the complete-task cuts ZIP.
    // Verify these receipts sequentially so startup never hashes large full
    // tracks or creates an I/O storm across a long task history.
    for (const recording of loadedRecordings) {
      if (historySequence !== historyLoadSequenceRef.current) return;
      const cuts = recording.export_artifacts?.cuts_zip;
      if (cuts?.state !== 'current' || !cuts.export_id) continue;
      let result: ExportDeliveryVerification | null = null;
      let failed = false;
      try {
        result = await window.recorder.verifyExportDelivery({
          session_id: recording.session_id,
          artifact: 'cuts_zip',
          export_id: cuts.export_id,
        });
      } catch {
        failed = true;
      }
      if (historySequence !== historyLoadSequenceRef.current) return;
      const status = failed ? 'invalid' : result?.verification ?? 'missing';
      const resultMatches = !result || (
        result.session_id === recording.session_id
        && result.artifact === 'cuts_zip'
        && result.export_id === cuts.export_id
      );
      setRecordings((current) => current.map((candidate) => (
        candidate.session_dir === recording.session_dir
          ? applyDeliveryVerification(
            candidate,
            'cuts_zip',
            cuts.export_id!,
            resultMatches ? status : 'invalid',
            resultMatches ? result?.directory : undefined,
          )
          : candidate
      )));
    }
  }

  async function verifyRecordingDeliveries(recording: RecordingHistoryEntry) {
    const checks = (['full_track', 'timestamps_json', 'cuts_zip'] as const).flatMap((artifact) => {
      const exportId = recording.export_artifacts?.[artifact]?.export_id;
      if (!exportId) return [];
      return [window.recorder.verifyExportDelivery({
        session_id: recording.session_id,
        artifact,
        export_id: exportId,
      }).then((result) => ({ artifact, exportId, result, failed: false }))
        .catch(() => ({ artifact, exportId, result: null, failed: true }))];
    });
    if (!checks.length) return;
    const verified = await Promise.all(checks);
    const apply = (candidate: RecordingHistoryEntry) => {
      if (candidate.session_dir !== recording.session_dir) return candidate;
      return verified.reduce((next, verification) => {
        const resultMatches = !verification.result || (
          verification.result.session_id === recording.session_id
          && verification.result.artifact === verification.artifact
          && verification.result.export_id === verification.exportId
        );
        const status = verification.failed
          ? 'invalid'
          : resultMatches
            ? verification.result?.verification ?? 'missing'
            : 'invalid';
        return applyDeliveryVerification(
          next,
          verification.artifact,
          verification.exportId,
          status,
          resultMatches ? verification.result?.directory : undefined,
        );
      }, candidate);
    };
    setRecordings((current) => current.map(apply));
    setExportRecording((current) => current ? apply(current) : current);
  }

  function showTaskDetails(recording: RecordingHistoryEntry) {
    setOpenActionsSessionDir('');
    void openHistoricalRecording(recording);
  }

  function showTaskIssues(recording: RecordingHistoryEntry) {
    setOpenActionsSessionDir('');
    void openHistoricalRecording(recording, { panel: 'issues' });
  }

  function showTaskExportReview(recording: RecordingHistoryEntry) {
    setOpenActionsSessionDir('');
    void openHistoricalRecording(recording, { panel: 'export' });
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

  async function openVerifiedRecordingDelivery(recording: RecordingHistoryEntry) {
    const target = recording.verified_delivery_directories?.cuts_zip;
    if (!target) {
      // Never substitute the task's internal export directory for a verified
      // external handoff. A stale row returns to explicit verification.
      showExport(recording);
      return;
    }
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

  function openPauseConfirm(destination: PauseDestination) {
    setPauseDestination(destination);
    setPauseConfirmOpen(true);
  }

  function finishSession() {
    if (!sessionDir) return;
    if (!captureActive) {
      leaveInspectionWorkspace();
      return;
    }
    if (captureFault) {
      setPauseConfirmOpen(false);
      setFinishConfirmOpen(true);
      return;
    }
    // Leave-task never borrows the finish-capture dialog, even after every
    // sentence is handled. The completion ritual belongs to the main button.
    openPauseConfirm('leave');
  }

  function requestFinishCapture() {
    if (!sessionDir || !captureActive || busy) return;
    if (captureExitDialog(recording, captureFault, exitAction) !== 'finish') return;
    setPauseConfirmOpen(false);
    setFinishConfirmOpen(true);
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
      openPauseConfirm('leave');
    }
  }

  function requestPauseCapture() {
    if (phase !== 'running' || busy || !sessionDir || !captureActive) return;
    if (captureFault) {
      setPauseConfirmOpen(false);
      setFinishConfirmOpen(true);
      return;
    }
    openPauseConfirm('stay');
  }

  function leaveInspectionWorkspace() {
    clearAudioPreview();
    resetInputAuditionGate(false);
    setPhase('home');
    setSnapshot(null);
    setSessionDir('');
    setCaptureActive(false);
    setWorkspaceFaulted(false);
    clearDeviceWarning();
    setMonitorPanelTab('monitor');
    setRecording(false);
    setCurrentIndex(0);
    setReviewAttemptId(null);
    setRetakeSequenceActive(false);
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

  function stayInPausedWorkspace(stopped: StoppedSessionState, keepItemId?: string) {
    const nextSnapshot = stopped.snapshot;
    clearAudioPreview();
    resetInputAuditionGate(false);
    meterFrameCommitterRef.current?.invalidate();
    setResumeError(null);
    setSealConfirmRecording(null);
    setSnapshot(nextSnapshot);
    setRecording(false);
    setCaptureActive(false);
    const faulted = Boolean(
      stopped.reconciled_inactive_after_error
      || nextSnapshot.status === 'faulted'
      || nextSnapshot.overflow_samples > 0,
    );
    setWorkspaceFaulted(faulted);
    setAttemptStartSample(0);
    setAttemptRecordingStartedSample(0);
    const keepIndex = keepItemId
      ? nextSnapshot.items.findIndex((item) => item.id === keepItemId)
      : -1;
    const nextIndex = keepIndex >= 0
      ? keepIndex
      : resolveRunningItemIndex(nextSnapshot.items, null, keepItemId);
    setContinuationLabelTransition(null);
    setCurrentIndex(nextIndex);
    const item = nextSnapshot.items[nextIndex];
    setRetakeItemId(item && itemHasPendingRetakeDecision(item) ? item.id : null);
    setReviewAttemptId(preferredReviewAttemptId(item));
    setMeter({
      ...emptyMeter,
      captured_samples: nextSnapshot.captured_samples,
      committed_samples: nextSnapshot.committed_samples,
      overflow_samples: nextSnapshot.overflow_samples,
    });
    clearDeviceWarning();
    clearSessionNoiseCheck();
    setWaveformGeneration((generation) => generation + 1);
    setFinishConfirmOpen(false);
    setPauseConfirmOpen(false);
  }

  async function safeStopAndReturn(mode: CaptureExitMode, destination: CaptureStopDestination = 'home') {
    if (pauseOperationRef.current || phase !== 'running' || !sessionDir || !snapshot) return;
    pauseOperationRef.current = true;
    setPauseConfirmOpen(false);
    setFinishConfirmOpen(false);
    const faultAtRequest = mode === 'fault' || captureFault;
    const stayInTask = destination === 'inspect';
    const keepItemId = currentItem?.id;
    const keepItemIndex = currentIndex;
    const attemptCountBeforeStop = currentItem?.attempts.length ?? 0;
    const stoppingRetake = Boolean(
      recording
      && currentItem
      && (
        retakeItemId === currentItem.id
        || itemHasPendingRetakeDecision(currentItem)
        || currentItem.status !== 'pending'
      )
    );
    try {
      const stopped = await executeSafePause<StoppedSessionState>({
        // A capture fault seals an active take as interrupted inside
        // stop_session. Do not issue a forbidden attempt mutation first.
        hasActiveAttempt: recording && !faultAtRequest,
        closeActiveAttempt: () => stopAttempt(true),
        stopSession: () => stopSessionWithReconciliation(
          stayInTask
            ? mode === 'finish' ? t('notice.finishSealingStay') : t('notice.pauseSealingStay')
            : mode === 'pause' ? t('notice.pauseSealing') : t('notice.finishSealing'),
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
      const stayAfterStop = shouldStayInTaskAfterStop(destination, mode, stoppedWithFault);
      const warning = recoveryWarning(mode === 'pause' ? t('notice.pauseWarning') : t('notice.finishWarning'), stopped.warnings);
      if (stayAfterStop) {
        const keepAfterStopIndex = selectionIndexAfterStoppedRetake(
          stopped.snapshot.items,
          keepItemIndex,
          stoppingRetake,
          attemptCountBeforeStop,
        );
        const keepAfterStop = keepAfterStopIndex >= 0
          ? stopped.snapshot.items[keepAfterStopIndex]?.id
          : keepItemId;
        stayInPausedWorkspace(stopped, keepAfterStop);
      } else {
        clearAudioPreview();
        meterFrameCommitterRef.current?.invalidate();
        setResumeError(null);
        setSealConfirmRecording(null);
        setPhase('home');
        clearDeviceWarning();
        clearSessionNoiseCheck();
        setSnapshot(null);
        setSessionDir('');
        resetInputAuditionGate(false);
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
      }
      setRetakeSequenceActive(false);
      logUserAction('ui.safe_stop', stayAfterStop
        ? mode === 'finish' ? '已安全结束并进入查看模式' : '已安全暂停并留在当前任务'
        : mode === 'pause' ? '已安全暂停并返回任务列表' : '已安全结束并返回任务列表', {
        mode,
        destination,
        fault: Boolean(stoppedWithFault),
        reconciled: Boolean(stopped.reconciled_inactive_after_error),
      });
      if (stopped.reconciled_inactive_after_error) {
        raiseDataSafetyAlert('已确认录音引擎不再采集，但本任务尚未安全收尾；请立即执行“检查并修复”，再继续录制或导出。');
        setNotice(stayAfterStop ? '采集已暂停，当前任务需要修复。' : '已返回任务列表，当前任务需要修复。');
      } else if (stoppedWithFault) {
        raiseDataSafetyAlert('采集故障已结束：原始母轨和故障证据已保留，请在任务列表先执行“检查并修复”。');
        setNotice(stayAfterStop ? '采集已暂停，已落盘母轨仍保留；当前任务需要修复。' : '故障任务已返回列表，已落盘母轨仍保留。');
      } else if (mode === 'pause') {
        if (warning) raiseDataSafetyAlert(`${warning}。已落盘母音频仍已封存，继续前请抽检。`);
        else setDataSafetyAlert('');
        setNotice(stayAfterStop ? t('notice.pausedSafeStay') : t('notice.pausedSafe'));
      } else {
        if (warning) raiseDataSafetyAlert(`${warning}。原始母轨已封存，请抽检。`);
        else setDataSafetyAlert('');
        setNotice(stayAfterStop ? t('notice.captureFinishedStay') : t('notice.captureFinished'));
      }
      await refreshRecordings();
    } catch (caught) {
      showBlockingError(t('notice.stayRetry', { error: `${t('notice.stopFailedPrefix')}${errorMessage(caught)}` }));
    } finally {
      pauseOperationRef.current = false;
    }
  }

  async function safePauseAndReturn() {
    await safeStopAndReturn(captureFault ? 'fault' : 'pause', pauseDestination === 'stay' ? 'inspect' : 'home');
  }

  async function confirmFinishSession() {
    if ((recording && !captureFault) || !sessionDir) return;
    await safeStopAndReturn(
      captureFault ? 'fault' : 'finish',
      captureFault ? 'home' : 'inspect',
    );
  }

  function resetForNewSession() {
    clearAudioPreview();
    resetInputAuditionGate(false);
    meterFrameCommitterRef.current?.invalidate();
    setResumeError(null);
    setSealConfirmRecording(null);
    setDeleteConfirmRecording(null);
    setOpenActionsSessionDir('');
    setPhase('setup');
    clearDeviceWarning();
    clearSessionNoiseCheck();
    setSnapshot(null);
    setSessionDir('');
    setCaptureActive(false);
    setWorkspaceFaulted(false);
    setRecording(false);
    setAttemptStartSample(0);
    setAttemptRecordingStartedSample(0);
    setReviewAttemptId(null);
    setRetakeSequenceActive(false);
    setMeter(emptyMeter);
    setFinishConfirmOpen(false);
    setPauseConfirmOpen(false);
    clearActivationFailure();
    setNotice(t('notice.reuseScript'));
  }

  function beginNewRecording() {
    resetForNewSession();
    const presetApplied = selectedCapturePreset ? applyCapturePreset(selectedCapturePreset) : false;
    if (!presetApplied) {
      const nextShareMode = captureShareModeForDevice(
        selectedDevice,
        deviceExclusiveAvailable(selectedDevice) ? 'exclusive' : 'shared',
        exclusiveCaptureAvailable,
      );
      const configurations = configurationsForShareMode(selectedDevice, nextShareMode);
      const availableRates = productionSampleRates([...new Set([
        44_100,
        48_000,
        ...configurations.flatMap((configuration) => [
          configuration.min_sample_rate,
          configuration.max_sample_rate,
        ]),
      ])]).filter((rate) => configurations.some((configuration) => (
        configuration.channels >= 1
        && rate >= configuration.min_sample_rate
        && rate <= configuration.max_sample_rate
      ))).sort((left, right) => left - right);
      const nextSampleRate = availableRates.includes(48_000)
        ? 48_000
        : availableRates[0] ?? 48_000;
      const formats = captureSampleFormatsForConfiguration(configurations, nextSampleRate, 1);
      setCaptureShareMode(nextShareMode);
      setSampleRate(nextSampleRate);
      setBitDepth(DEFAULT_DELIVERY_BIT_DEPTH);
      setInputChannel(1);
      setInputSampleFormat(preferredCaptureSampleFormat(formats) ?? formats[0] ?? 'i16');
      if (selectedCapturePreset) {
        const presetDeviceStillPresent = devices.some((device) => device.id === selectedCapturePreset.deviceId);
        setCapturePresetStore((current) => ({ ...current, lastSelectedPresetId: null }));
        setPresetName('');
        setPresetWarning(t('setup.presetDeviceUnavailable'));
        if (presetDeviceStillPresent) {
          void window.recorder.setLastCapturePreset(null).then(setCapturePresetStore).catch(() => undefined);
        }
      }
    }
    setScriptFile('');
    setScriptItems([]);
    setScriptErrors([]);
    setScriptPreview(null);
    setScriptPreviewOpen(false);
    setSessionName(t('setup.newSessionName'));
    setSilenceDetector('vad');
    setSilenceDetectorDraft('vad');
    logUserAction('ui.new_recording', '开始新建录制');
    setNotice(t('notice.pickScriptToStart'));
  }

  function returnToRecordings() {
    clearAudioPreview();
    resetInputAuditionGate(false);
    meterFrameCommitterRef.current?.invalidate();
    setResumeError(null);
    setSealConfirmRecording(null);
    setDeleteConfirmRecording(null);
    setOpenActionsSessionDir('');
    clearActivationFailure();
    setPhase('home');
    clearDeviceWarning();
    clearSessionNoiseCheck();
    setSnapshot(null);
    setSessionDir('');
    setRecording(false);
    setAttemptStartSample(0);
    setAttemptRecordingStartedSample(0);
    setReviewAttemptId(null);
    setRetakeSequenceActive(false);
    setMeter(emptyMeter);
    setFinishConfirmOpen(false);
    setPauseConfirmOpen(false);
    setNotice(t('notice.historyRefreshed'));
    unbindTaskLog('return_home');
    logUserAction('ui.return_home', '已返回任务列表');
    void refreshRecordings();
  }

  useLayoutEffect(() => {
    if (!activeDialogKey) {
      const origin = dialogFocusOriginRef.current;
      dialogFocusOriginRef.current = null;
      if (origin?.isConnected) window.requestAnimationFrame(() => origin.focus());
      return undefined;
    }
    if (!dialogFocusOriginRef.current) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !active.closest('[role="dialog"][aria-modal="true"]')) {
        dialogFocusOriginRef.current = active;
      }
    }
    const frame = window.requestAnimationFrame(() => {
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return;
      if (dialog.getAttribute('aria-busy') === 'true') {
        dialog.tabIndex = -1;
        dialog.focus();
        return;
      }
      const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial]:not([disabled])')
        ?? dialog.querySelector<HTMLElement>('[data-dialog-default]:not([disabled])')
        ?? dialog.querySelector<HTMLElement>('.button.primary:not([disabled])')
        ?? dialogFocusableElements(dialog)[0];
      if (initial && !dialog.contains(document.activeElement)) initial.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeDialogKey]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]');
      const activeDialog = dialogs[dialogs.length - 1];
      if (activeDialog && event.key === 'Tab') {
        const focusable = dialogFocusableElements(activeDialog);
        if (!focusable.length) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!activeDialog.contains(document.activeElement)
          || document.activeElement === activeDialog
          || event.shiftKey && document.activeElement === first
          || !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
          return;
        }
      }
      if (event.isComposing) return;
      if (logPanelOpen) {
        if (event.key === 'Escape') setLogPanelOpen(false);
        return;
      }
      if (userAlert) {
        if (event.key === 'Escape') setUserAlert(null);
        return;
      }
      if (activationFailureOpen) {
        if (event.key === 'Escape' && !busy) setActivationFailureOpen(false);
        return;
      }
      if (exportFeedback) {
        if (event.key === 'Escape' && exportFeedback.status !== 'working') setExportFeedback(null);
        return;
      }
      if (settingsOpen) {
        if (event.key === 'Escape') setSettingsOpen(false);
        return;
      }
      if (exportRecording) {
        if (event.key === 'Escape' && !busy) setExportRecording(null);
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
      if (showDeviceWarningDialog && event.key === 'Escape') {
        event.preventDefault();
        requestSafePause();
        return;
      }
      if (showNoiseCheckDialog && event.key === 'Escape') {
        event.preventDefault();
        requestSafePause();
        return;
      }
      if (openActionsSessionDir && event.key === 'Escape') {
        setOpenActionsSessionDir('');
        return;
      }
      if (scriptPreviewOpen) {
        if (event.key === 'Escape') setScriptPreviewOpen(false);
        return;
      }
      if (previewOpen) {
        if (event.code === 'Space') event.preventDefault();
        if (event.key === 'Escape') closePreviewPlayer();
        return;
      }
      if (phase !== 'running' || busy) return;
      if (captureActive && !captureFault && !showNoiseCheckDialog && !showDeviceWarningDialog && event.key === 'Escape' && recording && isPendingTake) {
        event.preventDefault();
        void stopAttempt();
        return;
      }
      if (!workflowShortcutTargetAllowed({
        // Device/noise overlays own their explicit Space/Escape contracts
        // below. Every other modal blocks workspace shortcuts, including when
        // focus was left on a sentence row behind the backdrop.
        modalOpen: inputAuditionOpen
          || (Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))
          && !showDeviceWarningDialog
          && !showNoiseCheckDialog),
        formControl: Boolean(target?.closest('input, textarea, select, audio, [contenteditable="true"]')),
        button: Boolean(target?.closest('button')),
        professionalItem: Boolean(target?.closest('.professional-item')),
      })) return;
      if (!captureActive) {
        const viewAction = viewShortcutAction(event.code, event.key);
        if (viewAction === 'preview') {
          event.preventDefault();
          void previewAttempt();
        } else if (viewAction === 'enter-capture' && !workspaceFaulted) {
          event.preventDefault();
          void activateCapture(currentItem?.id);
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
      if (showDeviceWarningDialog) {
        if (event.code === 'Space') {
          event.preventDefault();
          acknowledgeDeviceWarning();
        }
        return;
      }
      if (showNoiseCheckDialog) {
        const noiseAction = noiseCheckShortcutAction(event.key, event.code, noiseCheckRunning);
        if (noiseAction === 'leave') {
          event.preventDefault();
          requestSafePause();
        } else if (noiseAction === 'retry' && snapshot) {
          event.preventDefault();
          void runSessionNoiseCheck(sessionDir, snapshot);
        }
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        if (recording) {
          if (!canFinishTake) return;
          void stopAttempt();
        }
        else {
          if (retakeSequenceReady) {
            void startAttempt();
          } else {
            const action = workflowShortcutAction(event.code, event.key, primaryAction, Boolean(currentItem));
            if (action === 'finish') requestFinishCapture();
            else if (action === 'accept') void acceptAttempt();
            else if (action === 'start') void startAttempt();
          }
        }
      } else if (!recording && workflowShortcutAction(event.code, event.key, primaryAction, Boolean(currentItem)) === 'retake') {
        void startAttempt(currentItem, { beginRetakeSequence: true });
      } else if (event.key.toLowerCase() === 'p' && !recording) {
        void previewAttempt();
      } else if (event.key.toLowerCase() === 's' && !recording && captureActive && !hasRetakeDecision) {
        void skipItem();
      } else if (event.key === 'ArrowLeft' && !recording) {
        setRetakeSequenceActive(false);
        setCurrentIndex((index) => Math.max(0, index - 1));
        setReviewAttemptId(null);
      } else if (event.key === 'ArrowRight' && !recording) {
        setRetakeSequenceActive(false);
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
        <section className="settings-advanced">
          <details data-testid="settings-recording-defaults" onToggle={(event) => {
            if (!event.currentTarget.open) return;
            const node = event.currentTarget;
            requestAnimationFrame(() => {
              node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            });
          }}>
            <summary>
              <div>
                <strong>{t('settings.recordingDefaults')}</strong>
                <small>{t('settings.recordingDefaultsHint')}</small>
              </div>
              <em>{workstationRules.autoStartNext ? t('settings.continuousDefault') : t('settings.manualDefault')}</em>
            </summary>
            <RecordingRuleGroups
              rules={workstationRules}
              testIdPrefix="settings-rule"
              discardEmptyHint={t('recorder.ruleDiscardEmptyHint')}
              onChange={applyWorkstationAutomationRule}
            />
          </details>
        </section>
      </div>
      <footer><button data-dialog-default className="button primary" onClick={() => setSettingsOpen(false)}>{t('common.done')}</button></footer>
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
        <span className={`dialog-icon ${exportFeedback.status === 'failed' ? 'danger' : exportFeedback.status === 'preserved' || exportFeedback.status === 'ok' && exportFeedback.warning ? 'warning' : exportFeedback.status === 'ok' ? 'success' : ''}`}>
          <Icon name={exportFeedback.status === 'failed' ? 'stop' : exportFeedback.status === 'ok' ? 'check' : 'export'} size={19} />
        </span>
        <div>
          <h2 id="export-result-title">
            {exportFeedback.status === 'working'
              ? t('exportDialog.resultWorkingTitle')
              : exportFeedback.status === 'failed'
                ? t('exportDialog.resultFailedTitle')
                : exportFeedback.status === 'preserved'
                  ? t('p1.deliveryPreservedTitle')
                  : t('exportDialog.resultOkTitle')}
          </h2>
        </div>
      </header>
      <p>
        {exportFeedback.status === 'working'
          ? t('exportDialog.resultWorkingBody', { output: exportFeedback.output })
          : exportFeedback.status === 'failed'
            ? t('exportDialog.resultFailedBody', { id: exportFeedback.sessionId, output: exportFeedback.output })
            : exportFeedback.status === 'preserved'
              ? t('p1.deliveryPreservedBody', { id: exportFeedback.sessionId, output: exportFeedback.output })
              : t('exportDialog.resultOkBody', { id: exportFeedback.sessionId, output: exportFeedback.output })}
      </p>
      {exportFeedback.status === 'working' && exportFeedback.progress && <div className="delivery-progress" role="progressbar" aria-valuemin={0} aria-valuemax={exportFeedback.progress.total_bytes} aria-valuenow={exportFeedback.progress.bytes_copied}>
        <span><strong>{t(`p1.deliveryStage.${exportFeedback.progress.stage}`)}</strong><em>{exportFeedback.progress.total_bytes > 0 ? `${Math.round(exportFeedback.progress.bytes_copied / exportFeedback.progress.total_bytes * 100)}%` : t('common.loading')}</em></span>
        <i><b style={{ width: `${exportFeedback.progress.total_bytes > 0 ? Math.min(100, exportFeedback.progress.bytes_copied / exportFeedback.progress.total_bytes * 100) : 0}%` }} /></i>
      </div>}
      {exportFeedback.status === 'failed' && exportFeedback.error && <div className="dialog-warning danger">{exportFeedback.error}</div>}
      {(exportFeedback.status === 'ok' || exportFeedback.status === 'preserved') && exportFeedback.warning && <div className="dialog-warning">{exportFeedback.warning}</div>}
      {(exportFeedback.status === 'ok' || exportFeedback.status === 'preserved') && (exportFeedback.filePath || exportFeedback.exportDir) && <div className="export-result-meta">
        {exportFeedback.filePath && <div><span>{t('exportDialog.resultFile')}</span><code title={exportFeedback.filePath}>{exportFeedback.filePath}</code></div>}
        {exportFeedback.exportDir && <div><span>{t('exportDialog.resultPath')}</span><code title={exportFeedback.exportDir}>{exportFeedback.exportDir}</code></div>}
      </div>}
      <footer>
        {exportFeedback.status === 'working' && exportFeedback.requestId && <button className="button" onClick={() => void cancelExportDelivery()}>{t('common.cancel')}</button>}
        {(exportFeedback.status === 'ok' || exportFeedback.status === 'preserved') && <button data-testid="export-result-open-folder" className="button" onClick={() => void openExportFeedbackFolder()} disabled={Boolean(busy)}>{t('exportDialog.openFolder')}</button>}
        <button data-testid="export-result-close" data-dialog-default className="button primary" onClick={() => setExportFeedback(null)} disabled={exportFeedback.status === 'working'}>
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
        <button data-testid="user-alert-close" data-dialog-default className="button primary" onClick={() => setUserAlert(null)}>{t('common.close')}</button>
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
      {activationFailure.kind !== 'input_access_denied' && <div className="activation-failure-settings">
        <p>{t('activationError.changeHint')}</p>
        {exclusiveCaptureAvailable && !selectedDeviceIsAsio && sharedCaptureAvailable && deviceExclusiveAvailable(selectedDevice) && <label className="field"><span>{t('setup.shareMode')}</span><select data-testid="activation-recovery-share-mode" value={recoveryShareMode} onChange={(event) => {
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
        }}><option value="exclusive">{t('setup.exclusiveRecommended')}</option><option value="shared">{t('setup.sharedNotProduction')}</option></select></label>}
        <label className="field"><span>{t('recorder.driverInputFormat')}</span><select data-testid="activation-recovery-format" value={recoverySampleFormat} onChange={(event) => setRecoverySampleFormat(event.target.value)}>{!recoveryFormatOptions.some((format) => format === recoverySampleFormat) && <option value={recoverySampleFormat}>{captureSampleFormatLabel(recoverySampleFormat)}</option>}{(recoveryFormatOptions.length ? recoveryFormatOptions : [recoverySampleFormat]).map((format) => <option value={format} key={format}>{captureSampleFormatLabel(format)}</option>)}</select></label>
      </div>}
      <details className="activation-failure-detail">
        <summary>{t('activationError.detail')}</summary>
        <p>{activationFailure.message}</p>
      </details>
      <footer>
        <button data-dialog-initial className="button" onClick={() => setActivationFailureOpen(false)} disabled={Boolean(busy)}>{t('common.close')}</button>
        {activationFailure.kind === 'input_access_denied'
          ? <button data-testid="activation-retry" className="button primary" onClick={() => void activateCapture(currentItem?.id)} disabled={Boolean(busy)}>{t('activationError.retryCapture')}</button>
          : <>
            <button data-testid="activation-back-to-setup" className="button" onClick={returnToSetupFromInspection} disabled={Boolean(busy)}>{t('activationError.backToSetup')}</button>
            <button data-testid="activation-retry" className={activationRecoveryChanged ? 'button' : 'button primary'} onClick={() => void activateCapture(currentItem?.id)} disabled={Boolean(busy)}>{t('activationError.retryCapture')}</button>
            {activationRecoveryChanged && <button data-testid="activation-recreate" className="button primary" onClick={() => void recreateFromActivationFailure()} disabled={Boolean(busy) || !activationRecoveryValid}>{t('activationError.recreateAndEnter')}</button>}
          </>}
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
            const listEntry = planTaskListEntry(historyEntryWithTaskWarningPreference(recording));
            const state = recordingState(recording, listEntry);
            const handled = recording.accepted_items + recording.skipped_items;
            const progress = recording.total_items ? handled / recording.total_items * 100 : 0;
            const updated = formatListDateTime(recording.updated_at);
            const isSealing = sealingSessionDir === recording.session_dir;
            const isDeleting = deletingSessionDir === recording.session_dir;
            const isResetting = resettingSessionDir === recording.session_dir;
            const actionsOpen = openActionsSessionDir === recording.session_dir;
            const rowResumeError = resumeError?.sessionDir === recording.session_dir ? resumeError.message : '';
            return <article key={recording.session_dir} className={`home-recording-row ${rowResumeError ? 'has-error' : ''} ${actionsOpen ? 'menu-open' : ''}`}>
              <button className="home-recording-name" onClick={() => showTaskDetails(recording)} aria-label={t('home.openTaskAria', { id: recording.session_id })}><i className={`recording-dot ${state.kind}`} /><div><strong>{recording.session_id}</strong><small title={recording.history_issue}>{recording.history_issue || <>{recording.script_name || t('home.unknownSource')} · {recording.sample_rate ? `${recording.sample_rate.toLocaleString(locale)} Hz / ${recording.bit_depth}-bit` : t('home.unknownFormat')}</>}</small></div></button>
              <div className="home-recording-progress"><span><b>{handled}</b><small> / {recording.total_items}</small></span><i><em style={{ width: `${progress}%` }} /></i></div>
              <time className="home-recording-time" dateTime={updated.dateTime || undefined} title={updated.full}><strong>{updated.date}</strong>{updated.time ? <small>{updated.time}</small> : null}</time>
              <span><em className={`recording-status ${state.kind}`}>{state.label}</em></span>
              <div className="home-row-actions">
                {listEntry.kind === 'continue-stop'
                  ? <button className="row-primary" onClick={() => void continuePendingStop(recording)} disabled={Boolean(busy)}>{t('home.continueSafeStop')}</button>
                  : listEntry.kind === 'return'
                    ? <button className="row-primary" onClick={() => void returnToActiveRecording(recording)} disabled={Boolean(busy)}>{t('home.returnToRecording')}</button>
                    : listEntry.kind === 'repair'
                      ? <button data-testid="seal-recording" className="row-primary" onClick={() => setSealConfirmRecording(recording)} disabled={Boolean(busy) || Boolean(sealingSessionDir)}>{isSealing ? t('common.checking') : t('home.inspectAndRepair')}</button>
                      : listEntry.kind === 'record'
                        ? <button data-testid="record-recording" className="row-primary" onClick={() => void openHistoricalRecording(recording, { activate: true })} disabled={Boolean(busy) || Boolean(sealingSessionDir)} aria-label={t('home.recordTaskAria', { id: recording.session_id })}>{t('home.continueRecording')}</button>
                        : listEntry.kind === 'issues'
                          ? <button data-testid="handle-recording-issues" className="row-primary" onClick={() => showTaskIssues(recording)} disabled={Boolean(busy)} aria-label={t('home.handleIssuesAria', { id: recording.session_id })}>{t('home.handleIssues')}</button>
                        : listEntry.kind === 'export'
                          ? <button data-testid="export-recording" className="row-primary" onClick={() => showExport(recording)} disabled={Boolean(busy)}>{t('home.exportDelivery')}</button>
                          : listEntry.kind === 'deliver'
                            ? <button data-testid="deliver-recording" className="row-primary" onClick={() => showExport(recording)} disabled={Boolean(busy)}>{t('home.completeDelivery')}</button>
                            : listEntry.kind === 'delivered'
                              ? <button data-testid="view-delivery" className="row-primary" title={recording.verified_delivery_directories?.cuts_zip} onClick={() => void openVerifiedRecordingDelivery(recording)} disabled={Boolean(busy)}>{t('home.viewDelivery')}</button>
                          : <button data-testid="view-recording" className="row-primary" onClick={() => listEntry.reason === 'warning' ? showTaskExportReview(recording) : listEntry.reason === 'blocked' ? showTaskIssues(recording) : showTaskDetails(recording)} disabled={Boolean(busy)} aria-label={t('home.viewTaskAria', { id: recording.session_id })}>{listEntry.reason === 'warning' ? t('home.reviewAndDeliver') : listEntry.reason === 'blocked' ? t('home.handleIssues') : t('home.viewProblem')}</button>}
                <div className="home-actions-menu-wrap">
                  <button data-testid="recording-actions-menu" className="row-more" title={t('common.moreActions')} aria-label={t('home.moreAria', { id: recording.session_id })} aria-haspopup="menu" aria-expanded={actionsOpen} onClick={() => setOpenActionsSessionDir(actionsOpen ? '' : recording.session_dir)} disabled={Boolean(busy) || Boolean(deletingSessionDir) || Boolean(resettingSessionDir)}><Icon name="more" size={16} /></button>
                  {actionsOpen && <div className="home-actions-menu" role="menu" aria-label={t('home.actionsAria', { id: recording.session_id })}>
                    <button data-testid="open-recording-folder" role="menuitem" aria-label={t('home.openFolderAria', { id: recording.session_id })} onClick={() => { setOpenActionsSessionDir(''); void openRecordingDirectory(recording); }} disabled={Boolean(busy)}><Icon name="folder" size={14} /><span>{t('home.openFolder')}</span></button>
                    {!recording.is_active && recording.export_exists && <button role="menuitem" onClick={() => { setOpenActionsSessionDir(''); void openRecordingExport(recording); }}><Icon name="export" size={14} /><span>{t('home.openExportDir')}</span></button>}
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
          <dl className="property-list export-status-summary"><div><dt>{t('recorder.accepted')}</dt><dd>{exportRecording.accepted_items}</dd></div><div><dt>{t('recorder.review')}</dt><dd>{exportRecording.review_items}</dd></div><div><dt>{t('recorder.pending')}</dt><dd>{exportRecording.pending_items}</dd></div></dl>
          {exportDestinationPicker(exportRecording.session_dir)}
          <div className="export-options" aria-label={t('exportDialog.optionsAria')}>
            <button onClick={() => { const task = exportRecording; setExportRecording(null); void exportRecordingArtifact(task, 'full_track'); }} disabled={Boolean(busy)}><span><Icon name="meter" size={16} /></span><div><strong>{t('exportDialog.fullTrack')}</strong><small>full-track.wav · {artifactStatusCopy(exportRecording, 'full_track')}</small></div></button>
            <button onClick={() => { const task = exportRecording; setExportRecording(null); void exportRecordingArtifact(task, 'timestamps_json'); }} disabled={Boolean(busy)}><span><Icon name="file" size={16} /></span><div><strong>{t('exportDialog.timestamps')}</strong><small>timestamps.json · {artifactStatusCopy(exportRecording, 'timestamps_json')}</small></div></button>
            <button onClick={() => { const task = exportRecording; setExportRecording(null); void exportRecordingArtifact(task, 'cuts_zip'); }} disabled={Boolean(busy) || recordingState(exportRecording).kind === 'attention' || exportRecording.review_items > 0}><span><Icon name="export" size={16} /></span><div><strong>{t('exportDialog.cuts')}</strong><small>{recordingState(exportRecording).kind === 'attention' ? t('exportDialog.cutsBlocked') : exportRecording.review_items > 0 ? t('exportDialog.cutsBlockedReview') : `cuts.zip · ${artifactStatusCopy(exportRecording, 'cuts_zip')}`}</small></div></button>
          </div>
          <div className="dialog-warning">{t('exportDialog.taskLine', { id: exportRecording.session_id })}<br />{t('exportDialog.warning')}</div>
          <footer><button data-dialog-initial className="button" onClick={() => setExportRecording(null)} disabled={Boolean(busy)}>{t('common.close')}</button></footer>
        </section>
      </div>}
      {sealConfirmRecording && <div className="dialog-backdrop" role="presentation">
        <section className="studio-dialog seal-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="seal-confirm-title">
          <header><span className="dialog-icon"><Icon name="history" size={19} /></span><div><h2 id="seal-confirm-title">{t('sealDialog.title')}</h2></div></header>
          <p>{t('sealDialog.body')}</p>
          <div className="dialog-warning">{t('sealDialog.taskLine', { id: sealConfirmRecording.session_id })}<br />{sealConfirmRecording.status === 'faulted' || sealConfirmRecording.overflow_samples > 0 ? t('sealDialog.keepFault') : t('sealDialog.canContinue')}</div>
          <footer><button className="button" onClick={() => setSealConfirmRecording(null)} disabled={Boolean(busy)}>{t('common.cancel')}</button><button data-testid="confirm-seal-recording" data-dialog-default className="button primary" onClick={() => { const recording = sealConfirmRecording; setSealConfirmRecording(null); void sealHistoricalRecording(recording); }} disabled={Boolean(busy)}>{t('sealDialog.confirm')}</button></footer>
        </section>
      </div>}
      {resetConfirmRecording && <div className="dialog-backdrop" role="presentation">
        <section className="studio-dialog delete-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="reset-confirm-title">
          <header><span className="dialog-icon danger"><Icon name="refresh" size={19} /></span><div><h2 id="reset-confirm-title">{t('resetDialog.title')}</h2></div></header>
          <p>{t('resetDialog.body')}</p>
          <div className="dialog-warning danger">{t('resetDialog.taskLine', { id: resetConfirmRecording.session_id })}<br />{t('resetDialog.warning')}</div>
          <footer><button data-dialog-initial className="button" onClick={() => setResetConfirmRecording(null)} disabled={Boolean(resettingSessionDir)}>{t('common.cancel')}</button><button data-testid="confirm-reset-recording" className="button danger" onClick={() => { const recording = resetConfirmRecording; setResetConfirmRecording(null); void resetHistoricalRecording(recording); }} disabled={Boolean(resettingSessionDir)}>{t('resetDialog.confirm')}</button></footer>
        </section>
      </div>}
      {deleteConfirmRecording && <div className="dialog-backdrop" role="presentation">
        <section className="studio-dialog delete-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
          <header><span className="dialog-icon danger"><Icon name="trash" size={19} /></span><div><h2 id="delete-confirm-title">{t('deleteDialog.title')}</h2></div></header>
          <p>{t('deleteDialog.body')}</p>
          <div className="dialog-warning danger">{t('deleteDialog.taskLine', { id: deleteConfirmRecording.session_id })}<br />{t('deleteDialog.warning')}</div>
          <footer><button data-dialog-initial className="button" onClick={() => setDeleteConfirmRecording(null)} disabled={Boolean(deletingSessionDir)}>{t('common.cancel')}</button><button data-testid="confirm-delete-recording" className="button danger" onClick={() => { const recording = deleteConfirmRecording; setDeleteConfirmRecording(null); void deleteHistoricalRecording(recording); }} disabled={Boolean(deletingSessionDir)}>{t('deleteDialog.confirm')}</button></footer>
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
    const scriptReady = scriptItems.length > 0 && !scriptErrors.length;
    const readinessIssues = setupReadinessIssues({
      engineReady: engineStatus === 'ready',
      scriptReady,
      captureReady: captureConfigurationValid,
      outputReady: Boolean(outputDir),
    });
    const readinessCopy = readinessIssues.map((issue) => {
      if (issue === 'engine') return engineStatus === 'connecting' ? t('settings.engineConnecting') : t('settings.engineOffline');
      if (issue === 'script') return scriptErrors[0] || t('setup.stepImportHint');
      if (issue === 'capture') return captureConfigurationIssue || t('setup.stepAudioHint');
      return t('home.locationUnset');
    });
    const readyToStart = readinessIssues.length === 0 && !busy && !presetBusy;
    return <div className="studio-shell">
      <StudioChrome phase={phase} title={t('setup.title')} onBack={returnToRecordings} onOpenSettings={() => setSettingsOpen(true)} />
      <div className="studio-workspace setup-workspace" data-testid="setup-workspace">
        <aside className="tool-rail" aria-label={t('setup.toolsAria')}><button className="active" title={t('setup.toolNew')}><Icon name="file" /></button><button title={t('setup.toolDevice')}><Icon name="microphone" /></button><button title={t('setup.toolParams')}><Icon name="sliders" /></button><span /><button title={t('setup.toolHistory')} onClick={returnToRecordings}><Icon name="history" /></button></aside>
        <aside className="panel setup-outline">
          <div className="panel-tabs"><button className="active">{t('setup.tabPrepare')}</button><button>{t('setup.tabPresets')}</button></div>
          <div className="panel-section-title">{t('setup.title')}</div>
          <ol className="setup-steps">
            <li className={scriptReady ? 'complete' : 'active'}><span>{scriptReady ? <Icon name="check" size={13} /> : '1'}</span><div><strong>{t('setup.stepImportTitle')}</strong><small>{scriptReady ? t('setup.previewImported') : scriptFile || t('setup.stepImportHint')}</small></div></li>
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
              <label className={`script-picker ${busy ? 'disabled' : ''}`}><input data-testid="script-file" className="file-input" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" disabled={Boolean(busy)} onChange={(event) => void chooseScriptFile(event.target.files?.[0])} /><span className="picker-icon"><Icon name="file" size={19} /></span><span className="picker-copy"><strong>{scriptFile || t('setup.pickScript')}</strong><small>{scriptFile && scriptPreview ? t('setup.scriptLoaded', { count: scriptPreview.summary.totalItems }) : t('setup.scriptColumns')}</small></span><span className="button subtle">{t('common.browse')}</span></label>
              {scriptErrors.length > 0 && <div className="validation-errors">{scriptErrors.slice(0, 5).map((message) => <p key={message}>{message}</p>)}</div>}
              {scriptPreview && <div className={`script-preview-entry${scriptErrors.length ? ' invalid' : ''}`} data-testid="script-preview-entry">
                <div><strong>{scriptErrors.length ? t('setup.previewNeedsFix') : t('setup.previewImported')}</strong><small>{t(scriptPreview.mode === 'structured' ? 'setup.previewStructuredHint' : 'setup.previewPlainTextHint')}</small></div>
                <button type="button" className="button subtle" data-testid="open-script-preview" onClick={() => setScriptPreviewOpen(true)}><Icon name="file" size={14} />{t('setup.previewOpen')}</button>
              </div>}
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
              <div className="form-grid audio-form setup-essential-audio" data-testid="setup-essential-audio">
                <label className="field span-2"><span>{t('setup.deviceLabel')}</span><div className="field-row"><select value={deviceId} onChange={(event) => { const device = devices.find((candidate) => candidate.id === event.target.value); setDeviceId(event.target.value); setDeviceName(device?.name ?? ''); }} disabled={Boolean(busy)}>{!devices.length && <option value="">{t('setup.noDevices')}</option>}{deviceId && !selectedDevice && <option value={deviceId}>{t('setup.deviceUnavailable', { name: deviceName || deviceId })}</option>}{devices.map((device) => <option value={device.id} key={device.id}>{device.name}{device.backend ? ` — ${device.backend.toUpperCase()}` : ''}{device.is_default ? t('setup.systemDefault') : ''}{classifyInputDevice(device) === 'rejected' ? t('setup.deviceRejectedSuffix') : classifyInputDevice(device) === 'discouraged' ? t('setup.deviceDiscouragedSuffix') : ''}</option>)}</select><button className="square-button" title={t('setup.refreshDevices')} onClick={() => void loadDevices()}><Icon name="refresh" /></button></div></label>
                <label className={`field ${selectedDevice && inputChannel > activeInputChannels ? 'invalid' : ''}`}><span>{t('setup.inputChannel')}</span><select value={inputChannel} onChange={(event) => setInputChannel(Number(event.target.value))}>{inputChannel > activeInputChannels && <option value={inputChannel}>{t('setup.inputIncompatible', { n: inputChannel })}</option>}{Array.from({ length: activeInputChannels }, (_, index) => <option value={index + 1} key={index + 1}>{t('setup.inputN', { n: index + 1 })}</option>)}</select></label>
                <label className="field"><span>{t('setup.outputBitDepth')}</span><select data-testid="delivery-bit-depth" value={bitDepth} onChange={(event) => setBitDepth(Number(event.target.value) as DeliveryBitDepth)}>{DELIVERY_BIT_DEPTHS.map((depth) => <option value={depth} key={depth}>{deliveryBitDepthLabel(depth)}</option>)}</select><small>{t('setup.outputBitDepthHint')}</small></label>
                <div className="setup-rhythm"><div><span><strong>{t('recorder.continuousRecording')}</strong><small>{automationRules.autoStartNext ? automationRules.pauseOnLabelChange ? t('recorder.continuousSummaryLabelPause') : t('recorder.continuousSummaryAll') : t('recorder.continuousSummaryManual')}</small></span><div role="group" aria-label={t('recorder.continuousRecording')}><button type="button" className={automationRules.autoStartNext ? 'active' : ''} aria-pressed={automationRules.autoStartNext} onClick={() => applyAutomationRule('autoStartNext', true)}>{t('settings.continuousDefault')}</button><button type="button" className={!automationRules.autoStartNext ? 'active' : ''} aria-pressed={!automationRules.autoStartNext} onClick={() => applyAutomationRule('autoStartNext', false)}>{t('settings.manualDefault')}</button></div></div></div>
              </div>
              <details className="setup-advanced" data-testid="setup-detection-advanced">
                <summary>
                  <div>
                    <strong>{t('setup.detectionAdvanced')}</strong>
                    <small>{t('setup.detectionAdvancedHint')}</small>
                  </div>
                  <em>{detectionPolicySummary(automationRules)}</em>
                </summary>
                <div className="form-grid audio-form setup-advanced-grid" data-testid="setup-technical-settings">
                  {exclusiveCaptureAvailable ? <label className="field"><span>{t('setup.shareMode')}</span><input data-testid="capture-share-mode" value={selectedDevice?.backend === 'asio' ? selectedDevice.recommended_buffer_frames ? `ASIO · ${t('setup.bufferFrames', { frames: selectedDevice.recommended_buffer_frames })}` : 'ASIO' : captureShareMode === 'exclusive' ? t('setup.exclusiveRecommended') : t('setup.sharedNotProduction')} readOnly /></label> : <label className="field"><span>{t('setup.shareMode')}</span><input value={t('setup.shareModeDev')} readOnly /></label>}
                  <label className={`field ${selectedDevice && !rateOptions.includes(sampleRate) ? 'invalid' : ''}`}><span>{t('setup.sampleRate')}</span><select value={sampleRate} onChange={(event) => setSampleRate(Number(event.target.value))}>{!rateOptions.includes(sampleRate) && <option value={sampleRate}>{t('setup.rateIncompatible', { rate: sampleRate.toLocaleString(locale) })}</option>}{rateOptions.map((rate) => <option value={rate} key={rate}>{rate.toLocaleString(locale)} Hz</option>)}</select></label>
                  <label className="field"><span>{t('setup.silenceThreshold')}</span><input type="number" min="-72" max="-12" step="1" value={noiseThresholdDbfs} onChange={(event) => setNoiseThresholdDbfs(Math.min(-12, Math.max(-72, Number(event.target.value) || -42)))} /></label>
                  <label className="field"><span>{t('setup.silenceDuration')}</span><input type="number" min="0.2" max="5" step="0.1" value={silenceDurationMs / 1_000} onChange={(event) => setSilenceDurationMs(Math.round(Math.min(5, Math.max(.2, Number(event.target.value) || 1)) * 1_000))} /></label>
                  <div className="setup-detector" data-testid="setup-detector"><header><span><strong>{t('recorder.detectorTitle')}</strong><small>{t('setup.detectorHelp')}</small></span></header><DetectorSelectCards value={silenceDetector} disabled={Boolean(busy)} onChange={(value) => { setSilenceDetector(value); setSilenceDetectorDraft(value); }} /></div>
                </div>
                <div className="automation-rules">
                  <DetectionPolicyFields
                    rules={automationRules}
                    envTestId="setup-rule-env-check"
                    emptyTestId="setup-rule-discard-empty"
                    onChange={applyAutomationRule}
                  />
                  {exclusiveCaptureAvailable && !selectedDeviceIsAsio && sharedCaptureAvailable && deviceExclusiveAvailable(selectedDevice) && <label className="field"><span>{t('setup.shareModeOverride')}</span><select data-testid="capture-share-mode-override" value={captureShareMode} onChange={(event) => setCaptureShareMode(normalizeCaptureShareMode(event.target.value))} disabled={Boolean(busy)}><option value="exclusive">{t('setup.exclusiveRecommended')}</option><option value="shared">{t('setup.sharedNotProduction')}</option></select></label>}
                </div>
              </details>
              <div className={`hardware-line ${captureConfigurationIssue ? 'invalid' : selectedDeviceNeedsWarning ? 'warning' : ''}`}><span className={captureConfigurationValid && !selectedDeviceNeedsWarning ? 'ok' : ''}><i />{captureConfigurationIssue || (selectedDeviceNeedsWarning ? t('setup.deviceNotForCapture') : t('setup.configOk'))}</span><em>{selectedDevice?.backend?.toUpperCase() || captureShareModeLabel(captureShareMode)}</em><em>{t('setup.inputChannelOf', { channel: inputChannel, total: activeInputChannels })}</em></div>
              <p className={`hardware-hint${selectedDeviceNeedsWarning ? ' warning' : ''}`}>{selectedDeviceKind === 'rejected' ? t('setup.deviceRejectedHint') : selectedDeviceKind === 'discouraged' ? t('setup.deviceDiscouragedHint') : captureShareMode === 'shared' || !exclusiveCaptureAvailable ? t('setup.sharedFormatHint') : t('setup.exclusiveFormatHint')}</p>
              {!exclusiveCaptureAvailable && window.recorder.runtime === 'desktop' && <p className="dev-web-capture-hint">{t('setup.devWebCaptureHint')}</p>}
            </section>
            <section className="property-group">
              <div className="property-heading"><span>03</span><div><h2>{t('setup.storageHeading')}</h2><p>{t('setup.storageHelp')}</p></div></div>
              <div className="form-grid storage-form"><label className="field"><span>{t('setup.sessionName')}</span><input value={sessionName} onChange={(event) => setSessionName(event.target.value)} /></label><label className="field span-2"><span>{t('setup.localLocation')}</span><div className="field-row"><input value={outputDir} readOnly /><button className="button" onClick={() => void chooseOutput()}><Icon name="folder" size={14} />{t('common.selectEllipsis')}</button></div></label></div>
            </section>
            <div className={`document-actions setup-readiness ${readinessIssues.length ? 'blocked' : 'ready'}`} data-testid="setup-readiness" aria-live="polite">
              {readinessIssues.length
                ? <div><strong>{t('setup.createTask')}</strong><ul>{readinessCopy.map((copy, index) => <li key={`${readinessIssues[index]}:${copy}`}><Icon name="stop" size={12} />{copy}</li>)}</ul></div>
                : <p><Icon name="check" size={14} />{t('setup.createHint')}</p>}
              <button data-testid="start-session" className="button primary" onClick={() => void startSession({ activateAfterCreate: true })} disabled={!readyToStart}><Icon name="record" size={14} />{t('setup.createTask')}</button>
            </div>
          </div>
        </main>
        <aside className="panel inspector setup-inspector">
          <div className="panel-tabs"><button className="active">{t('setup.inspector')}</button></div>
          <div className="inspector-section"><h3>{t('setup.summary')}</h3><dl className="property-list"><div><dt>{t('setup.scriptItems')}</dt><dd>{scriptPreview?.summary.totalItems || t('common.dash')}</dd></div><div><dt>{t('setup.shareMode')}</dt><dd>{selectedDevice?.backend?.toUpperCase() || captureShareModeLabel(captureShareMode)}{selectedDevice?.recommended_buffer_frames ? ` · ${t('setup.bufferFrames', { frames: selectedDevice.recommended_buffer_frames })}` : ''}</dd></div><div><dt>{t('setup.sampleRate')}</dt><dd>{sampleRate.toLocaleString(locale)} Hz</dd></div><div><dt>{t('recorder.exportFormat')}</dt><dd>{sampleRate / 1_000}k / {deliveryBitDepthLabel(bitDepth)}</dd></div><div><dt>{t('setup.inputChannel')}</dt><dd>{inputChannel}</dd></div><div><dt>{t('setup.channels')}</dt><dd>{t('setup.mono')}</dd></div><div><dt>{t('setup.noiseCeiling')}</dt><dd>{noiseThresholdDbfs} dBFS</dd></div><div><dt>{t('setup.headTailSilence')}</dt><dd>{(silenceDurationMs / 1_000).toFixed(1)} s</dd></div><div><dt>{t('recorder.detectorTitle')}</dt><dd>{silenceDetector === 'vad' ? t('recorder.detectorVad') : t('recorder.detectorEnergy')}</dd></div><div><dt>{t('recorder.ruleEnvCheck')}</dt><dd>{automationRules.envCheck ? t('setup.policyOn') : t('setup.policyOff')}</dd></div><div><dt>{t('recorder.ruleDiscardEmpty')}</dt><dd>{automationRules.discardEmpty ? t('setup.policyOn') : t('setup.policyOff')}</dd></div></dl></div>
          <div className="inspector-section"><h3>{t('setup.inputDevice')}</h3><div className="device-summary"><span><Icon name="microphone" /></span><div><strong>{deviceName || t('setup.noDeviceSelected')}</strong><small>{selectedDevice?.is_default ? t('setup.defaultInput') : t('setup.externalInput')}</small></div></div></div>
          <div className="inspector-section"><h3>{t('setup.dataPolicy')}</h3><ul className="feature-list"><li><Icon name="check" />{t('setup.policyMaster')}</li><li><Icon name="check" />{t('setup.policyInteger')}</li><li><Icon name="check" />{t('setup.policyRetake')}</li><li><Icon name="check" />{t('setup.policySnapshot')}</li></ul></div>
        </aside>
      </div>
      <StudioStatus engineStatus={engineStatus} message={error || dataSafetyAlert || presetWarning || busy || notice} isError={Boolean(error || dataSafetyAlert)} />
      {scriptPreviewOpen && scriptPreview && <div className="dialog-backdrop script-preview-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setScriptPreviewOpen(false); }}>
        <section className="studio-dialog script-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="script-preview-title" data-testid="script-import-preview">
          <header>
            <span className="dialog-icon"><Icon name="file" size={19} /></span>
            <div><h2 id="script-preview-title">{t('setup.previewTitle')}</h2><small>{scriptFile}</small></div>
            <span className={`script-mode ${scriptPreview.mode}`}>{t(scriptPreview.mode === 'structured' ? 'setup.previewStructured' : 'setup.previewPlainText')}</span>
          </header>
          <div className="script-preview-body">
            <p>{t(scriptPreview.mode === 'structured' ? 'setup.previewStructuredHint' : 'setup.previewPlainTextHint')}</p>
            <dl className="script-preview-stats">
              <div><dt>{t('setup.previewTotal')}</dt><dd>{scriptPreview.summary.totalItems}</dd></div>
              <div><dt>{t('setup.previewEmptyLabels')}</dt><dd>{scriptPreview.summary.emptyLabelCount}</dd></div>
              <div><dt>{t('setup.previewUniqueLabels')}</dt><dd>{scriptPreview.summary.uniqueLabelCount}</dd></div>
              <div><dt>{t('setup.previewLabelChanges')}</dt><dd>{scriptPreview.summary.labelChangeCount}</dd></div>
            </dl>
            {scriptPreview.warnings.length > 0 && <div className="script-preview-warnings" role="status">{scriptPreview.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
            <div className="script-preview-table-wrap">
              <table>
                <thead><tr><th scope="col">{t('setup.previewId')}</th><th scope="col">{t('setup.previewText')}</th><th scope="col">{t('setup.previewLabel')}</th></tr></thead>
                <tbody>{scriptPreview.items.slice(0, 10).map((item, index) => {
                  const boundary = isLabelBoundary(scriptPreview.items, index);
                  return <tr key={`${item.id}:${index}`} className={boundary ? 'label-boundary' : ''}>
                    <td title={item.id}>{item.id}</td>
                    <td title={item.text}>{item.text}</td>
                    <td title={item.label || t('prompter.none')}><span>{item.label || t('prompter.none')}</span>{boundary ? <em>{t('recorder.labelChanged')}</em> : null}</td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
            <small className="script-preview-count">{scriptPreview.summary.totalItems > 10 ? t('setup.previewFirstRows', { shown: 10, total: scriptPreview.summary.totalItems }) : t('setup.previewAllRows', { total: scriptPreview.summary.totalItems })}</small>
          </div>
          <footer><button type="button" className="button primary" data-testid="close-script-preview" data-dialog-default onClick={() => setScriptPreviewOpen(false)}>{t('common.close')}</button></footer>
        </section>
      </div>}
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
        <div className="browser-summary">
          <div className="browser-summary-line">
            <span>{t('recorder.completedOf', { done: completed, total: items.length })}</span>
            <span className="browser-summary-actions">
              <button
                type="button"
                className="rerecord-locator"
                disabled={rerecordCount === 0 || recording || Boolean(captureFault)}
                aria-label={rerecordCount > 0
                  ? t('recorder.locateNextRerecordAria', { count: rerecordCount })
                  : t('recorder.noRerecordAria')}
                onClick={locateNextRerecord}
              >{t('recorder.rerecordCount', { count: rerecordCount })}</button>
              {flaggedSilenceCount > 0 ? <em className="browser-flags">{t('recorder.silenceFlagged', { count: flaggedSilenceCount })}</em> : null}
            </span>
          </div>
          <div className="mini-progress"><i style={{ width: `${items.length ? completed / items.length * 100 : 0}%` }} /></div>
        </div>
        <div className={`professional-item-list${recording ? ' recording' : ''}`} aria-label={t('recorder.scriptListAria')}>{itemBrowserRows}</div>
      </aside>
      <main id="main" className="editor-document">
        <div className="document-tabs"><span className="active"><Icon name="microphone" size={13} /> {workflowComplete ? t('recorder.taskComplete') : currentItem?.id ?? 'Item'} <i>×</i></span></div>
        <div className="editor-toolbar"><div className="editor-nav"><button title={t('recorder.prevItem')} disabled={recording || currentIndex === 0} onClick={() => { setRetakeSequenceActive(false); setCurrentIndex((index) => Math.max(0, index - 1)); }}><Icon name="chevron-left" /></button><span>{currentIndex + 1} / {items.length}</span><button title={t('recorder.nextItem')} disabled={recording || currentIndex >= items.length - 1} onClick={() => { setRetakeSequenceActive(false); setCurrentIndex((index) => Math.min(items.length - 1, index + 1)); }}><Icon name="chevron-right" /></button></div><div className="editor-time"><strong className={recording ? 'recording' : ''}>{recording ? attemptDuration : sessionDuration}</strong></div><div className="editor-toolbar-actions"><button className="prompter-launch" onClick={() => void openPrompterPanel()}><Icon name="play" size={13} />{prompterStatus.ready ? t('recorder.locatePrompter') : t('recorder.openPrompter')}</button></div><div className={`save-health ${workspaceFaulted || captureFault ? 'fault' : meter.storage_status === 'warning' ? 'warning' : ''}`}><i />{workspaceFaulted ? t('recorder.healthReadonly') : !captureActive ? t('recorder.healthView') : captureFault ? t('recorder.healthFaultStop', { title: captureFaultCopy.title }) : meter.storage_status === 'warning' ? t('recorder.healthWarning', { minutes: Math.max(0, Math.floor(meter.storage_safe_remaining_seconds / 60)) }) : t('recorder.healthLive')}</div></div>
        <div className="editor-canvas">
          {(activationFailure || captureFault || discontinuityToast || qualityWarning || vadHealth !== 'healthy') && <div className="workspace-toasts" aria-live="polite">
            {activationFailure && !captureActive && <div className="session-noise-banner failed" role="alert" data-testid="activation-failure-banner"><Icon name="stop" size={16} /><div><strong>{activationErrorCopy(activationFailure.kind).title}</strong><span>{activationErrorCopy(activationFailure.kind).body}</span></div><button className="button" onClick={() => setActivationFailureOpen(true)} disabled={Boolean(busy)}>{activationFailure.kind === 'input_access_denied' ? t('activationError.openAccessHelp') : t('activationError.openEditor')}</button></div>}
            {captureFault && <div className="capture-fault-banner" role="alert"><Icon name="stop" size={16} /><div><strong>{captureFaultCopy.title}</strong><span>{captureFaultCopy.detail}{snapshot?.device_name ? ` ${t('issues.currentDevice', { name: snapshot.device_name })}` : ' '}{t('issues.stopThenFinish')}</span></div></div>}
            {discontinuityToast && !captureFault && <div className="input-quality-banner workspace-toast" data-testid="discontinuity-toast" role="status"><Icon name="meter" size={16} /><div><strong>{t('discontinuity.bannerTitle')}</strong><span>{discontinuityToast}. {t('discontinuity.bannerHint')}</span></div></div>}
            {qualityWarning && <div className="input-quality-banner" role="alert"><Icon name="meter" size={16} /><div><strong>{t('quality.bannerTitle')}</strong><span>{qualityWarning}. {t('quality.bannerHint')}</span></div></div>}
            {vadHealth !== 'healthy' && <div className={`vad-health-banner ${vadHealth}`} role={vadHealth === 'lagging' ? 'status' : 'alert'} data-testid="vad-health-banner"><Icon name="meter" size={16} /><div><strong>{t(`p1.vadHealth.${vadHealth}`)}</strong><span>{vadHealth === 'lagging' ? t('p1.vadLagDetail', { backlog: vadBacklogMs, capacity: vadCapacityMs }) : t('p1.vadFaultDetail')}</span></div></div>}
          </div>}
          <section className="script-monitor" style={{ ['--prompter-copy-size' as string]: prompterFontSizeRem(appearance.fontSize), ['--prompter-label-size' as string]: prompterLabelFontSizeRem(appearance.labelFontSize) }}>
            <header>
              <span>{t('recorder.currentSentence')}</span>
              <div>
                <PrompterFontSizeControl size={appearance.fontSize} min={MIN_PROMPTER_FONT_SIZE} max={MAX_PROMPTER_FONT_SIZE} onNudge={nudgeFontSize} compact caption={t('recorder.copySizeShort')} smallerLabel={t('prompter.fontSizeSmaller')} largerLabel={t('prompter.fontSizeLarger')} />
                <PrompterFontSizeControl size={appearance.labelFontSize} min={MIN_PROMPTER_LABEL_FONT_SIZE} max={MAX_PROMPTER_LABEL_FONT_SIZE} onNudge={nudgeLabelFontSize} compact caption={t('recorder.labelSizeShort')} testId="recorder-label-font-size" smallerLabel={t('prompter.labelFontSizeSmaller')} largerLabel={t('prompter.labelFontSizeLarger')} />
                <span className="studio-cue">{cueLabel}</span>
                <em>{workflowComplete ? t('recorder.itemsCount', { count: items.length }) : `${currentIndex + 1} / ${items.length}`}</em>
              </div>
            </header>
            <div className={`prompt-surface${showCurrentLabelTransition ? ' label-changed' : ''} ${captureFault ? 'fault' : cue === 'pending' || cue === 'checking' ? 'pending' : cue === 'ready' ? 'ready' : cue === 'recording' ? 'live' : ''}`}>
              {showCurrentLabelTransition && currentLabelTransition ? <span key={`transition:${currentItem?.id ?? 'none'}:${currentLabelTransition.toLabel}`} className="label-transition-chip" role="status" aria-live="polite" aria-atomic="true">
                <b>{t('recorder.labelChanged')}</b>
              </span> : null}
              {captureFault
                ? <span className="label-chip">{t('recorder.stopReadingChip')}</span>
                : entryBlocksAttempt
                  ? <span className="label-chip">{deviceWarningOpen
                    ? t('deviceWarning.dialogKicker')
                    : inputAuditionBlocksAttempt || inputAuditionOpen
                      ? t('inputAudition.title')
                      : t('recorder.envChip')}</span>
                  : (workflowComplete || currentItem?.label || showCurrentLabelTransition) && <span key={`label:${currentItem?.id ?? 'none'}:${currentItem?.label ?? ''}`} className={`label-chip${showCurrentLabelTransition ? ' changed' : ''}`}>{workflowComplete ? t('recorder.allDoneChip') : currentItem?.label || t('recorder.noLabelThisItem')}</span>}
              <p>{captureFault ? captureFaultCopy.title : entryBlocksAttempt ? entryBlockMessage : workflowComplete ? t('recorder.scriptFinished') : currentItem?.text ?? t('recorder.noText')}</p>
              <small>{captureFault ? captureFaultCopy.detail : entryBlocksAttempt ? (inputAuditionBlocksAttempt || inputAuditionOpen ? t('inputAudition.introBody') : deviceWarningOpen ? t('deviceWarning.warning') : noiseCheckMessage) : workflowComplete ? t('recorder.exportLater') : <>{currentItem?.id}</>}</small>
            </div>
          </section>
          <section className="signal-monitor"><header><div><strong>{t('recorder.waveform')}</strong>{captureActive || shouldUseRecordedSilencePair(recording, reviewAttempt) ? <SilencePairReadout pair={silencePair} /> : null}</div><div>{captureActive ? <><span>RMS <b>{db(meter.rms)}</b></span><span>PEAK <b className={meter.peak > .92 ? 'clip' : ''}>{db(meter.peak)}</b></span></> : <span>{reviewAttempt ? formatDuration(reviewAttempt.end_sample - reviewAttempt.start_sample, sampleRateForDisplay) : t('recorder.noTakeWaveform')}</span>}</div></header><div className="signal-scope"><WebGLWaveform key={showReviewWaveform ? `${sessionDir}:${reviewAttempt?.attempt_id}` : `${sessionDir}:${waveformGeneration}`} mode={showReviewWaveform ? 'review' : 'live'} bins={showReviewWaveform ? reviewWaveformBins : (meter.waveform ?? [])} capturedSamples={meter.captured_samples} waveformEndSample={meter.waveform_end_sample} recording={waveformTakeIsActive(recording && !captureFault, hasSpoken)} takeStartSample={recording && !captureFault ? liveTakeStartSample : undefined} takeEndSample={recording && !captureFault ? liveTakeEndSample : undefined} sampleRate={sampleRateForDisplay} />{captureActive ? <LiveSilenceHint liveMs={displayedLiveSilenceMs} requiredMs={effectiveSilenceDurationMs} /> : null}<div className="scope-scale"><span>−1.0</span><span>−0.5</span><span>0</span><span>+0.5</span><span>+1.0</span></div></div><div className="horizontal-meter"><i className="meter-rms" style={{ width: `${rmsPercent}%` }} /><i className="meter-peak" style={{ left: `${peakPercent}%` }} /></div></section>
          <section className="transport-panel">
            <div className="transport-review">
              {hasRetakeChoice
                ? <div className="retake-ab-review" data-testid="retake-decision-summary">
                  <button data-testid="preview-current-delivery" onClick={() => retainedDeliveryAttempt && void previewAttempt(retainedDeliveryAttempt.attempt_id)} disabled={Boolean(busy) || !retainedDeliveryAttempt || !safeAttemptIds.has(retainedDeliveryAttempt.attempt_id)}>
                    <span className="retake-version">{t('recorder.currentDeliveryVersion')}</span>
                    <strong><Icon name="play" size={12} />{t('recorder.preview')}</strong>
                    {retainedDeliveryAttempt ? <span className="retake-version-meta">
                      <time data-testid="retake-current-duration">{formatDuration(retainedDeliveryAttempt.end_sample - retainedDeliveryAttempt.start_sample, sampleRateForDisplay)}</time>
                      <SilencePairReadout pair={retainedDeliveryPair} hint testId="retake-current-silence" />
                    </span> : null}
                  </button>
                  <button data-testid="preview-retake" onClick={() => retakeCandidateAttempt && void previewAttempt(retakeCandidateAttempt.attempt_id)} disabled={Boolean(busy) || !retakeCandidateAttempt || !safeAttemptIds.has(retakeCandidateAttempt.attempt_id)}>
                    <span className="retake-version">{t('recorder.retakeCandidateVersion')}</span>
                    <strong><Icon name="play" size={12} />{t('recorder.previewCandidate')}</strong>
                    {retakeCandidateAttempt ? <span className="retake-version-meta">
                      <time data-testid="retake-candidate-duration">{formatDuration(retakeCandidateAttempt.end_sample - retakeCandidateAttempt.start_sample, sampleRateForDisplay)}</time>
                      <SilencePairReadout pair={retakeCandidatePair} hint testId="retake-candidate-silence" />
                    </span> : null}
                  </button>
                  <em>{t('recorder.retakeDecisionHint')}</em>
                </div>
                : hasRetainedPreviousWarning
                  ? <span className="retake-retained-warning" role="status"><Icon name="meter" size={13} />{t('recorder.retakeFailedPreviousRetained')}</span>
                  : showReviewSilenceBill && <span className={`silence-bill${silencePair.hint || silencePair.extra ? ' has-issue' : ''}`} data-testid="review-silence-bill"><SilencePairReadout pair={silencePair} hint /></span>}
            </div>
            <div className="transport-controls">
              <div className="transport-secondary">
              {!hasRetakeChoice && <button data-testid={hasRetakeDecision ? 'preview-retake' : undefined} title={t('recorder.previewKey')} onClick={() => void previewAttempt()} disabled={recording || !reviewAttempt || Boolean(busy)}><Icon name="play" /><span>{hasRetakeDecision ? t('recorder.previewCandidate') : t('recorder.preview')}</span><kbd>P</kbd></button>}
              {captureActive && <button title={t('recorder.retakeKey')} onClick={() => void startAttempt(currentItem, { beginRetakeSequence: true })} disabled={workspaceFaulted || captureFault || entryBlocksAttempt || recording || !currentItem || Boolean(busy)}><Icon name="retake" /><span>{t('recorder.retake')}</span><kbd>R</kbd></button>}
              </div>
              <div className="transport-primary">
              {!captureActive
                ? workspaceFaulted
                  ? <button data-testid="main-transport" className="main-transport start" disabled><span><Icon name="microphone" /></span><strong>{t('recorder.readonlyRepair')}</strong></button>
                  : <button data-testid="main-transport" className="main-transport start" onClick={() => void previewAttempt()} disabled={Boolean(busy) || !reviewAttempt}><span><Icon name="play" /></span><strong>{t('recorder.previewThis')}</strong><kbd>SPACE</kbd></button>
                : captureFault
                ? <button data-testid="main-transport" className="main-transport stop" onClick={finishSession} disabled={Boolean(busy)}><span><Icon name="stop" /></span><strong>{t('recorder.finishKeepMaster')}</strong><kbd>SPACE</kbd></button>
                : entryBlocksAttempt && (primaryAction === 'start' || retakeSequenceReady)
                  ? <button data-testid="main-transport" className="main-transport waiting" onClick={() => {
                    if (deviceWarningOpen) { acknowledgeDeviceWarning(); return; }
                    if (noiseCheckBlocksAttempt) { if (snapshot) void runSessionNoiseCheck(sessionDir, snapshot); return; }
                    openInputAudition(false);
                  }} disabled={noiseCheckRunning || Boolean(busy)}><span><Icon name={inputAuditionBlocksAttempt || inputAuditionOpen ? 'headphones' : 'meter'} /></span><strong>{deviceWarningOpen ? t('deviceWarning.pendingCue') : noiseCheckRunning ? t('recorder.noiseChecking') : noiseCheckBlocksAttempt ? t('recorder.finishNoiseFirst') : t('inputAudition.open')}</strong></button>
                : recording
                  ? <button data-testid="main-transport" className={`main-transport ${isPendingTake || waitingForTailSilence ? 'waiting' : cue === 'ready' ? 'accept' : 'stop'}`} onClick={() => void stopAttempt()} disabled={Boolean(busy) || waitingForTailSilence}><span><Icon name="stop" /></span><strong>{isPendingTake ? t('recorder.pendingCancel') : waitingForTailSilence ? t('recorder.waitTailSilence') : t('recorder.finishSentence')}</strong>{isPendingTake ? <div className="transport-keys"><kbd>ESC</kbd><kbd>SPACE</kbd></div> : waitingForTailSilence ? null : <kbd>SPACE</kbd>}</button>
                : primaryAction === 'accept'
                  ? <button data-testid="main-transport" data-retake-action={hasRetakeDecision ? 'use' : undefined} className="main-transport accept" onClick={() => void acceptAttempt()} disabled={Boolean(busy) || !defaultAcceptAttemptSafe}><span><Icon name="check" /></span><strong>{hasRetakeDecision ? t('recorder.useRetakeCandidate') : acceptButtonLabel}</strong><kbd>SPACE</kbd></button>
                  : retakeSequenceReady
                    ? <button data-testid="main-transport" data-retake-sequence="ready" className="main-transport start" onClick={() => void startAttempt()} disabled={Boolean(busy)}><span><Icon name="retake" /></span><strong>{t('recorder.continueRetake')}</strong><kbd>SPACE</kbd></button>
                  : primaryAction === 'finish'
                    ? <button data-testid="main-transport" className="main-transport complete" onClick={requestFinishCapture} disabled={Boolean(busy)}><span><Icon name="check" /></span><strong>{t('recorder.finishAll')}</strong><kbd>SPACE</kbd></button>
                    : primaryAction === 'start'
                      ? <button data-testid="main-transport" className="main-transport start" onClick={() => void startAttempt()} disabled={Boolean(busy)}><span><Icon name="record" /></span><strong>{t('recorder.startRecording')}</strong><kbd>SPACE</kbd></button>
                      : <button data-testid="main-transport" className="main-transport handled" disabled><span><Icon name="check" /></span><strong>{t('recorder.itemHandled')}</strong><kbd>R</kbd></button>}
            </div>
              <div className="transport-secondary right">
                {captureActive && hasRetakeDecision && retainedDeliveryAttempt ? <button className="discard-retake-button" data-testid="discard-retake" onClick={() => void acceptAttempt(retainedDeliveryAttempt.attempt_id)} disabled={Boolean(busy) || !safeAttemptIds.has(retainedDeliveryAttempt.attempt_id)}><Icon name="close" /><span>{t('recorder.keepPreviousVersion')}</span></button> : null}
                {captureActive && retakeSequenceReady && allHandled ? <button data-testid="finish-retake-sequence" onClick={requestFinishCapture} disabled={Boolean(busy)}><Icon name="check" /><span>{t('recorder.finishCapture')}</span></button> : null}
                {captureActive && <button title={t('recorder.skipKey')} onClick={() => void skipItem()} disabled={captureFault || recording || Boolean(busy) || hasRetakeDecision || inputAuditionOpen || !inputAuditionDecision || !currentItem || !['pending', 'review'].includes(currentItem.status)}><Icon name="skip" /><span>{t('recorder.skip')}</span><kbd>S</kbd></button>}
              </div>
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
              <button className="detection-summary" onClick={() => setMonitorPanelTab('detection')}><span><strong>{t('recorder.silenceJudge')}</strong><small>{silenceDetector === 'vad' ? t('recorder.detectorVad') : `${noiseThresholdDbfs} dBFS`} / {(effectiveSilenceDurationMs / 1_000).toFixed(1)} {t('recorder.seconds')}</small></span><em>{t('recorder.adjust')}</em></button>
            </>}
            {monitorPanelTab === 'detection' && <section className="monitor-section detection-settings">
              <h3>{t('recorder.detectionTitle')}</h3>
              <p>{t('recorder.detectionHelp')}</p>
              <div className="detection-setting detector-choice">
                <header><span><strong>{t('recorder.detectorTitle')}</strong><small>{t('recorder.detectorHelp')}</small></span></header>
                <DetectorSelectCards value={silenceDetector} locked />
              </div>
              {silenceDetector === 'energy' ? <div className="detection-setting">
                <header><span><strong>{t('recorder.threshold')}</strong><small>{t('recorder.currentRms', { value: liveRmsDbfs <= -96 ? '−∞' : `${liveRmsDbfs.toFixed(1)} dBFS` })}</small></span><output>{silenceThresholdDraftDbfs} <small>dBFS</small></output></header>
                <div className="threshold-track"><i style={{ left: `${liveRmsOnThresholdScale}%` }} title={t('quality.currentRmsTitle', { value: liveRmsDbfs.toFixed(1) })} /><input data-testid="task-silence-threshold" aria-label={t('recorder.threshold')} aria-valuetext={`${silenceThresholdDraftDbfs} dBFS`} type="range" min="-72" max="-12" step="1" value={silenceThresholdDraftDbfs} onChange={(event) => setSilenceThresholdDraftDbfs(Number(event.target.value))} onPointerUp={(event) => void applyTaskSilenceSettings(Number(event.currentTarget.value), silenceDurationDraftMs)} onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void applyTaskSilenceSettings(Number(event.currentTarget.value), silenceDurationDraftMs); }} disabled={!captureActive || workspaceFaulted || captureFault || silenceSettingsSaving} /></div>
                <div className="threshold-labels"><span>{t('recorder.moreSensitive')}</span><span>{t('recorder.moreReject')}</span></div>
              </div> : null}
              <div className="detection-setting">
                <header><span><strong>{t('recorder.duration')}</strong><small>{t('recorder.sameDuration')}</small></span><output>{(silenceDurationDraftMs / 1_000).toFixed(1)} <small>{t('recorder.seconds')}</small></output></header>
                <input data-testid="task-silence-duration" aria-label={t('recorder.duration')} aria-valuetext={`${(silenceDurationDraftMs / 1_000).toFixed(1)} ${t('recorder.seconds')}`} type="range" min="200" max="5000" step="100" value={silenceDurationDraftMs} onChange={(event) => setSilenceDurationDraftMs(Number(event.target.value))} onPointerUp={(event) => void applyTaskSilenceSettings(silenceThresholdDraftDbfs, Number(event.currentTarget.value))} onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void applyTaskSilenceSettings(silenceThresholdDraftDbfs, Number(event.currentTarget.value)); }} disabled={!captureActive || workspaceFaulted || captureFault || silenceSettingsSaving} />
                <div className="threshold-labels"><span>0.2 {t('recorder.seconds')}</span><span>5.0 {t('recorder.seconds')}</span></div>
              </div>
              <p className={`settings-apply-state ${silenceSettingsError ? 'error' : ''}`}>{silenceSettingsSaving ? t('recorder.applyingSettings') : silenceSettingsError || (silenceDetector === 'vad'
                ? t('recorder.appliedSettingsVad', { seconds: (effectiveSilenceDurationMs / 1_000).toFixed(1) })
                : t('recorder.appliedSettings', { db: noiseThresholdDbfs, seconds: (effectiveSilenceDurationMs / 1_000).toFixed(1) }))}</p>
              <button className="restore-settings" onClick={() => void applyTaskSilenceSettings(taskInitialSilenceThresholdDbfs, taskInitialSilenceDurationMs)} disabled={!captureActive || workspaceFaulted || captureFault || silenceSettingsSaving || (noiseThresholdDbfs === taskInitialSilenceThresholdDbfs && silenceDurationMs === taskInitialSilenceDurationMs)}>{t('recorder.restoreInitial')}</button>
            </section>}
            {monitorPanelTab === 'settings' && <section className="monitor-section recording-settings" data-testid="task-recording-settings">
              <h3>{t('recorder.recordingSettingsTitle')}</h3>
              <p>{t('recorder.recordingSettingsHelp')}</p>
              <RecordingRuleGroups
                rules={automationRules}
                testIdPrefix="rule"
                discardEmptyHint={silenceDetector === 'vad' ? t('recorder.ruleDiscardEmptyHintVad') : t('recorder.ruleDiscardEmptyHint')}
                onChange={applyAutomationRule}
              />
              <footer className="task-settings-scope">
                <div><strong>{t('recorder.currentTaskOnly')}</strong><small>{t('recorder.currentTaskOnlyHint')}</small></div>
                <button type="button" className="restore-settings" data-testid="restore-task-recording-settings" onClick={restoreTaskAutomationRules} disabled={automationRulesEqual(automationRules, taskInitialAutomationRules)}>{t('recorder.restoreTaskRules')}</button>
                <button type="button" className="open-default-settings" data-testid="edit-new-task-defaults" onClick={() => setSettingsOpen(true)}>{t('recorder.editNewTaskDefaults')}</button>
              </footer>
            </section>}
            {monitorPanelTab === 'task' && <section className="monitor-section"><h3>{t('recorder.taskParams')}</h3><dl className="property-list"><div><dt>{t('setup.inputDevice')}</dt><dd title={snapshot?.device_name}>{snapshot?.device_name || t('common.dash')}</dd></div><div><dt>{t('inputAudition.statusLabel')}</dt><dd className={inputAuditionDecision?.status === 'skipped' ? 'warning' : ''}>{inputAuditionStatusLabel}</dd></div><div><dt>{t('recorder.detectorTitle')}</dt><dd>{silenceDetector === 'vad' ? t('recorder.detectorVad') : t('recorder.detectorEnergy')}</dd></div><div><dt>{t('setup.shareMode')}</dt><dd>{snapshot?.capture_backend?.toUpperCase() || captureShareModeLabel(snapshot?.capture_share_mode ?? captureShareMode)}{snapshot?.capture_buffer_frames ? ` · ${t('setup.bufferFrames', { frames: snapshot.capture_buffer_frames })}` : ''}</dd></div><div><dt>{t('setup.inputChannel')}</dt><dd>{snapshot?.audio_format.input_channel ?? 1}</dd></div><div><dt>{t('recorder.exportFormat')}</dt><dd>{sampleRateForDisplay / 1000}k / {deliveryBitDepthLabel(bitDepthForDisplay as DeliveryBitDepth)}</dd></div><div><dt>{t('recorder.envCeiling')}</dt><dd>{snapshot?.noise_threshold_dbfs ?? snapshot?.noise_check?.threshold_dbfs ?? t('common.dash')} dBFS</dd></div><div><dt>{t('recorder.accepted')}</dt><dd>{counts.accepted ?? 0} / {items.length}</dd></div><div><dt>{t('recorder.skipped')}</dt><dd>{counts.skipped ?? 0}</dd></div></dl>{captureActive && <button data-testid="recheck-input-audition" className="button panel-action" onClick={() => openInputAudition(true)} disabled={recording || Boolean(busy) || Boolean(captureFault) || workspaceFaulted}><Icon name="headphones" size={13} />{t('inputAudition.recheck')}</button>}<button className="button panel-action" onClick={() => void openPrompterPanel()}><Icon name="play" size={13} />{prompterStatus.ready ? t('recorder.locatePrompter') : t('recorder.openPrompter')}</button></section>}
            {monitorPanelTab === 'export' && snapshot && <section className="monitor-section monitor-export"><h3>{t('recorder.exportCurrent')}</h3><p>{captureActive ? recording ? t('recorder.exportWhileRecording') : t('recorder.exportWillPause') : t('recorder.exportIndependent')}</p><dl className="property-list export-status-summary"><div><dt>{t('p1.blocker')}</dt><dd>{workflowSummary.blockerCount}</dd></div><div><dt>{t('p1.warning')}</dt><dd>{workflowSummary.warningCount}</dd></div><div><dt>{t('recorder.retainedPreviousShort')}</dt><dd>{retainedPreviousWarningCount}</dd></div></dl><div className="export-scope-control" role="group" aria-label={t('p1.exportScopeTitle')}><button className={exportScope === 'confirmed_only' ? 'active' : ''} onClick={() => { setExportScope('confirmed_only'); setAcknowledgedExportWarnings([]); }}><strong>{t('p1.confirmedOnly')}</strong><small>{t('p1.confirmedOnlyHint')}</small></button><button className={exportScope === 'complete_task' ? 'active' : ''} onClick={() => { setExportScope('complete_task'); setAcknowledgedExportWarnings([]); }}><strong>{t('p1.completeTask')}</strong><small>{t('p1.completeTaskHint')}</small></button></div><div className={`export-readiness ${cutsReadiness.health}`}><strong>{cutsReadiness.ready ? t('p1.exportReady') : t('p1.exportNotReady')}</strong><span>{t('p1.exportReadinessCounts', { included: cutsReadiness.includedItemIds.length, excluded: cutsReadiness.excluded.length, blockers: cutsReadiness.blockers.length })}</span></div>{cutsReadiness.warningCodes.length > 0 && <div className="export-warning-acks"><strong>{t('p1.exportWarningsTitle')}</strong>{cutsReadiness.warningCodes.map((code) => <label key={code}><input type="checkbox" checked={acknowledgedExportWarnings.includes(code)} onChange={(event) => setAcknowledgedExportWarnings((current) => event.target.checked ? [...new Set([...current, code])] : current.filter((value) => value !== code))} /><span>{t(`p1.warningCode.${code}`)}</span></label>)}</div>}{exportDestinationPicker(sessionDir)}<div>
              <button onClick={() => void exportRecordingArtifact({ session_id: snapshot.session_id, session_dir: sessionDir }, 'full_track')} disabled={Boolean(busy) || recording}><Icon name="meter" /><span><strong>{t('recorder.fullTrackShort')}</strong><small>{artifactStatusCopy(workspaceRecording, 'full_track')}</small></span></button>
              <button onClick={() => void exportRecordingArtifact({ session_id: snapshot.session_id, session_dir: sessionDir }, 'timestamps_json')} disabled={Boolean(busy) || recording}><Icon name="file" /><span><strong>{t('recorder.timestampsShort')}</strong><small>{artifactStatusCopy(workspaceRecording, 'timestamps_json')}</small></span></button>
              <button onClick={() => void exportRecordingArtifact({ session_id: snapshot.session_id, session_dir: sessionDir }, 'cuts_zip', exportScope)} disabled={Boolean(busy) || recording || captureFault || workspaceFaulted || !cutsReadiness.ready || !exportWarningsAcknowledged}><Icon name="export" /><span><strong>{t('recorder.cutsShort')}</strong><small>{!cutsReadiness.ready ? t('p1.exportBlockedSummary', { count: cutsReadiness.blockers.length }) : !exportWarningsAcknowledged ? t('p1.exportAcknowledgeFirst') : artifactStatusCopy(workspaceRecording, 'cuts_zip')}</small></span></button>
            </div></section>}
            {monitorPanelTab === 'issues' && <section className="monitor-section monitor-issues issue-workbench" data-testid="issue-workbench">
              <header><div><h3>{t('recorder.issuesTitle')}</h3><small>{t('p1.issueSummary', { blockers: workbenchIssues.filter((issue) => issue.severity === 'blocker').length, warnings: workbenchIssues.filter((issue) => issue.severity === 'warning').length })}</small></div><div className="issue-navigation"><button onClick={() => moveWorkbenchIssue(-1)} disabled={recording || visibleWorkbenchIssues.length === 0} title={t('p1.previousIssue')}><Icon name="chevron-left" size={12} /></button><button onClick={() => moveWorkbenchIssue(1)} disabled={recording || visibleWorkbenchIssues.length === 0} title={t('p1.nextIssue')}><Icon name="chevron-right" size={12} /></button></div></header>
              <div className="issue-filters" role="group" aria-label={t('p1.issueFilterAria')}>{(['all', 'blocker', 'warning'] as const).map((filter) => <button key={filter} className={issueFilter === filter ? 'active' : ''} onClick={() => { setIssueFilter(filter); setSelectedIssueId(null); }}>{t(`p1.issueFilter.${filter}`)}</button>)}</div>
              {qualityWarning && <p><strong>{t('quality.bannerTitle')}</strong><span>{qualityWarning}</span></p>}
              {visibleWorkbenchIssues.length === 0 ? <div className="issue-empty"><Icon name="check" size={14} /><span>{t('p1.noIssuesInFilter')}</span>{!hasMonitorIssues ? <button data-testid="go-to-delivery" className="button primary" onClick={() => setMonitorPanelTab('export')}>{t('p1.goToDelivery')}</button> : null}</div> : <div className="issue-list">{visibleWorkbenchIssues.map((issue) => <button key={issue.id} className={`${issue.severity}${selectedIssueId === issue.id ? ' active' : ''}`} onClick={() => locateWorkbenchIssue(issue)} disabled={recording}>
                <i />
                <span><strong>{t(`p1.issueKind.${issue.kind}`)}</strong><small>{issue.itemId ? t('p1.issueItem', { id: issue.itemId }) : t('p1.issueTaskLevel')}</small></span>
                <em>{issue.severity === 'blocker' ? t('p1.blocker') : t('p1.warning')}</em>
              </button>)}</div>}
              {selectedWorkbenchIssue && <div className={`issue-resolution ${selectedWorkbenchIssue.severity}`} data-testid="issue-resolution">
                <div><strong>{t(`p1.issueKind.${selectedWorkbenchIssue.kind}`)}</strong><small>{selectedWorkbenchIssue.itemId ? t('p1.issueItem', { id: selectedWorkbenchIssue.itemId }) : t('p1.issueTaskLevel')}</small></div>
                {selectedWorkbenchIssue.itemIndex !== null && items[selectedWorkbenchIssue.itemIndex]
                  ? !captureActive
                    ? <button className="button primary" onClick={() => void activateCapture(items[selectedWorkbenchIssue.itemIndex!]?.id)} disabled={Boolean(busy) || workspaceFaulted}><Icon name="microphone" size={13} />{t('recorder.enterCapture')}</button>
                    : currentItem?.id !== items[selectedWorkbenchIssue.itemIndex]?.id
                      ? <button className="button" onClick={() => locateWorkbenchIssue(selectedWorkbenchIssue)} disabled={recording || Boolean(busy)}>{t('p1.issueLocated')}</button>
                      : currentItem.status === 'review'
                        ? <div className="issue-resolution-actions">
                          {hasRetakeChoice && retainedDeliveryAttempt ? <button onClick={() => void previewAttempt(retainedDeliveryAttempt.attempt_id)} disabled={Boolean(busy) || !safeAttemptIds.has(retainedDeliveryAttempt.attempt_id)}><Icon name="play" size={12} />{t('recorder.currentDeliveryVersion')}</button> : null}
                          <button onClick={() => void previewAttempt()} disabled={Boolean(busy) || !reviewAttempt}><Icon name="play" size={12} />{hasRetakeChoice ? t('recorder.previewCandidate') : t('recorder.preview')}</button>
                          <button className="primary" onClick={() => void acceptAttempt(undefined, { autoStartNext: false })} disabled={Boolean(busy) || !defaultAcceptAttemptSafe}><Icon name="check" size={12} />{hasRetakeChoice ? t('recorder.useRetakeCandidate') : t('recorder.acceptThis')}</button>
                          {hasRetakeChoice && retainedDeliveryAttempt
                            ? <button onClick={() => void acceptAttempt(retainedDeliveryAttempt.attempt_id, { autoStartNext: false })} disabled={Boolean(busy) || !safeAttemptIds.has(retainedDeliveryAttempt.attempt_id)}>{t('recorder.keepPreviousVersion')}</button>
                            : <button onClick={() => void startAttempt(currentItem, { beginRetakeSequence: true })} disabled={Boolean(busy) || captureFault || entryBlocksAttempt}><Icon name="retake" size={12} />{t('recorder.retake')}</button>}
                        </div>
                        : selectedWorkbenchIssue.kind !== 'inconsistent'
                          ? <button className="button primary" onClick={() => void startAttempt(currentItem, { beginRetakeSequence: true })} disabled={Boolean(busy) || captureFault || entryBlocksAttempt}><Icon name="retake" size={13} />{t('recorder.retake')}</button>
                          : <small>{t('p1.issueNavigationHint')}</small>
                  : <small>{t('p1.issueNavigationHint')}</small>}
              </div>}
              <footer>{t('p1.issueNavigationHint')}</footer>
            </section>}
          </div>
          <nav className="monitor-tabs" aria-label={t('recorder.tabsAria')}>
            <button className={monitorPanelTab === 'monitor' ? 'active' : ''} onClick={() => setMonitorPanelTab('monitor')} title={t('recorder.tabMonitor')}><Icon name="headphones" /><span>{t('recorder.tabMonitor')}</span></button>
            <button className={monitorPanelTab === 'detection' ? 'active' : ''} onClick={() => setMonitorPanelTab('detection')} title={t('recorder.tabDetectionTitle')}><Icon name="sliders" /><span>{t('recorder.tabDetection')}</span></button>
            <button className={monitorPanelTab === 'settings' ? 'active' : ''} onClick={() => setMonitorPanelTab('settings')} title={t('recorder.tabSettingsTitle')}><Icon name="settings" /><span>{t('recorder.tabSettings')}</span></button>
            <button className={monitorPanelTab === 'task' ? 'active' : ''} onClick={() => setMonitorPanelTab('task')} title={t('recorder.tabTask')}><Icon name="file" /><span>{t('recorder.tabTask')}</span></button>
            <button className={monitorPanelTab === 'export' ? 'active' : ''} onClick={() => setMonitorPanelTab('export')} title={t('recorder.tabExport')}><Icon name="export" /><span>{t('recorder.tabExport')}</span></button>
            {(hasMonitorIssues || monitorPanelTab === 'issues') && <button className={monitorPanelTab === 'issues' ? 'active issue' : 'issue'} onClick={() => setMonitorPanelTab('issues')} title={t('recorder.tabIssues')}><Icon name="stop" /><span>{t('recorder.tabIssues')}</span></button>}
          </nav>
        </div>
        <div className="inspector-footer">
          {footerActions.showEnterCapture && <button data-testid="enter-capture" className="button finish-session enter-capture" title={t('recorder.enterCaptureKey')} onClick={() => void activateCapture(currentItem?.id)} disabled={Boolean(busy) || workspaceFaulted}><Icon name="microphone" size={14} />{t('recorder.enterCapture')}<kbd>R</kbd></button>}
          {footerActions.showPauseCapture
            ? <div className="inspector-exits">
              <button data-testid="pause-capture" className="button inspector-exit" onClick={requestPauseCapture} disabled={Boolean(busy)}><Icon name="pause" size={12} />{t('recorder.pauseCapture')}</button>
              <button data-testid="finish-session" className="button inspector-exit" onClick={() => void finishSession()} disabled={Boolean(busy)}><Icon name="chevron-left" size={12} />{t('recorder.leaveTask')}</button>
            </div>
            : <button data-testid="finish-session" className={`button finish-session ${footerActions.leaveKind === 'fault' ? '' : 'leave-task'}`} onClick={() => void finishSession()} disabled={Boolean(busy)}><Icon name={footerActions.leaveKind === 'view' ? 'chevron-left' : 'stop'} size={14} />{footerActions.leaveKind === 'view' ? t('recorder.leaveView') : t('recorder.finishAndLeave')}</button>}
        </div>
      </aside>
    </div>
    {inputAuditionOpen && snapshot && captureActive && <InputAuditionDialog
      key={`${snapshot.session_id}:${activeInputAuditionConfigurationKey}:${inputAuditionForce ? 'force' : 'automatic'}`}
      snapshot={snapshot}
      force={inputAuditionForce}
      onSnapshot={setSnapshot}
      onResolved={resolveInputAudition}
      onCancel={cancelInputAuditionGate}
    />}
    {showDeviceWarningDialog && deviceWarningKind && <DeviceWarningDialog
      kind={deviceWarningKind}
      deviceName={snapshot?.device_name || deviceName}
      busy={Boolean(busy)}
      onContinue={acknowledgeDeviceWarning}
      onLeave={requestSafePause}
    />}
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
      onLeave={requestSafePause}
      onSkip={skipCurrentSessionEnvCheck}
    />}
    {pauseConfirmOpen && !captureFault && <div className="dialog-backdrop" role="presentation">
      <section className="studio-dialog" role="dialog" aria-modal="true" aria-labelledby="pause-dialog-title">
        <header><span className="dialog-icon"><Icon name={pauseDestination === 'stay' ? 'pause' : 'chevron-left'} size={19} /></span><div><h2 id="pause-dialog-title">{pauseDestination === 'stay'
          ? recording ? t('pauseDialog.titleRecordingStay') : t('pauseDialog.titleIdleStay')
          : recording ? t('pauseDialog.titleRecording') : t('pauseDialog.titleIdle')}</h2></div></header>
        <p>{pauseDestination === 'stay'
          ? recording
            ? hasSpoken ? t('pauseDialog.spokenStay') : t('pauseDialog.silentStay')
            : t('pauseDialog.idleStay')
          : recording
            ? hasSpoken ? t('pauseDialog.spoken') : t('pauseDialog.silent')
            : t('pauseDialog.idle')}</p>
        <dl className="dialog-summary"><div><dt>{t('recorder.accepted')}</dt><dd>{counts.accepted ?? 0}</dd></div><div><dt>{t('recorder.skipped')}</dt><dd>{counts.skipped ?? 0}</dd></div><div><dt>{t('recorder.pending')}</dt><dd className={(counts.pending ?? 0) + (counts.review ?? 0) ? 'warning' : ''}>{(counts.pending ?? 0) + (counts.review ?? 0)}</dd></div></dl>
        <div className="dialog-warning">{pauseDestination === 'stay' ? t('pauseDialog.warningStay') : t('pauseDialog.warning')}</div>
        <footer><button data-testid="pause-cancel" data-dialog-initial className="button" onClick={() => setPauseConfirmOpen(false)} disabled={Boolean(busy)}>{t('pauseDialog.keepRecording')}</button><button data-testid="pause-confirm" data-dialog-default className="button primary" onClick={() => void safePauseAndReturn()} disabled={Boolean(busy)}><Icon name={pauseDestination === 'stay' ? 'pause' : 'stop'} size={14} />{pauseDestination === 'stay'
          ? recording ? t('pauseDialog.endAndStay') : t('pauseDialog.pauseStay')
          : recording ? t('pauseDialog.endAndLeave') : t('pauseDialog.pauseAndLeave')}</button></footer>
      </section>
    </div>}
    {previewOpen && audioUrl && <PreviewPlayer
      url={audioUrl}
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
        <footer><button data-testid="finish-cancel" data-dialog-initial className="button" onClick={() => setFinishConfirmOpen(false)}>{captureFault ? t('finishDialog.stayFault') : t('common.cancel')}</button><button data-testid="finish-confirm" data-dialog-default className="button primary" onClick={() => void confirmFinishSession()} disabled={Boolean(busy)}><Icon name={captureFault ? 'stop' : 'check'} size={14} />{captureFault ? t('finishDialog.confirmFault') : t('finishDialog.confirmNormal')}</button></footer>
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
