import { isErrorCode } from '@nexlegtiq/shared-types';
import type { ApiErrorDetail, ApiErrorResponse, ErrorCode } from '@nexlegtiq/shared-types';
import { isAxiosError } from 'axios';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Every failed call rejects with an `ApiError`: the UI maps `code` → `t('errors.<CODE>')` and `details` → form fields
 * (api-conventions.md). `message` is the server's English developer message, never shown to users.
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** HTTP status; 0 when no response arrived (offline, timeout, CORS). */
    readonly status: number,
    readonly details: readonly ApiErrorDetail[] = [],
    /** D-076 correlation id, shown to the user for support. */
    readonly requestId?: string,
  ) {
    super(message);
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
    );
  }
  // Not our envelope: a proxy or CDN answered (502/503/504 while the API restarts, an HTML error page…).
  const code = response.status >= 502 && response.status <= 504 ? 'SYS-002' : 'SYS-001';
  return new ApiError(code, error.message, response.status, [], typeof headerId === 'string' ? headerId : undefined);
}
