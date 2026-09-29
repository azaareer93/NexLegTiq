import type { HttpStatus } from '@nestjs/common';
import type { ApiErrorDetail, ErrorCode } from '@nexlegtiq/shared-types';

import { DEFAULT_MESSAGE, ERROR_STATUS } from './error-catalog';

/**
 * Base of every expected error. The HTTP status comes from the error catalog, so throw sites only pick a code.
 * `message` is an English developer message; clients translate by `code`.
 */
export class AppException extends Error {
  readonly status: HttpStatus;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: readonly ApiErrorDetail[],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.status = ERROR_STATUS[code];
  }
}

export class ValidationException extends AppException {
  constructor(details: readonly ApiErrorDetail[], message: string = DEFAULT_MESSAGE['VAL-001']) {
    super('VAL-001', message, details);
  }
}

/** 404 RES-001 — also used for other offices' resources (D-019: never leak existence). */
export class ResourceNotFoundException extends AppException {
  constructor(message: string = DEFAULT_MESSAGE['RES-001']) {
    super('RES-001', message);
  }
}

/** Named to avoid clashing with Nest's ConflictException (which would map by status to a generic code). */
export class ResourceConflictException extends AppException {
  constructor(code: 'RES-002' | 'RES-003', message: string = DEFAULT_MESSAGE[code]) {
    super(code, message);
  }
}

export class PermissionDeniedException extends AppException {
  constructor(message: string = DEFAULT_MESSAGE['AUTH-100']) {
    super('AUTH-100', message);
  }
}

type BusinessCode = Extract<ErrorCode, `BIZ-${string}`>;

export class BusinessRuleException extends AppException {
  constructor(code: BusinessCode, message: string, details?: readonly ApiErrorDetail[]) {
    super(code, message, details);
  }
}

/** 503 SYS-002: a dependency (db, redis, storage…) is not ready. */
export class DependencyUnavailableException extends AppException {
  constructor(details?: readonly ApiErrorDetail[]) {
    super('SYS-002', DEFAULT_MESSAGE['SYS-002'], details);
  }
}
