const FILTERED = '[Filtered]';
const SENSITIVE_KEY = /(?:^|[_-])(?:authorization|cookie|dsn|password|secret|token|ticket|license|machine(?:[_-]?code)?|script(?:[_-]?name)?|text|content|session[_-]?(?:id|dir)|file[_-]?path|output[_-]?root)(?:$|[_-])/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)*[^\s\\/:*?"<>|]*/g;
const POSIX_PATH = /(?:^|[\s"'`(])\/(?:Users|home|Volumes|private|tmp|var|opt|mnt)\/[^\s"'`)]+/g;

export function sanitizeString(value: string): string {
  return value
    .replace(UUID, '[RecordingId]')
    .replace(WINDOWS_PATH, '[LocalPath]')
    .replace(POSIX_PATH, (match) => `${match[0] === '/' ? '' : match[0]}[LocalPath]`);
}

export function sanitizeValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return FILTERED;
  if (typeof value === 'string') return sanitizeString(value);
  if (!value || typeof value !== 'object') return value;

  // Sentry's Electron integrations can supply boxed strings whose indexed
  // character properties are read-only. Treat them like primitive strings.
  if (Object.prototype.toString.call(value) === '[object String]') {
    return sanitizeString(String(value));
  }

  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, '', seen));

  // Never mutate Sentry-owned values: integrations may freeze their events or
  // expose other read-only properties.
  const sanitized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    sanitized[childKey] = sanitizeValue(childValue, childKey, seen);
  }
  return sanitized;
}
