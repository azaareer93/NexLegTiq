import type { ArgumentsHost } from '@nestjs/common';
import {
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { DependencyUnavailableException } from './app.exception';
import { GlobalExceptionFilter } from './global-exception.filter';

function setup(options: { clsActive?: boolean; headersSent?: boolean } = {}) {
  const response = {
    headersSent: options.headersSent ?? false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  const cls = {
    isActive: () => options.clsActive ?? true,
    getId: () => 'req-123',
  } as unknown as ClsService;
  const logger = { setContext: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const filter = new GlobalExceptionFilter(cls, logger as unknown as PinoLogger);
  return { filter, host, response, logger };
}

describe('GlobalExceptionFilter', () => {
  it('should treat a ZodError thrown by server code as 500 SYS-001 without schema details', () => {
    // Client input is validated by ZodValidationPipe (VAL-001); a bare ZodError means our own data was invalid.
    const { filter, host, response } = setup();
    const result = z.object({ title: z.string() }).safeParse({});

    filter.catch(result.error, host);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'SYS-001', message: 'Internal server error' },
      meta: { timestamp: expect.any(String), requestId: 'req-123' },
    });
  });

  it.each([
    [new UnprocessableEntityException('field x is bad'), 422, 'VAL-001', 'Invalid input'],
    [
      Object.assign(new Error('request entity too large'), { expose: true, status: 413 }),
      413,
      'VAL-006',
      'Payload too large',
    ],
    [
      Object.assign(new Error('unsupported charset'), { expose: true, status: 415 }),
      415,
      'VAL-005',
      'Unsupported media type',
    ],
    [
      new InternalServerErrorException('db password in message'),
      500,
      'SYS-001',
      'Internal server error',
    ],
  ])(
    'should map framework error %# to its status, catalog code and a generic message',
    (error, status, code, message) => {
      const { filter, host, response } = setup();

      filter.catch(error, host);

      expect(response.status).toHaveBeenCalledWith(status);
      expect(response.json.mock.calls[0][0].error).toEqual({ code, message });
    },
  );

  it('should not treat non-exposed errors with a status as client errors', () => {
    const { filter, host, response } = setup();

    filter.catch(Object.assign(new Error('internal'), { status: 400 }), host);

    expect(response.status).toHaveBeenCalledWith(500);
  });

  it('should rethrow outside HTTP contexts', () => {
    const { filter } = setup();
    const wsHost = { getType: () => 'ws' } as unknown as ArgumentsHost;
    const error = new Error('ws');

    expect(() => filter.catch(error, wsHost)).toThrow(error);
  });

  it('should log client errors without their message or body', () => {
    const { filter, host, logger } = setup();
    const error = Object.assign(new SyntaxError('Unexpected token near "password":"hunter2"'), {
      expose: true,
      status: 400,
      body: '{"password":"hunter2"',
    });

    filter.catch(error, host);

    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('hunter2');
  });

  it('should keep readiness details on SYS-002', () => {
    const { filter, host, response } = setup();

    filter.catch(new DependencyUnavailableException([{ field: 'db', message: 'timeout' }]), host);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json.mock.calls[0][0].error).toEqual({
      code: 'SYS-002',
      message: 'Service unavailable',
      details: [{ field: 'db', message: 'timeout' }],
    });
  });

  it('should map Nest HttpExceptions by status', () => {
    const { filter, host, response } = setup();

    filter.catch(new NotFoundException('Cannot GET /x'), host);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json.mock.calls[0][0].error.code).toBe('RES-001');
  });

  it('should log 5xx as error and 4xx as debug', () => {
    const { filter, host, logger } = setup();

    filter.catch(new Error('boom'), host);
    filter.catch(new NotFoundException(), host);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it('should not write when headers were already sent', () => {
    const { filter, host, response } = setup({ headersSent: true });

    filter.catch(new Error('late'), host);

    expect(response.status).not.toHaveBeenCalled();
  });

  it('should use requestId "unknown" outside a CLS context', () => {
    const { filter, host, response } = setup({ clsActive: false });

    filter.catch(new Error('early'), host);

    expect(response.json.mock.calls[0][0].meta.requestId).toBe('unknown');
  });
});
