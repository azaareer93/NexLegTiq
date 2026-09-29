import type { IncomingMessage, ServerResponse } from 'node:http';

import { ensureRequestId, REQUEST_ID_HEADER } from './request-context';

function fakeRequest(headerValue?: string | string[]): IncomingMessage & { id?: unknown } {
  const headers = headerValue === undefined ? {} : { [REQUEST_ID_HEADER]: headerValue };
  return { headers } as unknown as IncomingMessage;
}

function fakeResponse(): ServerResponse & { captured: Record<string, string> } {
  const captured: Record<string, string> = {};
  return {
    captured,
    headersSent: false,
    setHeader: (name: string, value: string) => {
      captured[name] = value;
    },
  } as unknown as ServerResponse & { captured: Record<string, string> };
}

describe('ensureRequestId', () => {
  it('should reuse a safe incoming x-request-id and echo it', () => {
    const req = fakeRequest('abc-123_XYZ.789');
    const res = fakeResponse();

    expect(ensureRequestId(req, res)).toBe('abc-123_XYZ.789');
    expect(res.captured[REQUEST_ID_HEADER]).toBe('abc-123_XYZ.789');
  });

  it('should generate a UUID when the header is missing', () => {
    expect(ensureRequestId(fakeRequest())).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(['short', 'has spaces in it', '<script>alert(1)</script>', 'x'.repeat(129)])(
    'should replace an unsafe incoming id when it is %s',
    (unsafe) => {
      expect(ensureRequestId(fakeRequest(unsafe))).not.toBe(unsafe);
    },
  );

  it('should use the first value when the header repeats', () => {
    expect(ensureRequestId(fakeRequest(['first-value-1', 'second-value-2']))).toBe('first-value-1');
  });

  it('should return the same id when called twice for one request', () => {
    const req = fakeRequest();

    expect(ensureRequestId(req)).toBe(ensureRequestId(req));
  });

  it('should still echo the header when the id was created earlier without a response', () => {
    // Arrange: CLS middleware ran first (no response object)
    const req = fakeRequest();
    const id = ensureRequestId(req);
    const res = fakeResponse();

    // Act: pino-http runs second
    ensureRequestId(req, res);

    // Assert
    expect(res.captured[REQUEST_ID_HEADER]).toBe(id);
  });
});
