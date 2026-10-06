import { AxiosError, AxiosHeaders } from 'axios';
import type { AxiosResponse } from 'axios';

import { ApiError, toApiError } from './api-error.js';

describe('ApiError request id and wait (D-076, D-093)', () => {
  it.each([
    ['req-12345678', 'req-12345678'],
    ['0192f0aa-77c1-7c3e-9a51-2b3c4d5e6f70', '0192f0aa-77c1-7c3e-9a51-2b3c4d5e6f70'],
    ['short', undefined],
    ['call +1 555 0100 ‮now', undefined],
    ['x'.repeat(129), undefined],
  ])('should keep %j as the request id only when well-formed', (id, expected) => {
    expect(new ApiError('SYS-001', 'm', 500, [], id).requestId).toBe(expected);
  });
});

describe('toApiError Retry-After', () => {
  const rateLimited = (retryAfter: string) =>
    toApiError(
      new AxiosError('429', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 429,
        data: { success: false, error: { code: 'RATE-001', message: 'dev' } },
        headers: { 'retry-after': retryAfter },
        config: { headers: new AxiosHeaders() },
        statusText: '',
      } as AxiosResponse),
    ) as ApiError;

  it('should cap the wait at a day', () => {
    expect(rateLimited('42').retryAfter).toBe(42);
    expect(rateLimited('999999999').retryAfter).toBe(86_400);
  });
});
