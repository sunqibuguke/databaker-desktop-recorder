import * as Sentry from '@sentry/electron/renderer';

const FILTERED = '[Filtered]';
const SENSITIVE_KEY = /(?:^|[_-])(?:authorization|cookie|dsn|password|secret|token|script(?:[_-]?name)?|text|content|session[_-]?(?:id|dir)|file[_-]?path|output[_-]?root)(?:$|[_-])/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)*[^\s\\/:*?"<>|]*/g;
const POSIX_PATH = /(?:^|[\s"'`(])\/(?:Users|home|Volumes|private|tmp|var|opt|mnt)\/[^\s"'`)]+/g;

function sanitizeString(value: string): string {
  return value
    .replace(UUID, '[RecordingId]')
    .replace(WINDOWS_PATH, '[LocalPath]')
    .replace(POSIX_PATH, (match) => `${match[0] === '/' ? '' : match[0]}[LocalPath]`);
}

function sanitizeValue(value: unknown, key = '', seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return FILTERED;
  if (typeof value === 'string') return sanitizeString(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, '', seen));
  for (const [childKey, childValue] of Object.entries(value)) {
    (value as Record<string, unknown>)[childKey] = sanitizeValue(childValue, childKey, seen);
  }
  return value;
}

Sentry.init({
  enableLogs: true,
  sendDefaultPii: false,
  tracesSampleRate: 0,
  maxBreadcrumbs: 50,
  integrations: [Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] })],
  beforeSend(event) {
    delete event.user;
    if (event.request) {
      delete event.request.cookies;
      delete event.request.data;
      delete event.request.headers;
      delete event.request.query_string;
    }
    return sanitizeValue(event) as typeof event;
  },
  beforeBreadcrumb(breadcrumb) {
    return sanitizeValue(breadcrumb) as typeof breadcrumb;
  },
  beforeSendLog(log) {
    return sanitizeValue(log) as typeof log;
  },
});

Sentry.setTag('process.type', 'renderer');
Sentry.setTag('app.feature', 'recorder');

export function reportRendererError(operation: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  Sentry.logger.error(operation, {
    error_type: error instanceof Error ? error.name : typeof error,
    error: sanitizeString(detail),
  });
}

export function captureRendererException(error: unknown, mechanism: string): void {
  Sentry.withScope((scope) => {
    scope.setTag('react.mechanism', mechanism);
    Sentry.captureException(error);
  });
}
