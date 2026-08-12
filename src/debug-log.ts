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

export type DebugLogEntry = DebugLogDraft & {
  seq: number;
  ts: string;
  level: DebugLogLevel;
  source: DebugLogSource;
  category: string;
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
    '',
  ].filter(Boolean).join('\n');
  const body = entries.map((entry) => {
    const parts = [
      entry.ts,
      entry.level.toUpperCase().padEnd(5),
      `${entry.source}/${entry.category}`,
      entry.event,
      entry.message,
    ];
    if (entry.session_id) parts.push(`session=${entry.session_id}`);
    if (entry.data && Object.keys(entry.data).length) parts.push(JSON.stringify(entry.data));
    return parts.join('  ');
  });
  return `${header}\n${body.join('\n')}\n`;
}

export function appendDebugLog(draft: DebugLogDraft): void {
  const recorder = window.recorder;
  if (!recorder.appendDebugLog) return;
  void recorder.appendDebugLog(draft).catch(() => undefined);
}

export function logUserAction(
  event: string,
  message: string,
  data?: Record<string, unknown>,
  level: DebugLogLevel = 'info',
): void {
  appendDebugLog({
    level,
    source: 'ui',
    category: 'ui',
    event,
    message,
    data,
  });
}
