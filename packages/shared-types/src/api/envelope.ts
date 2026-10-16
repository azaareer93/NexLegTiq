import type { ErrorCode } from './error-codes.js';

export interface PaginationMeta {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
}

export interface ApiMeta {
  /** ISO-8601 UTC. */
  readonly timestamp: string;
  readonly requestId: string;
  readonly pagination?: PaginationMeta;
}

export interface ApiErrorDetail {
  readonly field: string;
  readonly message: string;
  /** Facts the UI shows with the message, e.g. the conflicting session of a 409 BIZ-004 (D-116). */
  readonly params?: Readonly<Record<string, string | null>>;
}

export interface ApiError {
  readonly code: ErrorCode;
  /** English developer message; UI text comes from `errors.<code>`. */
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
}

export interface ApiSuccessResponse<T> {
  readonly success: true;
  readonly data: T;
  readonly meta: ApiMeta;
}

export interface ApiErrorResponse {
  readonly success: false;
  readonly error: ApiError;
  readonly meta: ApiMeta;
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
