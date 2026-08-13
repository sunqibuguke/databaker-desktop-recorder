import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEBUG_LOG_CAPACITY = 2_000;
export const DEBUG_LOG_FILE_NAME = 'debug.log';
export const DEBUG_LOG_APP_FILE_NAME = 'runtime-debug.jsonl';

const MAX_MESSAGE_CHARS = 2_000;
const MAX_DATA_CHARS = 6_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const COMPACT_AFTER_APPENDS = 80;
const SESSION_SEED_COUNT = 60;

export type DebugLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DebugLogSource = 'ui' | 'main' | 'engine' | 'ipc';

export type DebugLogDraft = {
  level?: DebugLogLevel;
  source?: DebugLogSource;
  category?: string;
  event: string;
  message: string;
  session_id?: string;
  session_dir?: string;
  data?: Record<string, unknown>;
};

export type DebugLogEntry = {
  seq: number;
  ts: string;
  level: DebugLogLevel;
  source: DebugLogSource;
  category: string;
  event: string;
  message: string;
  session_id?: string;
  session_dir?: string;
  data?: Record<string, unknown>;
};

export type DebugLogSnapshot = {
  entries: DebugLogEntry[];
  dropped: number;
  capacity: number;
  bound_session_id: string;
  bound_session_dir: string;
  app_log_path: string;
  session_log_path: string;
};

const LEVELS = new Set<DebugLogLevel>(['debug', 'info', 'warn', 'error']);
const SOURCES = new Set<DebugLogSource>(['ui', 'main', 'engine', 'ipc']);
const QUIET_SUCCESS_COMMANDS = new Set([
  'get_state',
  'get_state_optional',
  'hello',
  'dev_feed_pcm',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max}]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const REDACT_KEYS = /^(?:items|waveform|content|text|script_items|samples)$/i;

export function summarizeForDebugLog(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return clampText(value, 240);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[Nested]';
  if (Array.isArray(value)) {
    if (value.length > 12) {
      return {
        length: value.length,
        preview: value.slice(0, 8).map((item) => summarizeForDebugLog(item, depth + 1)),
      };
    }
    return value.map((item) => summarizeForDebugLog(item, depth + 1));
  }
  if (!isRecord(value)) return String(value);
  const summary: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (REDACT_KEYS.test(key)) {
      if (Array.isArray(child)) summary[key] = { length: child.length };
      else if (typeof child === 'string') summary[key] = { chars: child.length };
      else summary[key] = '[omitted]';
      continue;
    }
    summary[key] = summarizeForDebugLog(child, depth + 1);
  }
  return summary;
}

export function compactDebugData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const summarized = summarizeForDebugLog(data);
  if (!isRecord(summarized)) return { value: summarized };
  const serialized = JSON.stringify(summarized);
  if (serialized.length <= MAX_DATA_CHARS) return summarized;
  return {
    truncated: true,
    preview: clampText(serialized, MAX_DATA_CHARS),
  };
}

function parseLevel(value: unknown): DebugLogLevel {
  return typeof value === 'string' && LEVELS.has(value as DebugLogLevel)
    ? value as DebugLogLevel
    : 'info';
}

function parseSource(value: unknown): DebugLogSource {
  return typeof value === 'string' && SOURCES.has(value as DebugLogSource)
    ? value as DebugLogSource
    : 'ui';
}

export function parseDebugLogEntry(value: unknown): DebugLogEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.event !== 'string' || !value.event.trim()) return null;
  if (typeof value.message !== 'string') return null;
  const seq = typeof value.seq === 'number' && Number.isSafeInteger(value.seq) && value.seq > 0
    ? value.seq
    : 0;
  const ts = typeof value.ts === 'string' && value.ts.trim() ? value.ts : '';
  if (!seq || !ts) return null;
  const entry: DebugLogEntry = {
    seq,
    ts,
    level: parseLevel(value.level),
    source: parseSource(value.source),
    category: typeof value.category === 'string' && value.category.trim()
      ? value.category.trim().slice(0, 40)
      : 'app',
    event: value.event.trim().slice(0, 80),
    message: clampText(value.message, MAX_MESSAGE_CHARS),
  };
  if (typeof value.session_id === 'string' && value.session_id.trim()) {
    entry.session_id = value.session_id.trim();
  }
  if (typeof value.session_dir === 'string' && value.session_dir.trim()) {
    entry.session_dir = value.session_dir.trim();
  }
  if (isRecord(value.data)) entry.data = compactDebugData(value.data);
  return entry;
}

export function formatDebugLogText(
  entries: readonly DebugLogEntry[],
  meta: { bound_session_id?: string; bound_session_dir?: string } = {},
): string {
  const header = [
    'DataBaker Recorder debug log',
    `generated_at=${new Date().toISOString()}`,
    `entries=${entries.length}`,
    meta.bound_session_id ? `session_id=${meta.bound_session_id}` : '',
    meta.bound_session_dir ? `session_dir=${meta.bound_session_dir}` : '',
    `host=${os.hostname()}`,
    `platform=${process.platform} ${os.release()} ${process.arch}`,
    '',
  ].filter((line) => line !== '').join('\n');
  const body = entries.map((entry) => {
    const parts = [
      entry.ts,
      entry.level.toUpperCase().padEnd(5),
      `${entry.source}/${entry.category}`,
      entry.event,
      entry.message,
    ];
    if (entry.session_id) parts.push(`session=${entry.session_id}`);
    if (entry.data && Object.keys(entry.data).length) {
      parts.push(JSON.stringify(entry.data));
    }
    return parts.join('  ');
  });
  return `${header}\n${body.join('\n')}\n`;
}

export function shouldLogEngineCommand(
  command: string,
  failed: boolean,
): boolean {
  if (failed) return true;
  return !QUIET_SUCCESS_COMMANDS.has(command);
}

export class DebugLogStore {
  private entries: DebugLogEntry[] = [];
  private dropped = 0;
  private seq = 0;
  private boundSessionId = '';
  private boundSessionDir = '';
  private sessionLogPath = '';
  private writeTail: Promise<void> = Promise.resolve();
  private pendingAppends = 0;
  private persistGeneration = 0;
  private listeners = new Set<(entry: DebugLogEntry) => void>();

  constructor(
    readonly appLogPath: string,
    private readonly capacity = DEBUG_LOG_CAPACITY,
    private readonly now: () => number = Date.now,
    private readonly createToken: () => string = randomUUID,
  ) {}

  onEntry(listener: (entry: DebugLogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DebugLogSnapshot {
    return {
      entries: this.entries.slice(),
      dropped: this.dropped,
      capacity: this.capacity,
      bound_session_id: this.boundSessionId,
      bound_session_dir: this.boundSessionDir,
      app_log_path: this.appLogPath,
      session_log_path: this.sessionLogPath,
    };
  }

  formatText(entries = this.entries): string {
    return formatDebugLogText(entries, {
      bound_session_id: this.boundSessionId,
      bound_session_dir: this.boundSessionDir,
    });
  }

  async loadAppLog(): Promise<void> {
    const loaded = await this.readLogFile(this.appLogPath);
    this.replaceEntries(loaded);
  }

  async bindSession(sessionDir: string, sessionId: string): Promise<DebugLogSnapshot> {
    const resolvedDir = path.resolve(sessionDir);
    const nextPath = path.join(resolvedDir, DEBUG_LOG_FILE_NAME);
    if (this.boundSessionDir === resolvedDir && this.sessionLogPath === nextPath) {
      if (sessionId && this.boundSessionId !== sessionId) this.boundSessionId = sessionId;
      return this.snapshot();
    }
    await this.flush();
    const previous = this.entries.slice(-SESSION_SEED_COUNT);
    this.boundSessionDir = resolvedDir;
    this.boundSessionId = sessionId.trim();
    this.sessionLogPath = nextPath;
    this.persistGeneration += 1;
    const existing = await this.readLogFile(nextPath);
    if (existing.length) {
      this.replaceEntries(existing);
    } else if (previous.length) {
      this.replaceEntries(previous);
      await this.writeSnapshotIfSessionDirExists();
    }
    this.append({
      level: 'info',
      source: 'main',
      category: 'session',
      event: 'debug_log.bind',
      message: `已绑定任务日志：${this.boundSessionId || path.basename(resolvedDir)}`,
      data: { session_dir: resolvedDir, seeded: existing.length === 0 ? previous.length : 0 },
    });
    return this.snapshot();
  }

  async unbindSession(reason = 'leave'): Promise<void> {
    if (!this.boundSessionDir) return;
    this.append({
      level: 'info',
      source: 'main',
      category: 'session',
      event: 'debug_log.unbind',
      message: `已解除任务日志绑定（${reason}）`,
      data: { reason },
    });
    await this.flush();
    this.boundSessionDir = '';
    this.boundSessionId = '';
    this.sessionLogPath = '';
    this.persistGeneration += 1;
    await this.loadAppLog();
  }

  async forgetSession(sessionDir: string): Promise<void> {
    const resolved = path.resolve(sessionDir);
    if (this.boundSessionDir && path.resolve(this.boundSessionDir) === resolved) {
      this.persistGeneration += 1;
      this.boundSessionDir = '';
      this.boundSessionId = '';
      this.sessionLogPath = '';
      await this.flush();
      await this.loadAppLog();
    }
    this.append({
      level: 'info',
      source: 'main',
      category: 'history',
      event: 'debug_log.forget_session',
      message: '任务已删除，对应调试日志随任务目录一并清理',
      data: { session_dir: resolved },
    });
  }

  append(draft: DebugLogDraft): DebugLogEntry {
    const entry: DebugLogEntry = {
      seq: ++this.seq,
      ts: new Date(this.now()).toISOString(),
      level: draft.level ?? 'info',
      source: draft.source ?? 'main',
      category: (draft.category ?? 'app').trim().slice(0, 40) || 'app',
      event: draft.event.trim().slice(0, 80),
      message: clampText(draft.message, MAX_MESSAGE_CHARS),
    };
    const sessionId = draft.session_id?.trim() || this.boundSessionId;
    const sessionDir = draft.session_dir?.trim() || this.boundSessionDir;
    if (sessionId) entry.session_id = sessionId;
    if (sessionDir) entry.session_dir = sessionDir;
    if (draft.data) entry.data = compactDebugData(draft.data);
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      const overflow = this.entries.length - this.capacity;
      this.entries.splice(0, overflow);
      this.dropped += overflow;
    }
    this.pendingAppends += 1;
    const generation = this.persistGeneration;
    this.enqueueWrite(async () => {
      if (generation !== this.persistGeneration) return;
      const persisted = await this.appendLine(entry);
      if (!persisted) return;
      if (
        this.currentFile() === this.appLogPath
        && (this.pendingAppends >= COMPACT_AFTER_APPENDS || this.entries.length >= this.capacity)
      ) {
        this.pendingAppends = 0;
        await this.rewriteCurrentFile();
      }
    });
    for (const listener of [...this.listeners]) listener(entry);
    return entry;
  }

  appendFromRenderer(raw: unknown): DebugLogEntry {
    if (!isRecord(raw) || typeof raw.event !== 'string' || !raw.event.trim()
      || typeof raw.message !== 'string') {
      throw new Error('调试日志条目无效');
    }
    return this.append({
      level: parseLevel(raw.level),
      source: parseSource(raw.source) === 'ui' || parseSource(raw.source) === 'ipc'
        ? parseSource(raw.source)
        : 'ui',
      category: typeof raw.category === 'string' ? raw.category : 'ui',
      event: raw.event,
      message: raw.message,
      session_id: typeof raw.session_id === 'string' ? raw.session_id : undefined,
      session_dir: typeof raw.session_dir === 'string' ? raw.session_dir : undefined,
      data: isRecord(raw.data) ? raw.data : undefined,
    });
  }

  recordCommand(
    command: string,
    payload: unknown,
    result: unknown,
    durationMs: number,
    error: unknown,
  ): DebugLogEntry | null {
    const failed = Boolean(error);
    if (!shouldLogEngineCommand(command, failed)) return null;
    return this.append({
      level: failed ? 'error' : 'info',
      source: 'ipc',
      category: 'engine',
      event: `engine.${command}`,
      message: failed
        ? `引擎命令 ${command} 失败：${errorMessage(error)}`
        : `引擎命令 ${command} 成功（${durationMs}ms）`,
      data: {
        command,
        duration_ms: durationMs,
        payload: summarizeForDebugLog(payload),
        result: failed ? undefined : summarizeForDebugLog(result),
        error: failed
          ? {
            name: error instanceof Error ? error.name : typeof error,
            message: errorMessage(error),
          }
          : undefined,
      },
    });
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  private currentFile(): string {
    return this.sessionLogPath || this.appLogPath;
  }

  private replaceEntries(entries: DebugLogEntry[]): void {
    this.entries = entries.slice(-this.capacity);
    this.dropped = Math.max(0, entries.length - this.entries.length);
    this.seq = this.entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
    this.pendingAppends = 0;
  }

  private enqueueWrite(operation: () => Promise<void>): void {
    this.writeTail = this.writeTail.then(operation, operation).catch(() => undefined);
  }

  private async readLogFile(filePath: string): Promise<DebugLogEntry[]> {
    let serialized: string;
    try {
      const handle = await fs.open(filePath, 'r');
      try {
        const stat = await handle.stat();
        if (stat.size <= 0) return [];
        const start = stat.size > MAX_FILE_BYTES ? stat.size - MAX_FILE_BYTES : 0;
        const buffer = Buffer.alloc(Number(stat.size - start));
        await handle.read(buffer, 0, buffer.length, start);
        serialized = buffer.toString('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries: DebugLogEntry[] = [];
    for (const line of serialized.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = parseDebugLogEntry(JSON.parse(line));
        if (parsed) entries.push(parsed);
      } catch {
        // Skip a damaged line; the ring buffer is a fallback, not a journal.
      }
    }
    return entries.slice(-this.capacity);
  }

  private async ensureAppLogDirectory(filePath: string): Promise<boolean> {
    if (this.sessionLogPath && filePath === this.sessionLogPath) {
      try {
        const stat = await fs.lstat(path.dirname(filePath));
        return stat.isDirectory();
      } catch {
        return false;
      }
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    return true;
  }

  private async appendLine(entry: DebugLogEntry): Promise<boolean> {
    const filePath = this.currentFile();
    if (!(await this.ensureAppLogDirectory(filePath))) return false;
    try {
      await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async writeSnapshotIfSessionDirExists(): Promise<void> {
    const filePath = this.currentFile();
    if (!(await this.ensureAppLogDirectory(filePath))) return;
    const payload = `${this.entries.map((entry) => JSON.stringify(entry)).join('\n')}${this.entries.length ? '\n' : ''}`;
    try {
      await fs.writeFile(filePath, payload, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await fs.appendFile(filePath, payload, 'utf8');
        return;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async rewriteCurrentFile(): Promise<void> {
    const filePath = this.currentFile();
    if (!(await this.ensureAppLogDirectory(filePath))) return;
    const token = this.createToken().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32) || String(this.now());
    const temporaryPath = `${filePath}.tmp-${process.pid}-${token}`;
    const payload = `${this.entries.map((entry) => JSON.stringify(entry)).join('\n')}${this.entries.length ? '\n' : ''}`;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

export function sessionIdentityFromResult(result: unknown): { sessionDir: string; sessionId: string } | null {
  if (!isRecord(result)) return null;
  const sessionDir = typeof result.session_dir === 'string' ? result.session_dir.trim() : '';
  const snapshot = isRecord(result.snapshot) ? result.snapshot : null;
  const sessionId = snapshot && typeof snapshot.session_id === 'string'
    ? snapshot.session_id.trim()
    : typeof result.session_id === 'string' ? result.session_id.trim() : '';
  if (!sessionDir || !sessionId) return null;
  return { sessionDir, sessionId };
}

export const SESSION_BIND_COMMANDS = new Set([
  'create_session',
  'inspect_session',
  'start_session',
  'resume_session',
  'activate_session',
]);
