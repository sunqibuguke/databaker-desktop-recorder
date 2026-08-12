import * as Sentry from '@sentry/electron/renderer';
import { appendDebugLog } from './debug-log';
import { sanitizeString, sanitizeValue } from './sentry-sanitize';

Sentry.init({
  enableLogs: true,
  sendDefaultPii: false,
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

Sentry.setTag('process.type', 'renderer');
Sentry.setTag('app.feature', 'recorder');

export function reportRendererError(operation: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  appendDebugLog({
    level: 'error',
    source: 'ui',
    category: 'error',
    event: 'renderer.error',
    message: `${operation}：${detail}`,
    data: {
      operation,
      error_type: error instanceof Error ? error.name : typeof error,
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
  Sentry.logger.error(operation, {
    error_type: error instanceof Error ? error.name : typeof error,
    error: sanitizeString(detail),
  });
}

export function captureRendererException(error: unknown, mechanism: string): void {
  const detail = error instanceof Error ? error.message : String(error);
  appendDebugLog({
    level: 'error',
    source: 'ui',
    category: 'error',
    event: 'renderer.exception',
    message: `未捕获异常（${mechanism}）：${detail}`,
    data: {
      mechanism,
      error_type: error instanceof Error ? error.name : typeof error,
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
  Sentry.withScope((scope) => {
    scope.setTag('react.mechanism', mechanism);
    Sentry.captureException(error);
  });
}
