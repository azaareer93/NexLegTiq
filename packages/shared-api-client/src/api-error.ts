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
  return (body as { success?: unknown } | null)?.success === false && typeof error?.code === 'string';
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
  const headerId = response.headers[REQUEST_ID_HEADER] as unknown;
  // Only the delta-seconds form; an HTTP-date is not worth parsing for a hint.
  const retryHeader = Number(response.headers['retry-after']);
  // A day at most: a hostile or broken header must not tell the user to wait for years.
  const retryAfter = Number.isInteger(retryHeader) && retryHeader > 0 ? Math.min(retryHeader, 86_400) : undefined;
  const body: unknown = response.data;
  if (isErrorEnvelope(body)) {
    const { code, message, details } = body.error;
    // A code this build does not know yet (newer server) falls back to the generic one, like ErrorState does.
    return new ApiError(
      isErrorCode(code) ? code : 'SYS-001',
      message,
      response.status,
      details ?? [],
      body.meta?.requestId ?? (typeof headerId === 'string' ? headerId : undefined),
      retryAfter,
    );
  }
  // Not our envelope: a proxy or CDN answered (502/503/504 while the API restarts, an HTML error page…).
  const code = response.status >= 502 && response.status <= 504 ? 'SYS-002' : 'SYS-001';
  return new ApiError(code, error.message, response.status, [], typeof headerId === 'string' ? headerId : undefined, retryAfter);
}
