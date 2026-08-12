type SentryMain = typeof import('@sentry/electron/main');

import { sanitizeString, sanitizeValue } from './sentry-sanitize.js';

const DEFAULT_SENTRY_DSN = 'https://d913b3fd09ee601981e238589a5a9c86@o4508809916841984.ingest.us.sentry.io/4511896394268672';

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
      const sanitized = sanitizeValue(event) as typeof event;
      delete sanitized.user;
      if (sanitized.request) {
        delete sanitized.request.cookies;
        delete sanitized.request.data;
        delete sanitized.request.headers;
        delete sanitized.request.query_string;
      }
      return sanitized;
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
