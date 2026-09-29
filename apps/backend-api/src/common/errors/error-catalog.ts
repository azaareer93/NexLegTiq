import { HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@nexlegtiq/shared-types';

/** HTTP status per error code (docs/context/api-conventions.md#error-codes). The single place to change it. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, HttpStatus>> = {
  'AUTH-001': HttpStatus.UNAUTHORIZED,
  'AUTH-002': HttpStatus.UNAUTHORIZED,
  'AUTH-003': HttpStatus.UNAUTHORIZED,
  'AUTH-004': HttpStatus.UNAUTHORIZED,
  'AUTH-005': HttpStatus.UNAUTHORIZED,
  'AUTH-006': HttpStatus.FORBIDDEN,
  'AUTH-007': HttpStatus.LOCKED,
  'AUTH-008': HttpStatus.UNAUTHORIZED,
  'AUTH-009': HttpStatus.UNAUTHORIZED,
  'AUTH-010': HttpStatus.FORBIDDEN,
  'AUTH-100': HttpStatus.FORBIDDEN,
  'AUTH-101': HttpStatus.FORBIDDEN,
  'AUTH-102': HttpStatus.FORBIDDEN,
  'AUTH-103': HttpStatus.FORBIDDEN,
  'VAL-001': HttpStatus.BAD_REQUEST,
  'VAL-002': HttpStatus.BAD_REQUEST,
  'VAL-003': HttpStatus.BAD_REQUEST,
  'VAL-004': HttpStatus.BAD_REQUEST,
  'VAL-005': HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  'VAL-006': HttpStatus.PAYLOAD_TOO_LARGE,
  'VAL-007': HttpStatus.BAD_REQUEST,
  'RES-001': HttpStatus.NOT_FOUND,
  'RES-002': HttpStatus.CONFLICT,
  'RES-003': HttpStatus.CONFLICT,
  'RES-004': HttpStatus.GONE,
  'BIZ-001': HttpStatus.UNPROCESSABLE_ENTITY,
  'BIZ-002': HttpStatus.UNPROCESSABLE_ENTITY,
  'BIZ-003': HttpStatus.UNPROCESSABLE_ENTITY,
  'BIZ-004': HttpStatus.CONFLICT,
  'BIZ-005': HttpStatus.UNPROCESSABLE_ENTITY,
  'BIZ-006': HttpStatus.UNPROCESSABLE_ENTITY,
  'BIZ-007': HttpStatus.UNPROCESSABLE_ENTITY,
  'BIZ-008': HttpStatus.UNPROCESSABLE_ENTITY,
  'BIZ-009': HttpStatus.CONFLICT,
  'AI-001': HttpStatus.SERVICE_UNAVAILABLE,
  'AI-002': HttpStatus.TOO_MANY_REQUESTS,
  'AI-003': HttpStatus.PAYLOAD_TOO_LARGE,
  'AI-004': HttpStatus.BAD_GATEWAY,
  'AI-005': HttpStatus.FORBIDDEN,
  'STO-001': HttpStatus.BAD_GATEWAY,
  'STO-002': HttpStatus.BAD_GATEWAY,
  'STO-003': HttpStatus.BAD_GATEWAY,
  'STO-004': HttpStatus.UNPROCESSABLE_ENTITY,
  'EXT-001': HttpStatus.BAD_GATEWAY,
  'EXT-002': HttpStatus.BAD_GATEWAY,
  'RATE-001': HttpStatus.TOO_MANY_REQUESTS,
  'SYS-001': HttpStatus.INTERNAL_SERVER_ERROR,
  'SYS-002': HttpStatus.SERVICE_UNAVAILABLE,
  'DB-001': HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * Generic developer messages. Framework errors and all 5xx responses use these, so client input and internals are
 * never echoed back.
 */
export const DEFAULT_MESSAGE = {
  'AUTH-003': 'Invalid or missing access token',
  'AUTH-100': 'Permission denied',
  'VAL-001': 'Invalid input',
  'VAL-005': 'Unsupported media type',
  'VAL-006': 'Payload too large',
  'RES-001': 'Resource not found',
  'RES-002': 'Resource already exists',
  'RES-003': 'Resource was modified concurrently',
  'RATE-001': 'Too many requests',
  'SYS-001': 'Internal server error',
  'SYS-002': 'Service unavailable',
  'DB-001': 'Database error',
} as const satisfies Partial<Record<ErrorCode, string>>;

/** Codes that have a generic message (usable for framework errors). */
export type GenericErrorCode = keyof typeof DEFAULT_MESSAGE;
