import { StreamableFile } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ClsService } from 'nestjs-cls';
import { lastValueFrom, of } from 'rxjs';

import { EnvelopeInterceptor, RawResponse } from './envelope.interceptor';

class Handlers {
  plain(): void {
    return undefined;
  }

  @RawResponse()
  raw(): void {
    return undefined;
  }
}

function contextFor(handler: keyof Handlers, type: 'http' | 'rpc' = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => Handlers.prototype[handler],
    getClass: () => Handlers,
  } as unknown as ExecutionContext;
}

describe('EnvelopeInterceptor', () => {
  const cls = { isActive: () => true, getId: () => 'req-1' } as unknown as ClsService;
  const interceptor = new EnvelopeInterceptor(cls, new Reflector());
  const run = (context: ExecutionContext, value: unknown): Promise<unknown> =>
    lastValueFrom(interceptor.intercept(context, { handle: () => of(value) } as CallHandler));

  it('should wrap plain values', async () => {
    await expect(run(contextFor('plain'), { a: 1 })).resolves.toEqual({
      success: true,
      data: { a: 1 },
      meta: { timestamp: expect.any(String), requestId: 'req-1' },
    });
  });

  it('should leave @RawResponse handlers untouched', async () => {
    await expect(run(contextFor('raw'), { exact: true })).resolves.toEqual({ exact: true });
  });

  it('should leave StreamableFile untouched', async () => {
    const file = new StreamableFile(Buffer.from('pdf'));

    await expect(run(contextFor('plain'), file)).resolves.toBe(file);
  });

  it('should ignore non-HTTP contexts', async () => {
    await expect(run(contextFor('plain', 'rpc'), 'job-result')).resolves.toBe('job-result');
  });
});
