type SentryMain = typeof import('@sentry/electron/main');

const DEFAULT_SENTRY_DSN = 'https://d913b3fd09ee601981e238589a5a9c86@o4508809916841984.ingest.us.sentry.io/4511896394268672';
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

const configuredDsn = process.env.SENTRY_DSN;
const sentryDsn = configuredDsn === '' ? null : (configuredDsn ?? DEFAULT_SENTRY_DSN);
const sentryEnabled = Boolean(
  process.versions.electron
  && process.env.NODE_ENV !== 'test'
  && process.env.DATABAKER_SENTRY_DISABLED !== '1'
  && sentryDsn,
);
const Sentry: SentryMain | null = sentryEnabled
  ? require('@sentry/electron/main') as SentryMain
  : null;

if (Sentry && sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.SENTRY_ENVIRONMENT
      ?? (process.env.VITE_DEV_SERVER_URL ? 'development' : 'production'),
    dist: process.arch,
    enableLogs: true,
    sendDefaultPii: false,
    attachScreenshot: false,
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
  Sentry.setTag('process.type', 'main');
  Sentry.setTag('app.feature', 'recorder');
}

export function isSentryEnabled(): boolean {
  return sentryEnabled;
}

export function recordRecorderPhase(phase: string, hasActiveRecording: boolean): void {
  if (!Sentry) return;
  Sentry.setTag('recorder.phase', phase);
  Sentry.setTag('recorder.active', hasActiveRecording ? 'true' : 'false');
  Sentry.logger.info('Recorder lifecycle changed', {
    phase,
    active_recording: hasActiveRecording,
  });
}

export function reportOperationalError(
  operation: string,
  error: unknown,
  attributes: Record<string, string | number | boolean> = {},
): void {
  if (!Sentry) return;
  const detail = error instanceof Error ? error.message : String(error);
  Sentry.logger.error(operation, {
    ...attributes,
    error_type: error instanceof Error ? error.name : typeof error,
    error: sanitizeString(detail),
  });
}

export function reportEngineOffline(phase: string, message: string): void {
  if (!Sentry) return;
  Sentry.withScope((scope) => {
    scope.setLevel('error');
    scope.setTag('recorder.phase', phase);
    scope.setContext('engine', { message: sanitizeString(message) });
    Sentry.captureMessage('Recorder engine went offline');
  });
}

export async function flushSentry(timeoutMs = 1_500): Promise<void> {
  if (!Sentry) return;
  await Sentry.flush(timeoutMs);
}
