import { Injectable } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

import type { AppConfig } from '../../config/app-config';
import { AppException } from '../errors/app.exception';
import { loggableError } from '../errors/error-log';

/** Tags an error report may carry: ids and codes only, never request or job data (D-230). */
export type ReportTags = Readonly<Record<string, string | number | null | undefined>>;

/**
 * Starts Sentry when SENTRY_DSN is set (D-230); without it nothing is initialised and `reportError` is a no-op.
 * No default integrations: nothing hooks into HTTP, the console or modules, so the only events are the ones this file
 * sends — 5xx request failures (GlobalExceptionFilter) and jobs that failed their last attempt (TenantProcessor).
 */
export function initErrorReporting(config: AppConfig, process: 'api' | 'worker'): boolean {
  const { dsn, environment, release } = config.errorReporting;
  if (!dsn) return false;
  Sentry.initWithoutDefaultIntegrations({
    dsn,
    environment,
    ...(release && { release }),
    initialScope: { tags: { process } },
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    maxBreadcrumbs: 0,
    includeServerName: false,
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    beforeSend: scrubEvent,
  });
  return true;
}

/** Sends what is still queued before the process exits. */
export async function closeErrorReporting(): Promise<void> {
  await Sentry.close(2000);
}

/** Flushes the API's last reports when Nest shuts down (shutdown hooks are on, configure-app.ts). */
@Injectable()
export class ErrorReportingShutdown implements OnApplicationShutdown {
  onApplicationShutdown(): Promise<void> {
    return closeErrorReporting();
  }
}

/**
 * Last line of the PII guard (D-230): an event keeps only the exception and tags. Request data (body, headers,
 * cookies, query), user, breadcrumbs and extra are dropped even if an SDK change starts adding them.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const {
    request: _request,
    user: _user,
    breadcrumbs: _breadcrumbs,
    extra: _extra,
    ...kept
  } = event;
  return kept;
}

/**
 * Reports an unexpected error, never the original object. Sentry is an outside processor, so it gets less than the
 * logs: only our own AppException messages (developer-written) are kept; any other message is dropped, since library
 * errors quote their input (`JSON.parse` quotes the text, Prisma quotes query values, decimal.js the value). The stack
 * keeps only its frames.
 */
export function reportError(error: unknown, tags: ReportTags): void {
  const safe = loggableError(error, 500);
  const type = String(safe['type']);
  const prismaCode = typeof safe['prismaCode'] === 'string' ? safe['prismaCode'] : undefined;
  const message =
    error instanceof AppException && typeof safe['message'] === 'string' ? safe['message'] : '';
  const reported = new Error(message || prismaCode || type);
  reported.name = type;
  const frames = typeof safe['stack'] === 'string' ? stackFrames(safe['stack']) : [];
  reported.stack = [`${type}: ${reported.message}`, ...frames].join('\n');
  const kept: Record<string, string | number> = {};
  for (const [key, value] of Object.entries({ ...tags, prismaCode })) {
    if (value !== null && value !== undefined) kept[key] = value;
  }
  Sentry.captureException(reported, { tags: kept });
}

/** The `    at …` lines of a V8 stack; the header above them repeats the (possibly multi-line) message. */
function stackFrames(stack: string): string[] {
  return stack.split('\n').filter((line) => /^\s+at /.test(line));
}
