import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

import type { AppConfig } from '../../config/app-config';
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

/**
 * Last line of the PII guard (D-230): an event keeps only the exception, tags and runtime contexts. Request data
 * (body, headers, cookies, query), user, breadcrumbs and extra are dropped even if an SDK change starts adding them.
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
 * Reports an unexpected error. What is sent is what the logs keep (`loggableError`): Prisma errors without their
 * message (it quotes query arguments), client-caused errors without message or properties, never the original object.
 */
export function reportError(error: unknown, tags: ReportTags): void {
  const safe = loggableError(error, 500);
  const type = String(safe['type']);
  const message = typeof safe['message'] === 'string' ? safe['message'] : '';
  const prismaCode = typeof safe['prismaCode'] === 'string' ? safe['prismaCode'] : undefined;
  const reported = new Error(message || prismaCode || type);
  reported.name = type;
  reported.stack =
    typeof safe['stack'] === 'string' ? safe['stack'] : `${type}: ${reported.message}`;
  const kept: Record<string, string | number> = {};
  for (const [key, value] of Object.entries({ ...tags, prismaCode })) {
    if (value !== null && value !== undefined) kept[key] = value;
  }
  Sentry.captureException(reported, { tags: kept });
}
