import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  EngineClient,
  EngineRequestError,
  EngineRequestTimeoutError,
  EngineSafeStopTimeoutError,
  EngineUnsafeStopError,
  type EngineStoppedOutcome,
} from './engine-client';

let mainWindow: BrowserWindow | null = null;
let prompterWindow: BrowserWindow | null = null;
let latestPrompterState: unknown = null;
let engine: EngineClient | null = null;
let recordingTray: Tray | null = null;
let closeDecisionPromise: Promise<void> | null = null;
let safeExitPromise: Promise<void> | null = null;
let exportExitPromise: Promise<void> | null = null;
let quitWhenEngineStops = false;
let idleWhenEngineStopsGeneration: number | null = null;
let unsafeEngineStopPromise: Promise<void> | null = null;
let forceExitConfirmed = false;
let appQuitReleased = false;
let engineRecoveryPromise: Promise<void> | null = null;
let pendingEngineRecovery: EngineRecoveryJob | null = null;
let windowCreationPromise: Promise<BrowserWindow> | null = null;
let windowRecoveryPromise: Promise<void> | null = null;
const forceCloseWindows = new WeakSet<BrowserWindow>();
const allowedOutputRoots = new Set<string>();
const canonicalOutputRoots = new Map<string, string>();
const knownSessionDirs = new Set<string>();
const knownSessionIds = new Map<string, string>();

type EnginePhase = 'idle' | 'starting' | 'active' | 'stopping' | 'recovering' | 'sealing' | 'exporting' | 'quitting';

type EngineIntent = Readonly<{
  generation: number;
  phase: EnginePhase;
  sessionDir: string | null;
}>;

type EngineOptionalState = {
  active?: unknown;
  session_dir?: unknown;
  snapshot?: unknown;
  [key: string]: unknown;
};

type EngineRecoveryJob = {
  intent: EngineIntent;
  originalError: string;
};

type PendingCrashSeal = {
  sessionDir: string;
  expectedSessionId: string | null;
  originalError: string;
};

let pendingCrashSeal: PendingCrashSeal | null = null;

type ActiveExportOperation = {
  intent: EngineIntent;
  completion: Promise<unknown>;
};

let activeExportOperation: ActiveExportOperation | null = null;

type HistorySnapshotCandidate = {
  snapshot: Record<string, unknown>;
  journalSeq: number;
  priority: number;
  ordinal: number;
  modifiedAtMs: number;
};

export type AuthorizedSessionBinding = Readonly<{
  canonicalPath: string;
  canonicalRoot: string;
  sessionId: string;
  device: bigint;
  inode: bigint;
}>;

export class AuthorizedSessionBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthorizedSessionBindingError';
  }
}

let engineIntentSequence = 0;
let engineIntent: EngineIntent = {
  generation: engineIntentSequence,
  phase: 'idle',
  sessionDir: null,
};

class EngineIntentSupersededError extends Error {
  constructor() {
    super('录音操作已被更新的操作取代');
    this.name = 'EngineIntentSupersededError';
  }
}

class EngineStateReconciliationError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly reconciliationError: unknown,
  ) {
    const original = originalError instanceof Error ? originalError.message : String(originalError);
    const reconciliation = reconciliationError instanceof Error
      ? reconciliationError.message
      : String(reconciliationError);
    super(`录音命令结果无法确认：${original}；状态对账失败：${reconciliation}`);
    this.name = 'EngineStateReconciliationError';
  }
}

class EngineSessionConflictError extends Error {
  constructor(
    readonly sessionDir: string,
    readonly phase: 'active' | 'stopping' = 'active',
  ) {
    super(`录音引擎正在处理另一个任务：${sessionDir}`);
    this.name = 'EngineSessionConflictError';
  }
}

const TRAY_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAK0lEQVR42mNgGJTAZ9+O/9gw2RqJNogiA4jVjNOQUQOoYMDApwOqJOUBAQBP8VWMCa6Y5gAAAABJRU5ErkJggg==';
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
const JOURNAL_MAX_BYTES = 128 * 1024 * 1024;
const SESSION_IDENTITY_MAX_BYTES = 1024 * 1024;
const EXPORT_STATUS_MAX_BYTES = 64 * 1024;
const EXPORT_REQUEST_TIMEOUT_MS = (() => {
  const productionTimeout = 12 * 60 * 60_000;
  if (process.env.NODE_ENV !== 'test') return productionTimeout;
  const override = Number(process.env.DATABAKER_TEST_EXPORT_TIMEOUT_MS);
  return Number.isSafeInteger(override) && override >= 100 ? override : productionTimeout;
})();

const allowedCommands = new Set([
  'hello',
  'list_devices',
  'start_session',
  'resume_session',
  'get_state_optional',
  'check_noise',
  'start_attempt',
  'stop_attempt',
  'accept_attempt',
  'skip_item',
  'render_attempt',
  'get_state',
  'stop_session',
  'seal_interrupted_session',
  'export_session',
]);

const SESSION_LIVE_PHASES: readonly EnginePhase[] = [
  'starting',
  'active',
  'stopping',
  'recovering',
];

function beginEngineIntent(phase: EnginePhase, sessionDir: string | null): EngineIntent {
  const intent: EngineIntent = {
    generation: ++engineIntentSequence,
    phase,
    sessionDir,
  };
  engineIntent = intent;
  return intent;
}

function ownsEngineGeneration(intent: EngineIntent): boolean {
  return engineIntent.generation === intent.generation;
}

function isCurrentEngineIntent(
  intent: EngineIntent,
  phases: readonly EnginePhase[],
): boolean {
  return ownsEngineGeneration(intent) && phases.includes(engineIntent.phase);
}

function assertCurrentEngineIntent(
  intent: EngineIntent,
  phases: readonly EnginePhase[],
): void {
  if (!isCurrentEngineIntent(intent, phases)) throw new EngineIntentSupersededError();
}

function transitionEngineIntent(
  intent: EngineIntent,
  phase: EnginePhase,
  sessionDir: string | null = engineIntent.sessionDir,
): EngineIntent | null {
  if (!ownsEngineGeneration(intent)) return null;
  engineIntent = {
    generation: intent.generation,
    phase,
    sessionDir,
  };
  return engineIntent;
}

function isQuitting(): boolean {
  return engineIntent.phase === 'quitting';
}

function releaseApplicationQuit(): void {
  // This is the sole release gate for an application quit. Keep it set after
  // confirmation because Electron may close windows asynchronously after
  // app.quit() returns; at this point the engine is safely stopped or the
  // operator explicitly accepted the force/unconfirmed-exit consequence.
  appQuitReleased = true;
  app.quit();
}

function normalizedSessionDir(sessionDir: string): string {
  const normalized = path.normalize(path.resolve(sessionDir));
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function isSameSessionDir(left: string, right: string): boolean {
  return normalizedSessionDir(left) === normalizedSessionDir(right);
}

function rememberKnownSession(sessionDir: string, sessionId: string): void {
  knownSessionDirs.add(sessionDir);
  knownSessionIds.set(normalizedSessionDir(sessionDir), sessionId);
}

function forgetKnownSession(sessionDir: string): void {
  knownSessionDirs.delete(sessionDir);
  knownSessionIds.delete(normalizedSessionDir(sessionDir));
}

function knownSessionId(sessionDir: string): string | null {
  return knownSessionIds.get(normalizedSessionDir(sessionDir)) ?? null;
}

function crashSealMatches(sessionDir: string): boolean {
  return Boolean(
    pendingCrashSeal && isSameSessionDir(pendingCrashSeal.sessionDir, sessionDir),
  );
}

function clearCrashSealObligation(sessionDir: string): void {
  if (crashSealMatches(sessionDir)) pendingCrashSeal = null;
}

function retainCrashSealObligation(sessionDir: string, originalError: string): void {
  const existing = crashSealMatches(sessionDir) ? pendingCrashSeal : null;
  pendingCrashSeal = {
    sessionDir,
    expectedSessionId: existing?.expectedSessionId ?? knownSessionId(sessionDir),
    originalError: existing?.originalError ?? originalError,
  };
}

function intentTracksLiveSession(intent = engineIntent): boolean {
  return Boolean(intent.sessionDir && SESSION_LIVE_PHASES.includes(intent.phase));
}

function isIntentSession(sessionDir: string): boolean {
  return Boolean(
    intentTracksLiveSession()
      && engineIntent.sessionDir
      && isSameSessionDir(engineIntent.sessionDir, sessionDir),
  );
}

function operationBusyMessage(): string {
  switch (engineIntent.phase) {
    case 'starting': return '录音任务正在启动，请稍候';
    case 'active': return '当前已有录音任务进行中';
    case 'stopping': return '录音任务正在安全停止，请稍候';
    case 'recovering': return '录音引擎正在恢复，请稍候';
    case 'sealing': return '中断任务正在修复并封存，请稍候';
    case 'exporting': return '录音交付正在导出，请等待完成';
    case 'quitting': return '应用正在安全退出';
    default: return '录音操作暂时不可用';
  }
}

function assertCanStartOrResume(allowPendingCrashSeal = false): void {
  if (engineIntent.phase !== 'idle') throw new Error(operationBusyMessage());
  if (pendingCrashSeal && !allowPendingCrashSeal) {
    throw new Error('上次引擎异常退出的录制任务尚未确认封存，请先在历史任务中修复并封存');
  }
}

function assertCanMutateActiveSession(command: string): void {
  if (engineIntent.phase === 'exporting') throw new Error(operationBusyMessage());
  if (['hello', 'list_devices', 'get_state_optional'].includes(command)) return;
  if (engineIntent.phase === 'starting'
    || engineIntent.phase === 'stopping'
    || engineIntent.phase === 'recovering'
    || engineIntent.phase === 'sealing'
    || engineIntent.phase === 'quitting') {
    throw new Error(operationBusyMessage());
  }
  if (command === 'export_session') return;
}

function engineExecutable(): string {
  const executable = process.platform === 'win32' ? 'recorder-engine.exe' : 'recorder-engine';
  if (app.isPackaged) return path.join(process.resourcesPath, 'bin', executable);
  return path.join(app.getAppPath(), 'engine', 'target', 'debug', executable);
}

function defaultOutputRoot(): string {
  return process.env.DATABAKER_DEFAULT_OUTPUT
    ? path.resolve(process.env.DATABAKER_DEFAULT_OUTPUT)
    : path.join(app.getPath('documents'), 'DataBaker Recordings');
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isAllowedOutputRoot(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return allowedOutputRoots.has(resolved);
}

function isAllowedNewSession(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return Array.from(allowedOutputRoots).some((root) => path.dirname(resolved) === root);
}

async function resolveAuthorizedOutputRoot(candidate: string, create: boolean): Promise<string> {
  const lexical = path.resolve(candidate);
  if (!allowedOutputRoots.has(lexical)) throw new Error('只能使用已授权的录制保存目录');
  if (create) await fs.mkdir(lexical, { recursive: true });
  const canonical = await fs.realpath(lexical);
  const remembered = canonicalOutputRoots.get(lexical);
  if (remembered && remembered !== canonical) {
    throw new Error('录制保存目录已发生变化，请重新选择保存位置');
  }
  canonicalOutputRoots.set(lexical, canonical);
  return canonical;
}

async function isInsideKnownSession(candidate: string): Promise<boolean> {
  let target: string;
  try {
    target = await fs.realpath(path.resolve(candidate));
  } catch {
    return false;
  }
  for (const known of knownSessionDirs) {
    if (isWithin(known, target)) return true;
  }
  return false;
}

async function resolveKnownSession(candidate: string): Promise<string | null> {
  try {
    const canonical = await fs.realpath(path.resolve(candidate));
    return knownSessionDirs.has(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function observedActiveSnapshotStatus(state: EngineOptionalState): string | null {
  return isRecord(state.snapshot) && typeof state.snapshot.status === 'string'
    ? state.snapshot.status
    : null;
}

function observedLivePhase(state: EngineOptionalState): 'active' | 'stopping' {
  return observedActiveSnapshotStatus(state) === 'recording' ? 'active' : 'stopping';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidAttempt(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.attempt_id === 'string'
    && isNonNegativeSafeInteger(value.start_sample)
    && (value.recording_started_sample === undefined
      || isNonNegativeSafeInteger(value.recording_started_sample))
    && (value.content_started_sample === undefined
      || isNonNegativeSafeInteger(value.content_started_sample))
    && isNonNegativeSafeInteger(value.end_sample)
    && (value.forced_without_tail_silence === undefined
      || typeof value.forced_without_tail_silence === 'boolean')
    && (value.tail_silence_samples === undefined
      || isNonNegativeSafeInteger(value.tail_silence_samples))
    && (value.required_tail_silence_samples === undefined
      || isNonNegativeSafeInteger(value.required_tail_silence_samples))
    && typeof value.status === 'string'
    && typeof value.created_at === 'string';
}

function isValidSnapshotItem(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.attempts)) return false;
  return typeof value.id === 'string'
    && typeof value.text === 'string'
    && typeof value.label === 'string'
    && typeof value.status === 'string'
    && value.attempts.every(isValidAttempt)
    && (value.selected_attempt_id === undefined
      || value.selected_attempt_id === null
      || typeof value.selected_attempt_id === 'string');
}

function isValidNoiseCheck(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (!isRecord(value) || !Array.isArray(value.samples)) return false;
  return typeof value.passed === 'boolean'
    && isFiniteNumber(value.threshold_dbfs)
    && isFiniteNumber(value.average_dbfs)
    && isFiniteNumber(value.maximum_dbfs)
    && isNonNegativeSafeInteger(value.failing_windows)
    && value.samples.every(isFiniteNumber)
    && typeof value.completed_at === 'string';
}

function isValidAudioFormat(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isNonNegativeSafeInteger(value.sample_rate)
    && value.sample_rate > 0
    && (value.bit_depth === undefined || isNonNegativeSafeInteger(value.bit_depth))
    && (value.encoding === undefined || typeof value.encoding === 'string')
    && isNonNegativeSafeInteger(value.channels)
    && value.channels > 0
    && isNonNegativeSafeInteger(value.input_channels)
    && value.input_channels > 0
    && (value.input_channel === undefined || isNonNegativeSafeInteger(value.input_channel));
}

function isValidStorageLayout(value: Record<string, unknown>): boolean {
  const audioFormat = value.audio_format;
  if (!isRecord(audioFormat)
    || !isNonNegativeSafeInteger(audioFormat.sample_rate)
    || audioFormat.sample_rate === 0) return false;
  if (value.storage_layout_version !== undefined && value.storage_layout_version !== 1) {
    return false;
  }
  if (value.segment_frames === undefined) return true;
  if (!isNonNegativeSafeInteger(value.segment_frames) || value.segment_frames === 0) return false;
  const sampleRate = audioFormat.sample_rate;
  return value.segment_frames >= sampleRate && value.segment_frames <= sampleRate * 60 * 60;
}

function isValidCaptureProvenance(
  value: unknown,
  audioFormat: unknown,
  committedSamples: unknown,
): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !isRecord(audioFormat)
    || !isNonNegativeSafeInteger(audioFormat.sample_rate)
    || !isNonNegativeSafeInteger(committedSamples)) return false;
  let cursor = 0;
  for (const span of value) {
    if (!isRecord(span)
      || span.start_sample !== cursor
      || !isNonNegativeSafeInteger(span.end_sample)
      || span.end_sample < cursor
      || span.end_sample > committedSamples
      || typeof span.device_name !== 'string'
      || typeof span.device_id !== 'string'
      || typeof span.input_sample_format !== 'string'
      || span.input_sample_format.trim() === ''
      || !isNonNegativeSafeInteger(span.input_channels)
      || span.input_channels === 0
      || !isNonNegativeSafeInteger(span.input_channel)
      || span.input_channel === 0
      || span.input_channel > span.input_channels
      || span.sample_rate !== audioFormat.sample_rate) return false;
    cursor = span.end_sample;
  }
  return value.length === 0 || cursor === committedSamples;
}

function parseValidSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)
    || value.schema_version !== 1
    || typeof value.session_id !== 'string'
    || value.session_id.trim() === ''
    || (value.journal_seq !== undefined && !isNonNegativeSafeInteger(value.journal_seq))
    || (value.script_name !== undefined && typeof value.script_name !== 'string')
    || typeof value.status !== 'string'
    || typeof value.device_name !== 'string'
    || (value.device_id !== undefined && typeof value.device_id !== 'string')
    || (value.input_sample_format !== undefined && typeof value.input_sample_format !== 'string')
    || !isValidAudioFormat(value.audio_format)
    || typeof value.master_audio !== 'string'
    || !isValidStorageLayout(value)
    || !isNonNegativeSafeInteger(value.captured_samples)
    || !isNonNegativeSafeInteger(value.committed_samples)
    || !isNonNegativeSafeInteger(value.overflow_samples)
    || !isValidCaptureProvenance(
      value.capture_provenance,
      value.audio_format,
      value.committed_samples,
    )
    || typeof value.started_at !== 'string'
    || typeof value.updated_at !== 'string'
    || !isValidNoiseCheck(value.noise_check)
    || (value.silence_duration_ms !== undefined
      && !isNonNegativeSafeInteger(value.silence_duration_ms))
    || (value.silence_threshold_dbfs !== undefined
      && !isFiniteNumber(value.silence_threshold_dbfs))
    || !Array.isArray(value.items)
    || !value.items.every(isValidSnapshotItem)) {
    return null;
  }
  return value;
}

async function findAudioFaultMarker(metadataDir: string): Promise<number | null> {
  let newestModifiedAtMs: number | null = null;
  for (const name of ['audio-fault.json', 'audio-fault.tmp']) {
    try {
      const marker = await fs.lstat(path.join(metadataDir, name));
      // Treat every object at a reserved fault-marker name as a fault. A
      // malformed file or symlink must never turn a fail-closed recording back
      // into an apparently healthy resumable task.
      newestModifiedAtMs = Math.max(newestModifiedAtMs ?? 0, marker.mtimeMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        newestModifiedAtMs = Math.max(newestModifiedAtMs ?? 0, Date.now());
      }
    }
  }
  return newestModifiedAtMs;
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<{ bytes: Buffer; modifiedAtMs: number } | null> {
  try {
    const metadata = await fs.lstat(filePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) return null;
    const canonical = await fs.realpath(filePath);
    if (!isSameSessionDir(canonical, filePath)) return null;
    const bytes = await fs.readFile(filePath);
    if (bytes.byteLength > maxBytes) return null;
    const afterRead = await fs.lstat(filePath);
    if (afterRead.isSymbolicLink()
      || !afterRead.isFile()
      || afterRead.size > maxBytes
      || (metadata.ino !== 0 && afterRead.ino !== 0 && metadata.ino !== afterRead.ino)
      || metadata.dev !== afterRead.dev) return null;
    return { bytes, modifiedAtMs: afterRead.mtimeMs };
  } catch {
    return null;
  }
}

function snapshotGenerationPaths(metadataDir: string): Array<{ filePath: string; priority: number }> {
  const finalPath = path.join(metadataDir, 'items.snapshot.json');
  const parsed = path.parse(finalPath);
  const withExtension = (extension: string) => path.join(parsed.dir, `${parsed.name}.${extension}`);
  const paths = [
    { filePath: finalPath, priority: 30 },
    { filePath: withExtension('tmp'), priority: 20 },
    { filePath: withExtension('prev'), priority: 10 },
    { filePath: withExtension('backup'), priority: 9 },
    { filePath: `${finalPath}.prev`, priority: 10 },
    { filePath: `${finalPath}.backup`, priority: 9 },
    { filePath: `${finalPath}.bak`, priority: 8 },
  ];
  const seen = new Set<string>();
  return paths.filter(({ filePath }) => {
    const normalized = normalizedSessionDir(filePath);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function compareSnapshotCandidate(left: HistorySnapshotCandidate, right: HistorySnapshotCandidate): number {
  return left.journalSeq - right.journalSeq
    || left.priority - right.priority
    || left.ordinal - right.ordinal;
}

async function readSessionIdentity(sessionDir: string): Promise<string | null> {
  const source = await readBoundedRegularFile(
    path.join(sessionDir, 'session.json'),
    SESSION_IDENTITY_MAX_BYTES,
  );
  if (!source) return null;
  try {
    const value = JSON.parse(source.bytes.toString('utf8')) as unknown;
    if (!isRecord(value)
      || value.schema_version !== 1
      || typeof value.session_id !== 'string'
      || value.session_id.trim() === '') return null;
    return value.session_id;
  } catch {
    return null;
  }
}

export async function bindAuthorizedSession(
  candidate: string,
  authorizedRoots: readonly string[],
  expectedSessionId: string,
): Promise<AuthorizedSessionBinding> {
  try {
    const lexical = path.resolve(candidate);
    const metadata = await fs.lstat(lexical, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new AuthorizedSessionBindingError('录制任务目录不是普通目录');
    }
    const canonicalPath = await fs.realpath(lexical);
    if (!isSameSessionDir(canonicalPath, lexical)) {
      throw new AuthorizedSessionBindingError('录制任务目录已被链接到其他位置');
    }
    const canonicalRoot = await fs.realpath(path.dirname(canonicalPath));
    const rootAuthorized = authorizedRoots.some((root) => isSameSessionDir(root, canonicalRoot));
    if (!rootAuthorized || !isSameSessionDir(path.dirname(canonicalPath), canonicalRoot)) {
      throw new AuthorizedSessionBindingError('录制任务已离开授权的保存位置，请重新选择保存目录');
    }
    const sessionId = await readSessionIdentity(canonicalPath);
    if (!sessionId || sessionId !== expectedSessionId) {
      throw new AuthorizedSessionBindingError('录制任务身份与历史列表不一致，请刷新任务后重试');
    }
    return {
      canonicalPath,
      canonicalRoot,
      sessionId,
      device: metadata.dev,
      inode: metadata.ino,
    };
  } catch (error) {
    if (error instanceof AuthorizedSessionBindingError) throw error;
    throw new AuthorizedSessionBindingError(
      `无法重新确认录制任务目录：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function assertAuthorizedSessionUnchanged(
  binding: AuthorizedSessionBinding,
  authorizedRoots: readonly string[],
): Promise<void> {
  const current = await bindAuthorizedSession(
    binding.canonicalPath,
    authorizedRoots,
    binding.sessionId,
  );
  if ((binding.device !== 0n && current.device !== 0n && binding.device !== current.device)
    || (binding.inode !== 0n && current.inode !== 0n && binding.inode !== current.inode)) {
    throw new AuthorizedSessionBindingError('录制任务目录在操作前被替换，请刷新任务后重试');
  }
}

function exportSourceForSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> | null {
  if (!isNonNegativeSafeInteger(snapshot.journal_seq)
    || !isNonNegativeSafeInteger(snapshot.committed_samples)
    || !Array.isArray(snapshot.items)) return null;
  const selectedAttempts: Array<{ id: string; attempt_id: string | null }> = [];
  for (const item of snapshot.items) {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || (item.selected_attempt_id !== undefined
        && item.selected_attempt_id !== null
        && typeof item.selected_attempt_id !== 'string')) return null;
    selectedAttempts.push({
      id: item.id,
      attempt_id: typeof item.selected_attempt_id === 'string' ? item.selected_attempt_id : null,
    });
  }
  return {
    journal_seq: snapshot.journal_seq,
    committed_samples: snapshot.committed_samples,
    selected_attempts: selectedAttempts,
  };
}

function exportSourceMatchesSnapshot(
  source: unknown,
  snapshot: Record<string, unknown>,
): boolean {
  const expected = exportSourceForSnapshot(snapshot);
  if (!expected || !isRecord(source)) return false;
  if (source.journal_seq !== expected.journal_seq
    || source.committed_samples !== expected.committed_samples
    || !Array.isArray(source.selected_attempts)) return false;
  const expectedSelections = expected.selected_attempts as Array<{ id: string; attempt_id: string | null }>;
  if (source.selected_attempts.length !== expectedSelections.length) return false;
  return source.selected_attempts.every((selection, index) => isRecord(selection)
    && selection.id === expectedSelections[index].id
    && selection.attempt_id === expectedSelections[index].attempt_id);
}

export async function hasCompleteExport(
  exportDir: string,
  currentSnapshot?: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (!currentSnapshot
      || currentSnapshot.status !== 'stopped'
      || currentSnapshot.audio_fault_marker === true
      || !isNonNegativeSafeInteger(currentSnapshot.overflow_samples)
      || currentSnapshot.overflow_samples !== 0) return false;
    const directory = await fs.lstat(exportDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    if (!isSameSessionDir(await fs.realpath(exportDir), exportDir)) return false;

    const statusPath = path.join(exportDir, 'status.json');
    let statusExists = false;
    try {
      await fs.lstat(statusPath);
      statusExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    if (statusExists) {
      const source = await readBoundedRegularFile(statusPath, EXPORT_STATUS_MAX_BYTES);
      if (!source) return false;
      try {
        const status = JSON.parse(source.bytes.toString('utf8')) as unknown;
        if (!isRecord(status)
          || status.schema_version !== 2
          || status.status !== 'complete'
          || typeof status.export_id !== 'string'
          || status.export_id.trim() === ''
          || status.session_id !== currentSnapshot.session_id
          || !exportSourceMatchesSnapshot(status.source, currentSnapshot)) return false;
      } catch {
        return false;
      }
      const requiredFiles = ['full-track.wav', 'metadata.json', 'metadata.csv'];
      const filesComplete = await Promise.all(requiredFiles.map(async (fileName) => {
        const metadata = await fs.lstat(path.join(exportDir, fileName));
        return metadata.isFile() && !metadata.isSymbolicLink();
      })).then((results) => results.every(Boolean)).catch(() => false);
      if (!filesComplete) return false;
      const sentencesDir = path.join(exportDir, 'sentences');
      const sentencesComplete = await fs.lstat(sentencesDir)
        .then(async (metadata) => metadata.isDirectory()
          && !metadata.isSymbolicLink()
          && isSameSessionDir(await fs.realpath(sentencesDir), sentencesDir))
        .catch(() => false);
      return sentencesComplete;
    }

    // Legacy bundles do not prove which durable snapshot they contain. Keep
    // them on disk, but require a fresh export before marking the current task
    // as deliverable.
    return false;
  } catch {
    return false;
  }
}

export async function loadHistorySnapshot(
  sessionDir: string,
  metadataDir: string,
): Promise<{ snapshot: Record<string, unknown>; modifiedAtMs: number } | null> {
  const candidates: HistorySnapshotCandidate[] = [];
  const generations = snapshotGenerationPaths(metadataDir);
  for (let ordinal = 0; ordinal < generations.length; ordinal += 1) {
    const generation = generations[ordinal];
    const source = await readBoundedRegularFile(generation.filePath, SNAPSHOT_MAX_BYTES);
    if (!source) continue;
    try {
      const snapshot = parseValidSnapshot(JSON.parse(source.bytes.toString('utf8')) as unknown);
      if (!snapshot) continue;
      candidates.push({
        snapshot,
        journalSeq: typeof snapshot.journal_seq === 'number' ? snapshot.journal_seq : 0,
        priority: generation.priority,
        ordinal,
        modifiedAtMs: source.modifiedAtMs,
      });
    } catch {
      // A different persisted generation or journal projection may still be recoverable.
    }
  }

  const validFileCandidateCount = candidates.length;
  const journalSource = await readBoundedRegularFile(
    path.join(metadataDir, 'events.jsonl'),
    JOURNAL_MAX_BYTES,
  );
  if (journalSource) {
    const lines = journalSource.bytes.toString('utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line) as unknown;
        if (!isRecord(event) || typeof event.event !== 'string' || event.event === '') continue;
        if (!isNonNegativeSafeInteger(event.journal_seq) || event.journal_seq === 0) continue;
        const snapshot = parseValidSnapshot(event.snapshot);
        if (!snapshot) continue;
        const journalSeq = typeof snapshot.journal_seq === 'number' ? snapshot.journal_seq : 0;
        if (journalSeq !== event.journal_seq) continue;
        candidates.push({
          snapshot,
          journalSeq,
          priority: 40,
          ordinal: validFileCandidateCount + index,
          modifiedAtMs: journalSource.modifiedAtMs,
        });
      } catch {
        // Ignore a damaged line; each sequenced event contains a complete projection.
      }
    }
  }
  if (candidates.length === 0) return null;

  const newestJournal = candidates
    .filter((candidate) => candidate.priority === 40)
    .sort(compareSnapshotCandidate)
    .at(-1);
  const fallback = [...candidates].sort(compareSnapshotCandidate).at(-1);
  const expectedSessionId = await readSessionIdentity(sessionDir)
    ?? (typeof newestJournal?.snapshot.session_id === 'string'
      ? newestJournal.snapshot.session_id
      : null)
    ?? (typeof fallback?.snapshot.session_id === 'string' ? fallback.snapshot.session_id : null);
  if (!expectedSessionId) return null;
  const selected = candidates
    .filter((candidate) => candidate.snapshot.session_id === expectedSessionId)
    .sort(compareSnapshotCandidate)
    .at(-1);
  if (!selected) return null;
  const faultMarkerModifiedAtMs = await findAudioFaultMarker(metadataDir);
  return {
    snapshot: faultMarkerModifiedAtMs === null
      ? selected.snapshot
      : {
          ...selected.snapshot,
          status: 'faulted',
          audio_fault_marker: true,
        },
    modifiedAtMs: Math.max(selected.modifiedAtMs, faultMarkerModifiedAtMs ?? 0),
  };
}

function countItems(items: unknown[], status: string): number {
  return items.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    return (item as { status?: unknown }).status === status;
  }).length;
}

async function listRecordings(root: string): Promise<unknown[]> {
  const resolvedRoot = path.resolve(root);
  if (!isAllowedOutputRoot(resolvedRoot)) throw new Error('只能读取已授权的录制保存目录');
  let canonicalRoot: string;
  try {
    canonicalRoot = await resolveAuthorizedOutputRoot(resolvedRoot, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let children: import('node:fs').Dirent[];
  try {
    children = await fs.readdir(canonicalRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const candidates: Array<{ sessionDir: string; metadataDir: string; modifiedAtMs: number }> = [];
  for (const entry of children) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const lexicalSessionDir = path.join(canonicalRoot, entry.name);
    try {
      const entryStat = await fs.lstat(lexicalSessionDir);
      if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) continue;
      const sessionDir = await fs.realpath(lexicalSessionDir);
      if (path.dirname(sessionDir) !== canonicalRoot) continue;
      const metadataDir = path.join(sessionDir, 'metadata');
      const metadataStat = await fs.lstat(metadataDir);
      if (metadataStat.isSymbolicLink() || !metadataStat.isDirectory()) continue;
      if (await fs.realpath(metadataDir) !== metadataDir) continue;
      candidates.push({
        sessionDir,
        metadataDir,
        modifiedAtMs: Math.max(entryStat.mtimeMs, metadataStat.mtimeMs),
      });
    } catch {
      // Ignore incomplete or concurrently moved directories.
    }
  }
  candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
  const rows: Record<string, unknown>[] = [];
  for (const candidate of candidates) {
    if (rows.length >= 500) break;
    try {
      const recovered = await loadHistorySnapshot(candidate.sessionDir, candidate.metadataDir);
      if (!recovered) continue;
      const snapshot = recovered.snapshot;
      const items = Array.isArray(snapshot.items) ? snapshot.items : [];
      const audioFormat = snapshot.audio_format && typeof snapshot.audio_format === 'object'
        ? snapshot.audio_format as Record<string, unknown>
        : {};
      const exportDir = path.join(candidate.sessionDir, 'export');
      const exportExists = await hasCompleteExport(exportDir, snapshot);
      rememberKnownSession(candidate.sessionDir, String(snapshot.session_id));
      rows.push({
        session_id: snapshot.session_id,
        session_dir: candidate.sessionDir,
        script_name: typeof snapshot.script_name === 'string' && snapshot.script_name
          ? snapshot.script_name
          : '未记录源文件',
        status: typeof snapshot.status === 'string' ? snapshot.status : 'unknown',
        is_active: isIntentSession(candidate.sessionDir),
        started_at: typeof snapshot.started_at === 'string' ? snapshot.started_at : '',
        updated_at: typeof snapshot.updated_at === 'string' ? snapshot.updated_at : '',
        device_name: typeof snapshot.device_name === 'string' ? snapshot.device_name : '',
        sample_rate: typeof audioFormat.sample_rate === 'number' ? audioFormat.sample_rate : 0,
        bit_depth: typeof audioFormat.bit_depth === 'number' ? audioFormat.bit_depth : 16,
        encoding: typeof audioFormat.encoding === 'string' ? audioFormat.encoding : 'pcm',
        input_channel: typeof audioFormat.input_channel === 'number' ? audioFormat.input_channel : 1,
        captured_samples: typeof snapshot.captured_samples === 'number' ? snapshot.captured_samples : 0,
        overflow_samples: typeof snapshot.overflow_samples === 'number' ? snapshot.overflow_samples : 0,
        total_items: items.length,
        accepted_items: countItems(items, 'accepted'),
        skipped_items: countItems(items, 'skipped'),
        review_items: countItems(items, 'review'),
        pending_items: countItems(items, 'pending'),
        noise_check: snapshot.noise_check ?? null,
        export_exists: exportExists,
      });
    } catch {
      // Ignore invalid snapshots without hiding the other recordings.
    }
  }
  return rows
    .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
    .slice(0, 200);
}

function sendToMain(channel: string, ...args: unknown[]): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  try {
    window.webContents.send(channel, ...args);
  } catch (error) {
    // UI notification failures must never abort engine recovery, crash-seal
    // bookkeeping, or another data-safety transition in the main process.
    console.error(`无法向主面板发送 ${channel}：`, error);
  }
}

async function hasActiveEngineSession(): Promise<boolean> {
  if (engineIntent.phase === 'sealing' || engineIntent.phase === 'exporting') {
    if (engine?.running) return true;
    transitionEngineIntent(engineIntent, 'idle', null);
    return false;
  }
  if (intentTracksLiveSession()) return true;
  if (isQuitting()) return Boolean(engineIntent.sessionDir);
  if (!engine?.running) return false;
  const observedIntent = engineIntent;
  try {
    const state = await engine.request('get_state_optional', {}, 3_000) as EngineOptionalState;
    if (!ownsEngineGeneration(observedIntent) || isQuitting()) return intentTracksLiveSession();
    if (state.active === true && typeof state.session_dir === 'string') {
      beginEngineIntent(observedLivePhase(state), state.session_dir);
      knownSessionDirs.add(state.session_dir);
      return true;
    }
    return false;
  } catch (error) {
    console.error('无法在窗口关闭前确认录音状态：', error);
    return intentTracksLiveSession();
  }
}

function closeWindowWithoutPrompt(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  forceCloseWindows.add(window);
  window.close();
}

function clearBackgroundRecordingStatus(): void {
  app.setBadgeCount(0);
  recordingTray?.destroy();
  recordingTray = null;
}

function recordingTrayMenu(status: string, canOpen: boolean): Electron.Menu {
  return Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    {
      label: '打开录音面板',
      enabled: canOpen,
      click: () => void showMainWindow(),
    },
    {
      label: '安全停止并退出',
      click: () => void requestSafeStopAndQuit('托盘菜单'),
    },
  ]);
}

function ensureRecordingTray(status = '● 后台录音正在进行'): void {
  app.setBadgeCount(1);
  if (!recordingTray) {
    const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    recordingTray = new Tray(icon);
    recordingTray.on('click', () => void showMainWindow());
    recordingTray.on('double-click', () => void showMainWindow());
  }
  recordingTray.setToolTip('DataBaker 音频采集 — 后台录音中');
  recordingTray.setContextMenu(recordingTrayMenu(status, !isQuitting()));
}

async function showMainWindow(): Promise<BrowserWindow> {
  if (isQuitting()) {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
    throw new Error('应用正在安全退出');
  }
  const window = await createWindow();
  if (isQuitting()) return window;
  clearBackgroundRecordingStatus();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

function describeEngineExit(outcome: EngineStoppedOutcome): string {
  return outcome.signal
    ? `退出信号：${outcome.signal}`
    : `退出代码：${outcome.code ?? '未知'}`;
}

function handleUnsafeEngineStop(
  outcome: EngineStoppedOutcome,
  originalError?: unknown,
): Promise<void> {
  if (forceExitConfirmed) return Promise.resolve();
  if (unsafeEngineStopPromise) return unsafeEngineStopPromise;

  const interruptedSessionDir = engineIntent.sessionDir;
  if (interruptedSessionDir) {
    retainCrashSealObligation(
      interruptedSessionDir,
      originalError instanceof Error
        ? originalError.message
        : originalError === undefined ? describeEngineExit(outcome) : String(originalError),
    );
  }
  quitWhenEngineStops = false;
  idleWhenEngineStopsGeneration = null;
  pendingEngineRecovery = null;
  const errorDetail = originalError instanceof Error
    ? `\n\n${originalError.message}`
    : originalError === undefined
      ? ''
      : `\n\n${String(originalError)}`;
  const sessionDetail = interruptedSessionDir
    ? `\n\n受影响任务：${interruptedSessionDir}`
    : '';
  const offlineMessage = `录音引擎已退出，但安全封存未获确认（${describeEngineExit(outcome)}）`;
  const recoveryIntent = beginEngineIntent('idle', null);
  clearBackgroundRecordingStatus();
  sendToMain('engine:offline', offlineMessage);

  const operation = (async () => {
    const options: Electron.MessageBoxOptions = {
      type: 'warning',
      title: '安全封存未确认',
      message: '录音引擎已退出，软件已阻止自动退出',
      detail: `已持久化的母轨分段仍然保留，但最后的封存结果不能确认。请保留应用并在历史任务中检查或修复，不要将该任务当作正常完成。\n\n${describeEngineExit(outcome)}${sessionDetail}${errorDetail}`,
      buttons: ['保留应用并检查任务', '确认退出（封存未确认）'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    let window: BrowserWindow | null = null;
    try {
      window = await showMainWindow();
      if (ownsEngineGeneration(recoveryIntent)) {
        window.setTitle('DataBaker 音频采集 — 安全封存未确认');
        window.setProgressBar(-1);
      }
    } catch (windowError) {
      console.error('无法在引擎异常退出后打开主面板：', windowError);
    }
    const result = window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);
    if (!ownsEngineGeneration(recoveryIntent)) return;
    if (result.response === 1) {
      beginEngineIntent('quitting', null);
      clearBackgroundRecordingStatus();
      releaseApplicationQuit();
      return;
    }

    try {
      await engine?.start();
      if (!ownsEngineGeneration(recoveryIntent)) return;
      sendToMain('engine:event', {
        protocol_version: 1,
        event: 'engine_restarted_after_unconfirmed_stop',
        payload: {
          session_dir: interruptedSessionDir,
          exit_code: outcome.code,
          exit_signal: outcome.signal,
        },
      });
    } catch (restartError) {
      if (!ownsEngineGeneration(recoveryIntent)) return;
      const message = restartError instanceof Error ? restartError.message : String(restartError);
      sendToMain('engine:offline', `录音引擎无法重新启动：${message}`);
      console.error('安全封存未确认后，录音引擎重新启动失败：', restartError);
    }
  })();
  const tracked = operation.finally(() => {
    if (unsafeEngineStopPromise === tracked) unsafeEngineStopPromise = null;
  });
  unsafeEngineStopPromise = tracked;
  return tracked;
}

function requestQuitAfterExport(source: string): Promise<void> {
  if (exportExitPromise) return exportExitPromise;
  const exportIntent = engineIntent;
  const observedExport = activeExportOperation;
  const alreadyConfirmed = source === '主窗口关闭选择';
  const operation = (async () => {
    if (!alreadyConfirmed) {
      const options: Electron.MessageBoxOptions = {
        type: 'info',
        title: '录音交付正在导出',
        message: '导出尚未完成，现在不能直接结束引擎',
        detail: '请等待整轨和分句文件全部落盘后再安全退出。取消退出不会取消当前导出。',
        buttons: ['取消退出', '等待导出完成后退出'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      };
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (result.response !== 1) return;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle('DataBaker 音频采集 — 等待导出完成');
      mainWindow.setProgressBar(2);
    }
    if (recordingTray) {
      recordingTray.setToolTip('DataBaker 音频采集 — 导出完成后退出');
      recordingTray.setContextMenu(recordingTrayMenu('正在导出，完成后安全退出…', false));
    }

    if (!observedExport || observedExport.intent.generation !== exportIntent.generation) {
      if (!isCurrentEngineIntent(exportIntent, ['exporting'])) {
        await performSafeStopAndQuit(`${source}（导出已结束）`);
        return;
      }
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '导出状态无法确认',
        message: '软件已阻止自动退出',
        detail: '录音引擎可能仍在写入交付文件。请保留应用运行并检查导出目录。',
        buttons: ['保留应用'],
        defaultId: 0,
        noLink: true,
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, options);
      } else {
        await dialog.showMessageBox(options);
      }
      return;
    }

    try {
      await observedExport.completion;
    } catch (error) {
      console.error('退出前的导出操作未成功：', error);
    }
    if (isCurrentEngineIntent(exportIntent, ['exporting'])) {
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '导出结果尚未确认',
        message: '软件已阻止自动退出',
        detail: '引擎尚未证明导出已结束，因此不会强制中断写入。',
        buttons: ['保留应用'],
        defaultId: 0,
        noLink: true,
      };
      if (mainWindow && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, options);
      } else {
        await dialog.showMessageBox(options);
      }
      return;
    }
    await performSafeStopAndQuit(`${source}（导出已结束）`);
  })();
  const tracked = operation.finally(() => {
    if (exportExitPromise === tracked) exportExitPromise = null;
  });
  exportExitPromise = tracked;
  return tracked;
}

function requestSafeStopAndQuit(source: string): Promise<void> {
  if (unsafeEngineStopPromise) return unsafeEngineStopPromise;
  if (safeExitPromise) return safeExitPromise;
  if (exportExitPromise) return exportExitPromise;
  if (engineIntent.phase === 'exporting') return requestQuitAfterExport(source);
  return performSafeStopAndQuit(source);
}

async function showCrashSealUnconfirmedGate(
  obligation: PendingCrashSeal,
  error: unknown,
  intent: EngineIntent,
): Promise<void> {
  quitWhenEngineStops = false;
  if (isCurrentEngineIntent(intent, ['sealing', 'quitting'])) {
    transitionEngineIntent(intent, 'idle', null);
  }
  const detail = error instanceof Error ? error.message : String(error);
  const message = '引擎异常退出后的母轨封存未能确认';
  sendToMain('engine:offline', `${message}：${detail}`);
  console.error(`${message}：`, error);
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: '中断任务封存未确认',
    message: '软件已阻止自动退出',
    detail: `受影响任务：${obligation.sessionDir}\n\n已落盘的母轨分段仍然保留，但离线封存未得到身份、路径和持久化结果的完整确认。本次退出已取消，请在历史任务中检查并使用“修复并封存”。\n\n${detail}\n\n原始引擎错误：${obligation.originalError}`,
    buttons: ['保留应用并检查任务'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  let window: BrowserWindow | null = null;
  try {
    window = await showMainWindow();
    if (!window.isDestroyed()) {
      window.setTitle('DataBaker 音频采集 — 中断任务封存未确认');
      window.setProgressBar(-1);
    }
  } catch (windowError) {
    console.error('无法在封存未确认后打开主面板：', windowError);
  }
  if (window && !window.isDestroyed()) {
    await dialog.showMessageBox(window, options);
  } else {
    await dialog.showMessageBox(options);
  }
}

function performSafeStopAndQuit(source: string): Promise<void> {
  // The warning dialog is itself the operator acknowledgement gate. A second
  // quit request (for example after closing the last window) must not bypass
  // it merely because the failed engine process is no longer running.
  if (unsafeEngineStopPromise) return unsafeEngineStopPromise;
  if (safeExitPromise) return safeExitPromise;
  quitWhenEngineStops = false;
  const crashSealObligation = pendingCrashSeal;
  const quitIntent = beginEngineIntent(
    crashSealObligation ? 'sealing' : 'quitting',
    crashSealObligation?.sessionDir ?? engineIntent.sessionDir,
  );
  pendingEngineRecovery = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle('DataBaker 音频采集 — 正在安全停止');
    mainWindow.setProgressBar(2);
  }
  if (recordingTray) {
    recordingTray.setToolTip('DataBaker 音频采集 — 正在安全停止');
    recordingTray.setContextMenu(recordingTrayMenu('正在安全停止并封存母轨…', false));
  }
  console.log(`开始安全退出（${source}）`);
  const operation = (async () => {
    if (crashSealObligation) {
      try {
        if (!crashSealObligation.expectedSessionId) {
          throw new Error('异常退出前未能保留可信的录制任务身份');
        }
        const sealed = await executeAuthorizedOfflineSeal(
          quitIntent,
          crashSealObligation.sessionDir,
          crashSealObligation.expectedSessionId,
        );
        assertCurrentEngineIntent(quitIntent, ['sealing']);
        rememberKnownSession(sealed.canonical, crashSealObligation.expectedSessionId);
        clearCrashSealObligation(sealed.canonical);
        transitionEngineIntent(quitIntent, 'quitting', sealed.canonical);
      } catch (error) {
        await showCrashSealUnconfirmedGate(crashSealObligation, error, quitIntent);
        return;
      }
    }
    try {
      await engine?.stop();
      assertCurrentEngineIntent(quitIntent, ['quitting']);
    } catch (error) {
      if (error instanceof EngineIntentSupersededError || !ownsEngineGeneration(quitIntent)) {
        return;
      }
      if (error instanceof EngineUnsafeStopError) {
        console.error('录音引擎已退出，但安全封存未获确认：', error);
        await handleUnsafeEngineStop(error.outcome, error);
        return;
      }
      console.error('录音引擎未能在安全时限内完成收尾：', error);
      transitionEngineIntent(quitIntent, 'stopping', quitIntent.sessionDir);
      quitWhenEngineStops = true;
      if (!engine?.running) {
        quitWhenEngineStops = false;
        beginEngineIntent('quitting', null);
        clearBackgroundRecordingStatus();
        releaseApplicationQuit();
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setTitle('DataBaker 音频采集 — 仍在安全封存');
        mainWindow.setProgressBar(2);
      }
      ensureRecordingTray('⚠ 音频仍在安全封存…');
      const detail = error instanceof EngineSafeStopTimeoutError
        ? '已封存的母轨分段仍然安全。强制退出可能丢失尚未写入的尾部音频，因此软件不会自动强制结束。'
        : `已封存的母轨分段仍然安全。强制退出可能丢失尾部音频。\n\n${error instanceof Error ? error.message : String(error)}`;
      const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '音频仍在封存',
        message: '安全停止超时，录音引擎已保留运行',
        detail,
        buttons: ['继续等待', '强制退出（可能丢失尾部）'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (!ownsEngineGeneration(quitIntent)) return;
      if (!engine?.running) {
        quitWhenEngineStops = false;
        beginEngineIntent('quitting', null);
        clearBackgroundRecordingStatus();
        releaseApplicationQuit();
        return;
      }
      if (result.response !== 1) return;

      const forceIntent = beginEngineIntent('quitting', quitIntent.sessionDir);
      try {
        forceExitConfirmed = true;
        await engine.forceStop();
        assertCurrentEngineIntent(forceIntent, ['quitting']);
        quitWhenEngineStops = false;
        transitionEngineIntent(forceIntent, 'quitting', null);
        clearBackgroundRecordingStatus();
        releaseApplicationQuit();
        forceExitConfirmed = false;
      } catch (forceError) {
        forceExitConfirmed = false;
        if (!ownsEngineGeneration(forceIntent)) return;
        console.error('用户确认强制退出后，引擎仍未退出：', forceError);
        transitionEngineIntent(forceIntent, 'stopping', forceIntent.sessionDir);
        ensureRecordingTray('⚠ 录音引擎仍在运行…');
      }
      return;
    }
    if (!ownsEngineGeneration(quitIntent)) return;
    quitWhenEngineStops = false;
    transitionEngineIntent(quitIntent, 'quitting', null);
    clearBackgroundRecordingStatus();
    releaseApplicationQuit();
  })();
  const tracked = operation.finally(() => {
    if (safeExitPromise !== tracked) return;
    safeExitPromise = null;
    if (quitWhenEngineStops && engineIntent.phase === 'stopping' && !engine?.running) {
      void requestSafeStopAndQuit('延迟的音频封存已完成');
    }
  });
  safeExitPromise = tracked;
  return tracked;
}

async function requestSessionWithReconciliation(
  command: 'start_session' | 'resume_session',
  payload: Record<string, unknown>,
  sessionDir: string,
  timeoutMs: number,
  intent: EngineIntent,
  allowedPhases: readonly EnginePhase[],
): Promise<unknown> {
  if (!engine) throw new Error('录音引擎客户端不可用');
  let requestError: unknown;
  try {
    const result = await engine.request(command, payload, timeoutMs);
    assertCurrentEngineIntent(intent, allowedPhases);
    if (!isRecord(result)
      || typeof result.session_dir !== 'string'
      || !isSameSessionDir(result.session_dir, sessionDir)
      || !isRecord(result.snapshot)
      || result.snapshot.status !== 'recording') {
      throw new Error('录音引擎未返回可确认的 recording 状态');
    }
    return result;
  } catch (error) {
    assertCurrentEngineIntent(intent, allowedPhases);
    requestError = error;
  }

  let state: EngineOptionalState;
  try {
    state = await engine.request('get_state_optional', {}, 5_000) as EngineOptionalState;
    assertCurrentEngineIntent(intent, allowedPhases);
  } catch (reconciliationError) {
    assertCurrentEngineIntent(intent, allowedPhases);
    throw new EngineStateReconciliationError(requestError, reconciliationError);
  }

  if (state.active === true && typeof state.session_dir === 'string') {
    const observedStatus = observedActiveSnapshotStatus(state);
    if (isSameSessionDir(state.session_dir, sessionDir)) {
      if (observedStatus === 'recording') return state;
      const detail = observedStatus === 'stopping'
        ? '录音引擎仍在安全收尾，未进入可录制状态'
        : `录音引擎返回了不可确认的活动状态：${observedStatus ?? '缺少状态'}`;
      throw new EngineStateReconciliationError(requestError, new Error(detail));
    }
    throw new EngineSessionConflictError(state.session_dir, observedLivePhase(state));
  }
  if (state.active !== false) {
    throw new EngineStateReconciliationError(
      requestError,
      new Error('录音引擎返回了无法确认的可选任务状态'),
    );
  }
  throw requestError;
}

async function notifyEngineRecovered(
  intent: EngineIntent,
  sessionDir: string,
): Promise<void> {
  if (!isCurrentEngineIntent(intent, ['active'])) return;
  try {
    const window = await showMainWindow();
    if (!isCurrentEngineIntent(intent, ['active'])) return;
    await dialog.showMessageBox(window, {
      type: 'warning',
      title: '录音引擎已自动恢复',
      message: '母轨已从最后一个持久化采样点继续录制',
      detail: '异常时正在录制的句子已标记为不可交付的中断版本。请确认实时输入电平，并等待句首静音达标后再开始新的句子。',
      buttons: ['知道了'],
    });
  } catch (uiError) {
    console.error('录音已恢复，但主面板无法显示：', uiError);
    if (isCurrentEngineIntent(intent, ['active'])
      && engineIntent.sessionDir
      && isSameSessionDir(engineIntent.sessionDir, sessionDir)) {
      ensureRecordingTray('⚠ 录音已恢复，主面板不可用');
    }
  }
}

async function notifyEngineRecoveryFailed(intent: EngineIntent, latestError: string): Promise<void> {
  if (!isCurrentEngineIntent(intent, ['idle', 'active', 'stopping'])) return;
  try {
    const window = await showMainWindow();
    if (!isCurrentEngineIntent(intent, ['idle', 'active', 'stopping'])) return;
    await dialog.showMessageBox(window, {
      type: 'error',
      title: '录音引擎无法自动恢复',
      message: '已停止本次自动恢复，已持久化的分段母轨仍然保留',
      detail: `${latestError}\n\n请检查声卡、麦克风和保存磁盘，然后从历史任务继续录制。`,
      buttons: ['知道了'],
    });
  } catch (uiError) {
    console.error('无法显示录音恢复失败提示：', uiError);
  }
}

async function runEngineRecovery(job: EngineRecoveryJob): Promise<void> {
  const { intent, originalError } = job;
  const sessionDir = intent.sessionDir;
  if (!sessionDir) return;
  let latestError = originalError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    if (!isCurrentEngineIntent(intent, ['recovering'])) return;
    try {
      if (!engine) throw new Error('录音引擎客户端不可用');
      await engine.start();
      assertCurrentEngineIntent(intent, ['recovering']);
      const state = await requestSessionWithReconciliation(
        'resume_session',
        { session_dir: sessionDir },
        sessionDir,
        30_000,
        intent,
        ['recovering'],
      );
      assertCurrentEngineIntent(intent, ['recovering']);
      transitionEngineIntent(intent, 'active', sessionDir);
      clearCrashSealObligation(sessionDir);
      sendToMain('engine:event', {
        protocol_version: 1,
        event: 'engine_recovered',
        payload: {
          attempt,
          session_dir: sessionDir,
          state,
          original_error: originalError,
        },
      });
      void notifyEngineRecovered(intent, sessionDir);
      return;
    } catch (error) {
      if (error instanceof EngineIntentSupersededError
        || !isCurrentEngineIntent(intent, ['recovering'])) return;
      latestError = error instanceof Error ? error.message : String(error);
      console.error(`录音引擎第 ${attempt} 次自动恢复失败：`, error);
      if (error instanceof EngineSessionConflictError) {
        transitionEngineIntent(intent, error.phase, error.sessionDir);
        knownSessionDirs.add(error.sessionDir);
        sendToMain('engine:offline', latestError);
        if (error.phase === 'stopping') {
          sendToMain('engine:event', {
            protocol_version: 1,
            event: 'engine_recovery_failed',
            payload: { session_dir: error.sessionDir, error: latestError },
          });
        }
        void notifyEngineRecoveryFailed(intent, latestError);
        return;
      }
      try {
        await engine?.stop();
        assertCurrentEngineIntent(intent, ['recovering']);
      } catch (stopError) {
        if (!isCurrentEngineIntent(intent, ['recovering'])) return;
        console.error('自动恢复重试前无法完全停止旧引擎：', stopError);
        if (engine?.running) {
          latestError = stopError instanceof Error ? stopError.message : String(stopError);
          retainStoppingIntentAfterEngineStopFailure(
            intent,
            '自动恢复重试前旧引擎仍在安全停止',
            stopError,
          );
          sendToMain('engine:event', {
            protocol_version: 1,
            event: 'engine_recovery_failed',
            payload: { session_dir: sessionDir, error: latestError },
          });
          void notifyEngineRecoveryFailed(intent, latestError);
          return;
        }
      }
    }
  }
  if (!isCurrentEngineIntent(intent, ['recovering'])) return;
  transitionEngineIntent(intent, 'idle', null);
  clearBackgroundRecordingStatus();
  sendToMain('engine:offline', latestError);
  sendToMain('engine:event', {
    protocol_version: 1,
    event: 'engine_recovery_failed',
    payload: { session_dir: sessionDir, error: latestError },
  });
  void notifyEngineRecoveryFailed(intent, latestError);
}

async function drainEngineRecoveryQueue(): Promise<void> {
  while (pendingEngineRecovery && !isQuitting()) {
    const job = pendingEngineRecovery;
    pendingEngineRecovery = null;
    await runEngineRecovery(job);
  }
}

function ensureEngineRecoveryDrain(): Promise<void> {
  if (engineRecoveryPromise) return engineRecoveryPromise;
  const operation = drainEngineRecoveryQueue().finally(() => {
    if (engineRecoveryPromise === operation) engineRecoveryPromise = null;
    if (pendingEngineRecovery && !isQuitting()) void ensureEngineRecoveryDrain();
  });
  engineRecoveryPromise = operation;
  return operation;
}

function recoverEngineAfterCrash(sessionDir: string, originalError: string): Promise<void> {
  if (engineIntent.phase === 'stopping' || isQuitting()) return Promise.resolve();
  const intent = beginEngineIntent('recovering', sessionDir);
  pendingEngineRecovery = { intent, originalError };
  if (recordingTray) ensureRecordingTray('⚠ 录音引擎异常，正在自动恢复…');
  return ensureEngineRecoveryDrain();
}

async function handleMainWindowClose(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed()) return;
  const active = await hasActiveEngineSession();
  if (!active) {
    closeWindowWithoutPrompt(window);
    return;
  }
  const sealingOfflineTask = engineIntent.phase === 'sealing';
  const exportingTask = engineIntent.phase === 'exporting';
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: exportingTask
      ? '录音交付正在导出'
      : sealingOfflineTask ? '任务正在离线封存' : '录音正在进行',
    message: exportingTask
      ? '整轨和分句文件仍在写入，关闭面板不应该中断交付。'
      : sealingOfflineTask
        ? '中断任务仍在修复并封存，关闭面板不应该隐藏其进度。'
        : '持续母轨仍在录制，关闭面板不应该无声地继续。',
    detail: exportingTask
      ? '取消可继续查看；后台运行会保留引擎；导出完成后退出会等待交付状态持久化，再安全结束引擎。'
      : sealingOfflineTask
        ? '取消可继续查看；后台运行会保留引擎并在系统托盘显示；安全停止并退出会等待当前封存完成。'
        : '取消可继续使用录音面板；后台录音会保留引擎并在系统托盘持续显示；安全停止会先封存 WAV 再退出。',
    buttons: [
      '取消',
      exportingTask ? '继续后台导出' : sealingOfflineTask ? '继续后台封存' : '继续后台录音',
      exportingTask ? '导出完成后退出' : '安全停止并退出',
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    normalizeAccessKeys: true,
  });
  if (window.isDestroyed() || result.response === 0) return;
  if (result.response === 1) {
    if (!(await hasActiveEngineSession())) {
      closeWindowWithoutPrompt(window);
      return;
    }
    window.hide();
    prompterWindow?.close();
    ensureRecordingTray(exportingTask
      ? '录音交付正在后台导出…'
      : sealingOfflineTask ? '中断任务正在后台修复并封存…' : undefined);
    return;
  }
  await requestSafeStopAndQuit('主窗口关闭选择');
}

function promptForMainWindowClose(window: BrowserWindow): void {
  if (closeDecisionPromise) return;
  const operation = handleMainWindowClose(window).finally(() => {
    if (closeDecisionPromise === operation) closeDecisionPromise = null;
  });
  closeDecisionPromise = operation;
}

async function recoverMainWindow(failedWindow: BrowserWindow, reason: string): Promise<void> {
  if (isQuitting() || forceCloseWindows.has(failedWindow) || mainWindow !== failedWindow) return;
  if (windowRecoveryPromise) return windowRecoveryPromise;
  const operation = (async () => {
    const recordingContinues = await hasActiveEngineSession();
    console.error(`录音面板异常，正在重建：${reason}`);
    forceCloseWindows.add(failedWindow);
    mainWindow = null;
    if (!failedWindow.isDestroyed()) failedWindow.destroy();
    prompterWindow?.close();
    try {
      const replacement = await createWindow();
      clearBackgroundRecordingStatus();
      replacement.show();
      replacement.focus();
      if (recordingContinues && await hasActiveEngineSession()) {
        await dialog.showMessageBox(replacement, {
          type: 'info',
          title: '录音面板已恢复',
          message: '后台录音仍在继续',
          detail: '录音引擎未被重启或暂停，新面板已重新连接当前任务。',
          buttons: ['知道了'],
          defaultId: 0,
          cancelId: 0,
        });
      }
    } catch (error) {
      console.error('录音面板自动恢复失败：', error);
      if (recordingContinues) ensureRecordingTray('⚠ 面板恢复失败，后台录音仍在继续');
    }
  })().finally(() => {
    if (windowRecoveryPromise === operation) windowRecoveryPromise = null;
  });
  windowRecoveryPromise = operation;
  return operation;
}

async function createWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  if (isQuitting()) throw new Error('应用正在安全退出');
  if (windowCreationPromise) return windowCreationPromise;
  const operation = (async () => {
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1080,
      minHeight: 700,
      backgroundColor: '#0a0d14',
      title: 'DataBaker 音频采集',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    mainWindow = window;
    window.removeMenu();
    let unresponsiveTimer: NodeJS.Timeout | null = null;
    window.on('close', (event) => {
      if (appQuitReleased || forceCloseWindows.has(window)) return;
      event.preventDefault();
      if (isQuitting() || safeExitPromise || exportExitPromise || unsafeEngineStopPromise) {
        void requestSafeStopAndQuit('主窗口重复关闭');
        return;
      }
      promptForMainWindowClose(window);
    });
    if (process.platform === 'win32') {
      window.on('query-session-end', (event) => {
        if (appQuitReleased) return;
        event.preventDefault();
        void requestSafeStopAndQuit('Windows 系统会话结束');
      });
      window.on('session-end', () => {
        if (!appQuitReleased) void requestSafeStopAndQuit('Windows 系统会话强制结束');
      });
    }
    window.on('closed', () => {
      if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
      if (mainWindow === window) mainWindow = null;
      prompterWindow?.close();
    });
    window.on('unresponsive', () => {
      if (isQuitting() || forceCloseWindows.has(window) || unresponsiveTimer) return;
      unresponsiveTimer = setTimeout(() => {
        unresponsiveTimer = null;
        void recoverMainWindow(window, 'Renderer 持续无响应');
      }, 1_500);
    });
    window.on('responsive', () => {
      if (!unresponsiveTimer) return;
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
      unresponsiveTimer = null;
      void recoverMainWindow(window, `Renderer 进程结束（${details.reason}）`);
    });
    try {
      const developmentUrl = process.env.VITE_DEV_SERVER_URL;
      if (developmentUrl) {
        await window.loadURL(developmentUrl);
      } else {
        await window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
      }
      return window;
    } catch (error) {
      forceCloseWindows.add(window);
      if (!window.isDestroyed()) window.destroy();
      if (mainWindow === window) mainWindow = null;
      throw error;
    }
  })().finally(() => {
    if (windowCreationPromise === operation) windowCreationPromise = null;
  });
  windowCreationPromise = operation;
  return operation;
}

async function createPrompterWindow(): Promise<BrowserWindow> {
  if (prompterWindow && !prompterWindow.isDestroyed()) {
    prompterWindow.show();
    prompterWindow.focus();
    return prompterWindow;
  }
  const primaryDisplay = screen.getPrimaryDisplay();
  const targetDisplay = screen.getAllDisplays().find((display) => display.id !== primaryDisplay.id)
    ?? primaryDisplay;
  prompterWindow = new BrowserWindow({
    ...targetDisplay.workArea,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#111315',
    title: '领读面板',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  prompterWindow.removeMenu();
  prompterWindow.on('closed', () => {
    prompterWindow = null;
  });
  prompterWindow.webContents.on('did-finish-load', () => {
    if (latestPrompterState !== null) {
      prompterWindow?.webContents.send('prompter:state', latestPrompterState);
    }
  });
  const developmentUrl = process.env.VITE_DEV_SERVER_URL;
  if (developmentUrl) {
    const url = new URL(developmentUrl);
    url.searchParams.set('view', 'prompter');
    await prompterWindow.loadURL(url.toString());
  } else {
    await prompterWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'), {
      query: { view: 'prompter' },
    });
  }
  return prompterWindow;
}

function assertMainRenderer(sender: Electron.WebContents): void {
  if (!mainWindow || mainWindow.isDestroyed() || sender !== mainWindow.webContents) {
    throw new Error('只能从主录制面板操作领读窗口');
  }
}

function adoptObservedActiveSession(intent: EngineIntent, state: EngineOptionalState): never {
  if (state.active !== true || typeof state.session_dir !== 'string') {
    throw new Error('录音引擎返回了无效的活动任务状态');
  }
  const activeSessionDir = path.resolve(state.session_dir);
  const activePhase = observedLivePhase(state);
  transitionEngineIntent(intent, activePhase, activeSessionDir);
  knownSessionDirs.add(activeSessionDir);
  throw new EngineSessionConflictError(activeSessionDir, activePhase);
}

async function assertEngineIdleForOfflineSeal(intent: EngineIntent): Promise<void> {
  if (!engine) throw new Error('录音引擎不可用');
  const state = await engine.request('get_state_optional', {}, 5_000) as EngineOptionalState;
  assertCurrentEngineIntent(intent, ['sealing']);
  if (state.active === true) adoptObservedActiveSession(intent, state);
}

async function confirmOfflineSealResult(
  result: unknown,
  binding: AuthorizedSessionBinding,
): Promise<Record<string, unknown>> {
  if (!isRecord(result)
    || typeof result.session_dir !== 'string'
    || !isSameSessionDir(result.session_dir, binding.canonicalPath)
    || !isNonNegativeSafeInteger(result.durable_frames)
    || typeof result.no_op !== 'boolean') {
    throw new Error('录音引擎未返回可确认的离线封存结果');
  }
  const responseSnapshot = parseValidSnapshot(result.snapshot);
  if (!responseSnapshot
    || responseSnapshot.session_id !== binding.sessionId
    || (responseSnapshot.status !== 'stopped' && responseSnapshot.status !== 'faulted')
    || responseSnapshot.captured_samples !== result.durable_frames
    || responseSnapshot.committed_samples !== result.durable_frames) {
    throw new Error('离线封存结果与录制任务身份或母轨水位不一致');
  }

  // The protocol acknowledgement is necessary but not sufficient for the
  // quit gate. Re-read the authoritative on-disk projection/journal and prove
  // that the exact bound session reached the acknowledged durable generation.
  const persisted = await loadHistorySnapshot(
    binding.canonicalPath,
    path.join(binding.canonicalPath, 'metadata'),
  );
  if (!persisted
    || persisted.snapshot.session_id !== binding.sessionId
    || persisted.snapshot.status !== responseSnapshot.status
    || persisted.snapshot.journal_seq !== responseSnapshot.journal_seq
    || persisted.snapshot.captured_samples !== result.durable_frames
    || persisted.snapshot.committed_samples !== result.durable_frames) {
    throw new Error('离线封存已返回，但磁盘上未能确认同一代持久化结果');
  }
  return result;
}

async function executeAuthorizedOfflineSeal(
  intent: EngineIntent,
  sessionDir: string,
  expectedSessionId: string,
): Promise<{ canonical: string; result: Record<string, unknown> }> {
  if (!engine) throw new Error('录音引擎不可用');
  const canonical = await resolveKnownSession(sessionDir);
  assertCurrentEngineIntent(intent, ['sealing']);
  if (!canonical) throw new Error('只能修复已授权保存位置中的录制任务');
  transitionEngineIntent(intent, 'sealing', canonical);
  const authorizedRoots = Array.from(canonicalOutputRoots.values());
  const binding = await bindAuthorizedSession(canonical, authorizedRoots, expectedSessionId);
  assertCurrentEngineIntent(intent, ['sealing']);

  // Starting the protocol sidecar does not open an input device. Only
  // start_session/resume_session do that; this path remains an offline repair.
  await engine.start();
  assertCurrentEngineIntent(intent, ['sealing']);
  await assertEngineIdleForOfflineSeal(intent);
  await assertAuthorizedSessionUnchanged(binding, authorizedRoots);
  assertCurrentEngineIntent(intent, ['sealing']);
  const rawResult = await engine.request(
    'seal_interrupted_session',
    { session_dir: canonical },
    120_000,
  );
  assertCurrentEngineIntent(intent, ['sealing']);
  await assertAuthorizedSessionUnchanged(binding, authorizedRoots);
  assertCurrentEngineIntent(intent, ['sealing']);
  const result = await confirmOfflineSealResult(rawResult, binding);
  assertCurrentEngineIntent(intent, ['sealing']);
  return { canonical, result };
}

async function assertEngineIdleForExport(intent: EngineIntent): Promise<void> {
  if (!engine) throw new Error('录音引擎不可用');
  const state = await engine.request('get_state_optional', {}, 5_000) as EngineOptionalState;
  assertCurrentEngineIntent(intent, ['exporting']);
  if (state.active === true) adoptObservedActiveSession(intent, state);
}

async function reconciledCompleteExportResult(
  sessionDir: string,
): Promise<Record<string, unknown> | null> {
  const recovered = await loadHistorySnapshot(sessionDir, path.join(sessionDir, 'metadata'));
  if (!recovered) return null;
  const exportDir = path.join(sessionDir, 'export');
  if (!(await hasCompleteExport(exportDir, recovered.snapshot))) return null;
  const statusSource = await readBoundedRegularFile(
    path.join(exportDir, 'status.json'),
    EXPORT_STATUS_MAX_BYTES,
  );
  if (!statusSource) return null;
  const status = JSON.parse(statusSource.bytes.toString('utf8')) as unknown;
  if (!isRecord(status)
    || status.schema_version !== 2
    || status.status !== 'complete'
    || status.session_id !== recovered.snapshot.session_id
    || !exportSourceMatchesSnapshot(status.source, recovered.snapshot)
    || !isNonNegativeSafeInteger(status.exported_count)
    || !isNonNegativeSafeInteger(status.skipped_count)) return null;
  return {
    export_dir: exportDir,
    master_file: path.join(exportDir, 'full-track.wav'),
    sentences_dir: path.join(exportDir, 'sentences'),
    exported_count: status.exported_count,
    skipped_count: status.skipped_count,
    recovery_warnings: ['导出超过界面等待时限，已根据引擎空闲状态和当前快照确认交付完整。'],
    reconciled_after_timeout: true,
    export_confirmed_complete: true,
  };
}

async function failExportingSession(
  intent: EngineIntent,
  originalError: unknown,
  canonicalSessionDir: string | null,
): Promise<unknown> {
  if (originalError instanceof EngineIntentSupersededError || !ownsEngineGeneration(intent)) {
    throw originalError;
  }
  if (originalError instanceof EngineSessionConflictError) throw originalError;

  if (originalError instanceof EngineRequestTimeoutError && engine?.running) {
    try {
      // The Rust protocol loop is synchronous. If a very long export ever
      // reaches the request deadline, this probe queues behind it and keeps
      // the exclusive intent until the engine can prove the command ended.
      const state = await engine.request(
        'get_state_optional',
        {},
        EXPORT_REQUEST_TIMEOUT_MS,
      ) as EngineOptionalState;
      assertCurrentEngineIntent(intent, ['exporting']);
      if (state.active === true) adoptObservedActiveSession(intent, state);
      const reconciled = canonicalSessionDir
        ? await reconciledCompleteExportResult(canonicalSessionDir)
        : null;
      assertCurrentEngineIntent(intent, ['exporting']);
      transitionEngineIntent(intent, 'idle', null);
      if (reconciled) return reconciled;
    } catch (reconciliationError) {
      if (reconciliationError instanceof EngineIntentSupersededError
        || !ownsEngineGeneration(intent)) throw originalError;
      if (reconciliationError instanceof EngineSessionConflictError) throw reconciliationError;
      // Keep the exporting phase fail-closed: start/resume/seal/duplicate
      // export and app exit remain blocked until the engine outcome is known.
      throw new EngineStateReconciliationError(originalError, reconciliationError);
    }
    throw originalError;
  }

  transitionEngineIntent(intent, 'idle', null);
  throw originalError;
}

async function exportSession(payload: unknown): Promise<unknown> {
  if (!engine) throw new Error('录音引擎不可用');
  const exportEngine = engine;
  const sessionDir = (payload as { session_dir?: unknown })?.session_dir;
  if (typeof sessionDir !== 'string') throw new Error('录制目录无效');
  assertCanStartOrResume();
  const exportIntent = beginEngineIntent('exporting', path.resolve(sessionDir));
  let canonicalSessionDir: string | null = null;
  const completion = (async () => {
    try {
      const canonical = await resolveKnownSession(sessionDir);
      assertCurrentEngineIntent(exportIntent, ['exporting']);
      if (!canonical) throw new Error('只能导出当前或历史录制目录');
      canonicalSessionDir = canonical;
      transitionEngineIntent(exportIntent, 'exporting', canonical);
      await exportEngine.start();
      assertCurrentEngineIntent(exportIntent, ['exporting']);
      await assertEngineIdleForExport(exportIntent);
      const result = await exportEngine.request(
        'export_session',
        { ...(payload as Record<string, unknown>), session_dir: canonical },
        EXPORT_REQUEST_TIMEOUT_MS,
      );
      assertCurrentEngineIntent(exportIntent, ['exporting']);
      transitionEngineIntent(exportIntent, 'idle', null);
      knownSessionDirs.add(canonical);
      return result;
    } catch (error) {
      return await failExportingSession(exportIntent, error, canonicalSessionDir);
    }
  })();
  activeExportOperation = { intent: exportIntent, completion };
  try {
    return await completion;
  } finally {
    if (activeExportOperation?.intent.generation === exportIntent.generation) {
      activeExportOperation = null;
    }
  }
}

async function failSealingSession(intent: EngineIntent, originalError: unknown): Promise<never> {
  if (originalError instanceof EngineIntentSupersededError || !ownsEngineGeneration(intent)) {
    throw originalError;
  }
  if (originalError instanceof EngineSessionConflictError) throw originalError;
  if (!engine?.running) {
    transitionEngineIntent(intent, 'idle', null);
    throw originalError;
  }

  let state: EngineOptionalState;
  try {
    state = await engine.request('get_state_optional', {}, 5_000) as EngineOptionalState;
    assertCurrentEngineIntent(intent, ['sealing']);
  } catch (reconciliationError) {
    if (reconciliationError instanceof EngineIntentSupersededError
      || !ownsEngineGeneration(intent)) throw originalError;
    transitionEngineIntent(intent, 'stopping', intent.sessionDir);
    try {
      await engine.stop();
      assertCurrentEngineIntent(intent, ['stopping']);
      await engine.start();
      assertCurrentEngineIntent(intent, ['stopping']);
      transitionEngineIntent(intent, 'idle', null);
    } catch (stopError) {
      if (ownsEngineGeneration(intent)) {
        if (engine.running) {
          idleWhenEngineStopsGeneration = intent.generation;
        } else {
          transitionEngineIntent(intent, 'idle', null);
        }
      }
      throw new EngineStateReconciliationError(originalError, stopError);
    }
    throw originalError;
  }

  if (state.active === true) adoptObservedActiveSession(intent, state);
  transitionEngineIntent(intent, 'idle', null);
  throw originalError;
}

function retainStoppingIntentAfterEngineStopFailure(
  intent: EngineIntent,
  context: string,
  error: unknown,
): void {
  if (!ownsEngineGeneration(intent)) return;
  console.error(`${context}：`, error);
  if (!engine?.running) {
    transitionEngineIntent(intent, 'idle', null);
    return;
  }
  transitionEngineIntent(intent, 'stopping', intent.sessionDir);
  idleWhenEngineStopsGeneration = intent.generation;
  ensureRecordingTray('⚠ 录音任务仍在安全停止…');
  sendToMain(
    'engine:offline',
    '录音任务仍在安全收尾，已阻止新建或恢复其他任务。请稍后继续安全停止。',
  );
}

async function failStartingSession(intent: EngineIntent, error: unknown): Promise<never> {
  if (error instanceof EngineIntentSupersededError || !ownsEngineGeneration(intent)) throw error;
  if (error instanceof EngineSessionConflictError) {
    transitionEngineIntent(intent, error.phase, error.sessionDir);
    knownSessionDirs.add(error.sessionDir);
    throw error;
  }
  if (error instanceof EngineStateReconciliationError) {
    transitionEngineIntent(intent, 'stopping');
    try {
      await engine?.stop();
      assertCurrentEngineIntent(intent, ['stopping']);
    } catch (stopError) {
      retainStoppingIntentAfterEngineStopFailure(
        intent,
        '录音状态不确定后无法完全停止引擎',
        stopError,
      );
      throw error;
    }
    if (ownsEngineGeneration(intent)) transitionEngineIntent(intent, 'idle', null);
    throw error;
  }
  if (ownsEngineGeneration(intent)) transitionEngineIntent(intent, 'idle', null);
  throw error;
}

async function finishPendingEngineStop(): Promise<unknown> {
  if (!engine) throw new Error('录音引擎不可用');
  const stopIntent = engineIntent;
  if (stopIntent.phase !== 'stopping') throw new Error('当前没有待继续的安全停止');
  const stoppedSessionDir = stopIntent.sessionDir;
  idleWhenEngineStopsGeneration = null;
  try {
    await engine.stop();
    assertCurrentEngineIntent(stopIntent, ['stopping']);
    await engine.start();
    assertCurrentEngineIntent(stopIntent, ['stopping']);
  } catch (error) {
    retainStoppingIntentAfterEngineStopFailure(
      stopIntent,
      '继续安全停止时引擎仍未完成收尾',
      error,
    );
    throw error;
  }
  if (!stoppedSessionDir) {
    transitionEngineIntent(stopIntent, 'idle', null);
    throw new Error('安全停止已完成，但无法确认对应的录制目录');
  }
  let recovered: Awaited<ReturnType<typeof loadHistorySnapshot>>;
  try {
    recovered = await loadHistorySnapshot(
      stoppedSessionDir,
      path.join(stoppedSessionDir, 'metadata'),
    );
    assertCurrentEngineIntent(stopIntent, ['stopping']);
  } catch (error) {
    if (ownsEngineGeneration(stopIntent)) {
      retainCrashSealObligation(
        stoppedSessionDir,
        '安全停止后无法读取已封存任务的持久化状态',
      );
      transitionEngineIntent(stopIntent, 'idle', null);
    }
    throw error;
  }
  if (!recovered
    || (recovered.snapshot.status !== 'stopped'
      && recovered.snapshot.status !== 'faulted')) {
    const message = '安全停止已完成，但持久化任务尚未证明已封存；请刷新后使用“修复并封存”';
    retainCrashSealObligation(stoppedSessionDir, message);
    transitionEngineIntent(stopIntent, 'idle', null);
    throw new Error(message);
  }
  clearCrashSealObligation(stoppedSessionDir);
  transitionEngineIntent(stopIntent, 'idle', null);
  return {
    session_dir: stoppedSessionDir,
    snapshot: recovered.snapshot,
    reconciled_after_pending_stop: true,
  };
}

async function rejectStartedSession(intent: EngineIntent, error: unknown): Promise<never> {
  if (!ownsEngineGeneration(intent)) throw error;
  transitionEngineIntent(intent, 'stopping');
  try {
    await engine?.stop();
    assertCurrentEngineIntent(intent, ['stopping']);
  } catch (stopError) {
    retainStoppingIntentAfterEngineStopFailure(
      intent,
      '无法在拒绝异常录音目录后完全停止引擎',
      stopError,
    );
    throw error;
  }
  if (ownsEngineGeneration(intent)) transitionEngineIntent(intent, 'idle', null);
  throw error;
}

async function stopActiveSession(): Promise<unknown> {
  if (!engine) throw new Error('录音引擎不可用');
  if (isQuitting()) throw new Error(operationBusyMessage());
  const stopIntent = beginEngineIntent('stopping', engineIntent.sessionDir);
  pendingEngineRecovery = null;
  let requestError: unknown;
  try {
    const result = await engine.request('stop_session', {}, 120_000);
    assertCurrentEngineIntent(stopIntent, ['stopping']);
    transitionEngineIntent(stopIntent, 'idle', null);
    return result;
  } catch (error) {
    if (error instanceof EngineIntentSupersededError || !ownsEngineGeneration(stopIntent)) throw error;
    requestError = error;
  }

  try {
    const state = await engine.request('get_state_optional', {}, 5_000) as EngineOptionalState;
    assertCurrentEngineIntent(stopIntent, ['stopping']);
    if (state.active === true && typeof state.session_dir === 'string') {
      transitionEngineIntent(stopIntent, observedLivePhase(state), state.session_dir);
      knownSessionDirs.add(state.session_dir);
    } else {
      const stoppedSessionDir = stopIntent.sessionDir;
      if (stoppedSessionDir) {
        const recovered = await loadHistorySnapshot(
          stoppedSessionDir,
          path.join(stoppedSessionDir, 'metadata'),
        );
        assertCurrentEngineIntent(stopIntent, ['stopping']);
        if (recovered
          && (recovered.snapshot.status === 'stopped'
            || recovered.snapshot.status === 'faulted')) {
          transitionEngineIntent(stopIntent, 'idle', null);
          clearCrashSealObligation(stoppedSessionDir);
          return {
            session_dir: stoppedSessionDir,
            snapshot: recovered.snapshot,
            reconciled_after_error: true,
          };
        }
        retainCrashSealObligation(
          stoppedSessionDir,
          '安全停止后未能确认任务已封存',
        );
      }
      transitionEngineIntent(stopIntent, 'idle', null);
    }
  } catch (reconciliationError) {
    if (!ownsEngineGeneration(stopIntent)) throw requestError;
    console.error('安全停止后无法确认引擎状态，将关闭引擎以防止意外续录：', reconciliationError);
    try {
      await engine.stop();
      assertCurrentEngineIntent(stopIntent, ['stopping']);
    } catch (stopError) {
      retainStoppingIntentAfterEngineStopFailure(
        stopIntent,
        '录音引擎安全关闭失败',
        stopError,
      );
      throw requestError;
    }
    if (ownsEngineGeneration(stopIntent)) transitionEngineIntent(stopIntent, 'idle', null);
  }
  throw requestError;
}

function registerIpc(): void {
  allowedOutputRoots.add(path.resolve(defaultOutputRoot()));
  ipcMain.handle('engine:request', async (event, command: string, payload: unknown) => {
    assertMainRenderer(event.sender);
    if (!allowedCommands.has(command)) throw new Error(`不允许的录音引擎命令：${command}`);
    if (!engine) throw new Error('录音引擎不可用');
    if (command === 'start_session') {
      const sessionDir = (payload as { session_dir?: unknown })?.session_dir;
      if (typeof sessionDir !== 'string') throw new Error('录制目录无效');
      const resolved = path.resolve(sessionDir);
      if (!isAllowedNewSession(resolved)) throw new Error('新录制必须保存在已授权目录的直接子目录中');
      assertCanStartOrResume();
      const startIntent = beginEngineIntent('starting', resolved);
      try {
        const canonicalRoot = await resolveAuthorizedOutputRoot(path.dirname(resolved), true);
        assertCurrentEngineIntent(startIntent, ['starting']);
        const canonicalTarget = path.join(canonicalRoot, path.basename(resolved));
        transitionEngineIntent(startIntent, 'starting', canonicalTarget);
        const existing = await fs.lstat(canonicalTarget).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        assertCurrentEngineIntent(startIntent, ['starting']);
        if (existing) throw new Error('同名录制目录已存在，请更换录制名称后重试');
        await engine.start();
        assertCurrentEngineIntent(startIntent, ['starting']);
        const safePayload = { ...(payload as Record<string, unknown>), session_dir: canonicalTarget };
        const result = await requestSessionWithReconciliation(
          'start_session',
          safePayload,
          canonicalTarget,
          20_000,
          startIntent,
          ['starting'],
        );
        assertCurrentEngineIntent(startIntent, ['starting']);
        let canonical: string;
        try {
          canonical = await fs.realpath(canonicalTarget);
          assertCurrentEngineIntent(startIntent, ['starting']);
        } catch (error) {
          return await rejectStartedSession(startIntent, error);
        }
        if (path.dirname(canonical) !== canonicalRoot) {
          return await rejectStartedSession(
            startIntent,
            new Error('新录制目录越过了已授权的保存位置'),
          );
        }
        const requestedSessionId = (payload as { session_id?: unknown }).session_id;
        const persistedSessionId = await readSessionIdentity(canonical);
        assertCurrentEngineIntent(startIntent, ['starting']);
        if (typeof requestedSessionId !== 'string'
          || requestedSessionId.trim() === ''
          || persistedSessionId !== requestedSessionId) {
          return await rejectStartedSession(
            startIntent,
            new Error('新建录制任务的持久化身份无法确认'),
          );
        }
        transitionEngineIntent(startIntent, 'active', canonical);
        rememberKnownSession(canonical, requestedSessionId);
        return result;
      } catch (error) {
        return await failStartingSession(startIntent, error);
      }
    }
    if (command === 'resume_session') {
      const sessionDir = (payload as { session_dir?: unknown })?.session_dir;
      if (typeof sessionDir !== 'string') throw new Error('录制目录无效');
      // Resuming the exact interrupted task is itself a production recovery
      // path. Keep the quit obligation until resume_session is confirmed, then
      // clear it below; unrelated sessions remain blocked.
      assertCanStartOrResume(crashSealMatches(sessionDir));
      const resumeIntent = beginEngineIntent('starting', path.resolve(sessionDir));
      try {
        const canonical = await resolveKnownSession(sessionDir);
        assertCurrentEngineIntent(resumeIntent, ['starting']);
        if (!canonical) throw new Error('只能继续已授权保存位置中的录制任务');
        transitionEngineIntent(resumeIntent, 'starting', canonical);
        const canonicalRoot = await fs.realpath(path.dirname(canonical));
        assertCurrentEngineIntent(resumeIntent, ['starting']);
        if (!Array.from(canonicalOutputRoots.values()).includes(canonicalRoot)
          || path.dirname(canonical) !== canonicalRoot) {
          throw new Error('录制任务已离开授权的保存位置，请重新选择保存目录');
        }
        await engine.start();
        assertCurrentEngineIntent(resumeIntent, ['starting']);
        const result = await requestSessionWithReconciliation(
          'resume_session',
          { session_dir: canonical },
          canonical,
          30_000,
          resumeIntent,
          ['starting'],
        );
        assertCurrentEngineIntent(resumeIntent, ['starting']);
        transitionEngineIntent(resumeIntent, 'active', canonical);
        clearCrashSealObligation(canonical);
        return result;
      } catch (error) {
        return await failStartingSession(resumeIntent, error);
      }
    }
    if (command === 'seal_interrupted_session') {
      const { session_dir: sessionDir, session_id: expectedSessionId } = (payload as {
        session_dir?: unknown;
        session_id?: unknown;
      }) ?? {};
      if (typeof sessionDir !== 'string') throw new Error('录制目录无效');
      if (typeof expectedSessionId !== 'string' || expectedSessionId.trim() === '') {
        throw new Error('录制任务身份无效，请刷新任务后重试');
      }
      assertCanStartOrResume(crashSealMatches(sessionDir));
      const sealIntent = beginEngineIntent('sealing', path.resolve(sessionDir));
      let canonical: string | null = null;
      try {
        const sealed = await executeAuthorizedOfflineSeal(
          sealIntent,
          sessionDir,
          expectedSessionId,
        );
        canonical = sealed.canonical;
        transitionEngineIntent(sealIntent, 'idle', null);
        rememberKnownSession(canonical, expectedSessionId);
        clearCrashSealObligation(canonical);
        return sealed.result;
      } catch (error) {
        if (error instanceof AuthorizedSessionBindingError) {
          const invalidated = canonical ?? await resolveKnownSession(sessionDir);
          if (invalidated) forgetKnownSession(invalidated);
        }
        return await failSealingSession(sealIntent, error);
      }
    }
    if (command === 'stop_session') {
      if (engineIntent.phase === 'stopping') return await finishPendingEngineStop();
      assertCanMutateActiveSession(command);
      return await stopActiveSession();
    }
    if (command === 'export_session') {
      return await exportSession(payload);
    }
    assertCanMutateActiveSession(command);
    const timeout = 20_000;
    const commandIntent = engineIntent;
    try {
      const result = await engine.request(command, payload, timeout);
      if (command === 'get_state_optional'
        && ownsEngineGeneration(commandIntent)
        && !isQuitting()) {
        const state = result as EngineOptionalState;
        if (engineIntent.phase === 'idle'
          && state.active === true
          && typeof state.session_dir === 'string') {
          beginEngineIntent(observedLivePhase(state), state.session_dir);
          knownSessionDirs.add(state.session_dir);
        } else if (engineIntent.phase === 'active' && state.active !== true) {
          beginEngineIntent('idle', null);
        }
      }
      return result;
    } catch (error) {
      if (error instanceof EngineRequestError && error.code === 'NO_ACTIVE_SESSION') {
        if (ownsEngineGeneration(commandIntent) && engineIntent.phase === 'active') {
          beginEngineIntent('idle', null);
        }
      }
      throw error;
    }
  });

  ipcMain.handle('dialog:open-script', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择录音脚本',
      properties: ['openFile'],
      filters: [
        { name: '脚本文件', extensions: ['csv', 'tsv', 'txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    const content = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    return { filePath, name: path.basename(filePath), content };
  });

  ipcMain.handle('dialog:choose-output', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '选择录制保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    const selected = result.canceled ? null : result.filePaths[0] ?? null;
    if (selected) {
      const lexical = path.resolve(selected);
      allowedOutputRoots.add(lexical);
      await resolveAuthorizedOutputRoot(lexical, false);
    }
    return selected;
  });

  ipcMain.handle('app:default-output', () => defaultOutputRoot());
  ipcMain.handle('prompter:open', async (event) => {
    assertMainRenderer(event.sender);
    await createPrompterWindow();
    return true;
  });
  ipcMain.handle('prompter:close', (event) => {
    const fromMain = mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
    const fromPrompter = prompterWindow && !prompterWindow.isDestroyed() && event.sender === prompterWindow.webContents;
    if (!fromMain && !fromPrompter) throw new Error('领读窗口不可用');
    prompterWindow?.close();
  });
  ipcMain.handle('prompter:toggle-fullscreen', (event) => {
    if (!prompterWindow || event.sender !== prompterWindow.webContents) {
      throw new Error('领读窗口不可用');
    }
    prompterWindow.setFullScreen(!prompterWindow.isFullScreen());
    return prompterWindow.isFullScreen();
  });
  ipcMain.handle('prompter:get-state', (event) => {
    if (!prompterWindow || event.sender !== prompterWindow.webContents) {
      throw new Error('领读窗口不可用');
    }
    return latestPrompterState;
  });
  ipcMain.on('prompter:update', (event, state: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    latestPrompterState = state;
    prompterWindow?.webContents.send('prompter:state', state);
  });
  ipcMain.handle('recordings:list', (_event, root: string) => listRecordings(root));
  ipcMain.handle('path:join', (_event, ...parts: string[]) => path.join(...parts));
  ipcMain.handle('audio:read', async (_event, filePath: string) => {
    if (!(await isInsideKnownSession(filePath)) || path.extname(filePath).toLowerCase() !== '.wav') {
      throw new Error('只能试听录制目录内的 WAV 文件');
    }
    const data = await fs.readFile(filePath);
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  });
  ipcMain.handle('shell:open-path', async (_event, target: string) => {
    if (!(await isInsideKnownSession(target))) throw new Error('只能打开已识别的录制目录');
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  beginEngineIntent('quitting', null);
  app.quit();
} else {
  app.on('second-instance', () => {
    if (isQuitting()) return;
    void showMainWindow().catch((error) => {
      console.error('无法在第二个应用实例启动时聚焦主窗口：', error);
    });
  });
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  registerIpc();
  engine = new EngineClient(engineExecutable());
  engine.on('event', (message) => sendToMain('engine:event', message));
  engine.on('offline', (message) => {
    sendToMain('engine:offline', message);
    const interruptedIntent = engineIntent;
    if (interruptedIntent.phase === 'quitting') return;
    if (interruptedIntent.phase === 'stopping') {
      const interruptedSessionDir = interruptedIntent.sessionDir;
      if (interruptedSessionDir) retainCrashSealObligation(interruptedSessionDir, message);
      pendingEngineRecovery = null;
      idleWhenEngineStopsGeneration = null;
      const recoveryIntent = beginEngineIntent('idle', null);
      clearBackgroundRecordingStatus();
      sendToMain('engine:event', {
        protocol_version: 1,
        event: 'engine_recovery_failed',
        payload: {
          session_dir: interruptedSessionDir ?? '',
          error: `安全停止期间引擎异常退出：${message}`,
        },
      });
      void engine?.start().then(() => {
        if (!isCurrentEngineIntent(recoveryIntent, ['idle'])) return;
        sendToMain('engine:event', {
          protocol_version: 1,
          event: 'engine_idle_after_stopping_crash',
          payload: { session_dir: interruptedSessionDir },
        });
      }).catch((error) => {
        if (!ownsEngineGeneration(recoveryIntent)) return;
        sendToMain('engine:offline', `安全停止异常后无法重启录音引擎：${error instanceof Error ? error.message : String(error)}`);
      });
      void notifyEngineRecoveryFailed(recoveryIntent, message);
      return;
    }
    if (interruptedIntent.sessionDir && SESSION_LIVE_PHASES.includes(interruptedIntent.phase)) {
      retainCrashSealObligation(interruptedIntent.sessionDir, message);
      void recoverEngineAfterCrash(interruptedIntent.sessionDir, message);
    } else if (ownsEngineGeneration(interruptedIntent)) {
      transitionEngineIntent(interruptedIntent, 'idle', null);
    }
  });
  engine.on('stopped', (outcome: EngineStoppedOutcome) => {
    if (!outcome.safe) {
      if (!forceExitConfirmed) void handleUnsafeEngineStop(outcome);
      return;
    }
    if (idleWhenEngineStopsGeneration === engineIntent.generation
      && engineIntent.phase === 'stopping') {
      const completedIntent = engineIntent;
      idleWhenEngineStopsGeneration = null;
      void engine?.start().then(() => {
        if (!isCurrentEngineIntent(completedIntent, ['stopping'])) return;
        transitionEngineIntent(completedIntent, 'idle', null);
        sendToMain('engine:event', {
          protocol_version: 1,
          event: 'offline_seal_cleanup_finished',
          payload: {},
        });
      }).catch((error) => {
        if (!ownsEngineGeneration(completedIntent)) return;
        transitionEngineIntent(completedIntent, 'idle', null);
        sendToMain('engine:offline', `离线封存清理完成，但录音引擎无法重新启动：${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    // Only a stop that originated in requestSafeStopAndQuit may complete an
    // application quit. Other reconciliation stops must never close the app.
    if (quitWhenEngineStops && engineIntent.phase === 'stopping' && !safeExitPromise) {
      void requestSafeStopAndQuit('延迟的音频封存已完成');
    }
  });
  engine.on('log', (message) => console.error(`[engine] ${message}`));
  try {
    await engine.start();
    if (isQuitting()) return;
  } catch (error) {
    console.error('Unable to start recorder engine:', error);
  }
  if (!isQuitting()) await createWindow();
});

app.on('activate', () => {
  if (!isQuitting()) void showMainWindow();
});

app.on('window-all-closed', () => {
  const keepBackgroundEngine = Boolean(
    engine?.running
      && (intentTracksLiveSession()
        || engineIntent.phase === 'sealing'
        || engineIntent.phase === 'exporting'
        || engineIntent.phase === 'stopping'),
  );
  if (keepBackgroundEngine) {
    ensureRecordingTray(engineIntent.phase === 'exporting'
      ? '录音交付正在后台导出…'
      : engineIntent.phase === 'sealing'
        ? '中断任务正在后台修复并封存…'
        : '● 后台录音正在进行');
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (appQuitReleased) return;
  event.preventDefault();
  void requestSafeStopAndQuit('应用退出');
});
