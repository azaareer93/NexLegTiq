import { Catch, HttpException, HttpStatus } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { ApiErrorDetail, ApiErrorResponse, ErrorCode } from '@nexlegtiq/shared-types';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import type { RequestContext } from '../context/request-context';
import { AppException } from './app.exception';
import { DEFAULT_MESSAGE, ERROR_STATUS } from './error-catalog';
import type { GenericErrorCode } from './error-catalog';
import { loggableError } from './error-log';
import { isPrismaError, mapPrismaError } from './prisma-error';

interface NormalizedError {
  readonly status: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: readonly ApiErrorDetail[];
}

/** Framework errors (unknown route, bad JSON, body too large…) mapped onto our codes; other 4xx → VAL-001. */
const HTTP_STATUS_CODE: Readonly<Partial<Record<number, GenericErrorCode>>> = {
  [HttpStatus.UNAUTHORIZED]: 'AUTH-003',
  [HttpStatus.FORBIDDEN]: 'AUTH-100',
  [HttpStatus.NOT_FOUND]: 'RES-001',
  [HttpStatus.CONFLICT]: 'RES-003',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'VAL-006',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'VAL-005',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE-001',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SYS-002',
};

/**
 * Status of a framework error: a Nest HttpException, or an `http-errors` client error raised by Express middleware
 * before routing (body-parser: payload too large, bad JSON…) which marks safe-to-show errors with `expose`.
 */
function frameworkStatusOf(exception: unknown): number | undefined {
  if (exception instanceof HttpException) return exception.getStatus();
  if (exception instanceof Error && 'expose' in exception && exception.expose === true && 'status' in exception) {
    const { status } = exception;
    if (typeof status === 'number' && status >= 400 && status < 500) return status;
  }
  return undefined;
}

/**
 * Turns every HTTP error into the error envelope (D-075). Our AppExceptions keep their code and message; framework
 * errors get the code's generic message (never echoing client input); anything else — including a ZodError thrown
 * by server code, which is not the client's fault — becomes 500 SYS-001/DB-001. Details go only to the log.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GlobalExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    // WebSocket/RPC contexts have their own error handling (MVP-94).
    if (host.getType() !== 'http') throw exception;
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
      const { status, code, message, details } = exception;
      return { status, code, message, ...(details && { details }) };
    }
    if (isPrismaError(exception)) {
      const code = mapPrismaError(exception);
      return { status: ERROR_STATUS[code], code, message: DEFAULT_MESSAGE[code] };
    }
    const status = frameworkStatusOf(exception);
    if (status !== undefined) {
      if (status >= 500) {
        const code = HTTP_STATUS_CODE[status] ?? 'SYS-001';
        return { status, code, message: code === 'SYS-002' ? DEFAULT_MESSAGE['SYS-002'] : DEFAULT_MESSAGE['SYS-001'] };
      }
      const code = HTTP_STATUS_CODE[status] ?? 'VAL-001';
      return { status, code, message: DEFAULT_MESSAGE[code] };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'SYS-001', message: DEFAULT_MESSAGE['SYS-001'] };
  }

  private log(exception: unknown, error: NormalizedError): void {
    const payload = { err: loggableError(exception, error.status), code: error.code, status: error.status };
    if (error.status >= 500) this.logger.error(payload, 'Request failed');
    else this.logger.debug(payload, 'Request rejected');
  }

  private requestId(): string {
    return this.cls.isActive() ? this.cls.getId() : 'unknown';
  }
}
