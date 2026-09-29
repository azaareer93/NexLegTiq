import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { ApiErrorDetail, ApiErrorResponse, ErrorCode } from '@nexlegtiq/shared-types';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import { ZodError } from 'zod';

import { zodIssuesToDetails } from '../http/zod-validation.pipe';
import { AppException } from './app.exception';
import { DEFAULT_MESSAGE, ERROR_STATUS } from './error-catalog';
import { isPrismaError, mapPrismaError } from './prisma-error';

interface NormalizedError {
  readonly status: HttpStatus;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
}

/** Framework HttpExceptions (unknown route, bad JSON, body too large…) mapped onto our codes. */
const HTTP_STATUS_CODE: Readonly<Partial<Record<number, ErrorCode>>> = {
  [HttpStatus.BAD_REQUEST]: 'VAL-001',
  [HttpStatus.UNAUTHORIZED]: 'AUTH-003',
  [HttpStatus.FORBIDDEN]: 'AUTH-100',
  [HttpStatus.NOT_FOUND]: 'RES-001',
  [HttpStatus.CONFLICT]: 'RES-003',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'VAL-001',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'VAL-001',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE-001',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SYS-002',
};

/**
 * Status of a framework error: a Nest HttpException, or an `http-errors` client error raised by Express middleware
 * before routing (body-parser: payload too large, bad encoding…) which marks safe-to-show errors with `expose`.
 */
function httpStatusOf(exception: unknown): { status: number; message: string } | undefined {
  if (exception instanceof HttpException) return { status: exception.getStatus(), message: exception.message };
  if (exception instanceof Error && 'expose' in exception && exception.expose === true && 'status' in exception) {
    const { status } = exception;
    if (typeof status === 'number' && status >= 400 && status < 500) return { status, message: exception.message };
  }
  return undefined;
}

/**
 * Turns every error into the error envelope. Expected errors keep their code and message; anything else becomes
 * SYS-001/DB-001 with a generic message (details only go to the log, never to the client).
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GlobalExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const error = this.normalize(exception);
    this.log(exception, error);
    if (response.headersSent) return;

    const body: ApiErrorResponse = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && error.details.length > 0 && { details: error.details }),
      },
      meta: { timestamp: new Date().toISOString(), requestId: this.requestId() },
    };
    response.status(error.status).json(body);
  }

  private normalize(exception: unknown): NormalizedError {
    if (exception instanceof AppException) {
      return this.expected(exception.code, exception.message, exception.details);
    }
    if (exception instanceof ZodError) {
      return this.expected('VAL-001', DEFAULT_MESSAGE['VAL-001'], zodIssuesToDetails(exception.issues));
    }
    if (isPrismaError(exception)) {
      const code = mapPrismaError(exception);
      return this.expected(code, DEFAULT_MESSAGE[code]);
    }
    const http = httpStatusOf(exception);
    if (http) {
      const code = HTTP_STATUS_CODE[http.status];
      if (code) return { status: http.status, code, message: http.status >= 500 ? DEFAULT_MESSAGE['SYS-001'] : http.message };
    }
    return this.expected('SYS-001', DEFAULT_MESSAGE['SYS-001']);
  }

  private expected(code: ErrorCode, message: string, details?: readonly ApiErrorDetail[]): NormalizedError {
    return { status: ERROR_STATUS[code], code, message, ...(details && { details }) };
  }

  private log(exception: unknown, error: NormalizedError): void {
    const payload = { err: exception, code: error.code, status: error.status };
    if (error.status >= 500) this.logger.error(payload, 'Request failed');
    else this.logger.debug(payload, 'Request rejected');
  }

  private requestId(): string {
    return this.cls.isActive() ? this.cls.getId() : 'unknown';
  }
}
