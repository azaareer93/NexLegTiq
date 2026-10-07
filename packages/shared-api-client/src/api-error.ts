import { isErrorCode } from '@nexlegtiq/shared-types';
import type { ApiErrorDetail, ApiErrorResponse, ErrorCode } from '@nexlegtiq/shared-types';
import { isAxiosError } from 'axios';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Every failed call rejects with an `ApiError`: the UI maps `code` → `t('errors.<CODE>')` and `details` → form fields
 * (api-conventions.md). `message` is the server's English developer message, never shown to users.
 */
/** D-076's shape of a request id: anything else (a proxy's header, injected text) is not shown to users as a reference. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export class ApiError extends Error {
  override readonly name = 'ApiError';
  /** D-076 correlation id, shown to the user for support; only when it has the D-076 shape. */
  readonly requestId?: string;

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** HTTP status; 0 when no response arrived (offline, timeout, CORS). */
    readonly status: number,
    readonly details: readonly ApiErrorDetail[] = [],
    requestId?: string,
    /** Seconds to wait before retrying, from `Retry-After` (429 RATE-001, 503). */
    readonly retryAfter?: number,
  ) {
    super(message);
    if (requestId !== undefined && SAFE_REQUEST_ID.test(requestId)) this.requestId = requestId;
  }
}

function isErrorEnvelope(body: unknown): body is ApiErrorResponse {
  const error = (body as Partial<ApiErrorResponse> | null)?.error;
  return (
    (body as { success?: unknown } | null)?.success === false && typeof error?.code === 'string'
  );
}

/** The `x-request-id` response header, when there is one (ApiError keeps it only if well-formed). */
const headerIdOf = (headers: Record<string, unknown>): string | undefined => {
  const id = headers[REQUEST_ID_HEADER];
  return typeof id === 'string' ? id : undefined;
};

/** Seconds from `Retry-After`: only the delta-seconds form (an HTTP-date is not worth parsing for a hint), a day at most. */
function retryAfterOf(headers: Record<string, unknown>): number | undefined {
  const seconds = Number(headers['retry-after']);
  // A hostile or broken header must not tell the user to wait for years.
  return Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, 86_400) : undefined;
}

/** The API's own error envelope, as sent. */
function fromEnvelope(
  body: ApiErrorResponse,
  status: number,
  headerId: string | undefined,
  retryAfter: number | undefined,
): ApiError {
  const { code, message, details } = body.error;
  // A code this build does not know yet (newer server) falls back to the generic one, like ErrorState does.
  const known = isErrorCode(code) ? code : 'SYS-001';
  return new ApiError(
    known,
    message,
    status,
    details ?? [],
    body.meta?.requestId ?? headerId,
    retryAfter,
  );
}

/** Normalises anything a request can throw. Cancellations pass through untouched (TanStack Query ignores them). */
export function toApiError(error: unknown): unknown {
  if (error instanceof ApiError || !isAxiosError(error) || error.code === 'ERR_CANCELED') {
    return error;
  }
  const response = error.response;
  if (!response) {
    // No answer at all: the user is offline, the server is down or the 30 s timeout hit.
    return new ApiError('SYS-002', error.message, 0);
  }
  const headers = response.headers as Record<string, unknown>;
  const headerId = headerIdOf(headers);
  const retryAfter = retryAfterOf(headers);
  const body: unknown = response.data;
  if (isErrorEnvelope(body)) {
    return fromEnvelope(body, response.status, headerId, retryAfter);
  }
  // Not our envelope: a proxy or CDN answered (502/503/504 while the API restarts, an HTML error page…).
  const code = response.status >= 502 && response.status <= 504 ? 'SYS-002' : 'SYS-001';
  return new ApiError(code, error.message, response.status, [], headerId, retryAfter);
}
