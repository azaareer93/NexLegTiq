import type { ArgumentsHost } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { ServiceUnavailableException } from './app.exception';
import { GlobalExceptionFilter } from './global-exception.filter';

function setup(options: { clsActive?: boolean; headersSent?: boolean } = {}) {
  const response = {
    headersSent: options.headersSent ?? false,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
  const cls = { isActive: () => options.clsActive ?? true, getId: () => 'req-123' } as unknown as ClsService;
  const logger = { setContext: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const filter = new GlobalExceptionFilter(cls, logger as unknown as PinoLogger);
  return { filter, host, response, logger };
}

describe('GlobalExceptionFilter', () => {
  it('should map a raw ZodError to VAL-001 with details', () => {
    const { filter, host, response } = setup();
    const result = z.object({ title: z.string() }).safeParse({});

    filter.catch(result.error, host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: 'VAL-001', details: [{ field: 'title', message: expect.any(String) }] }),
        meta: { timestamp: expect.any(String), requestId: 'req-123' },
      }),
    );
  });

  it('should keep readiness details on SYS-002', () => {
    const { filter, host, response } = setup();

    filter.catch(new ServiceUnavailableException([{ field: 'db', message: 'timeout' }]), host);

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
