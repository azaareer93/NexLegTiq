import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ClsService } from 'nestjs-cls';

import { CLS_MIDDLEWARE_OPTIONS } from './context.module';

function run(headers: Record<string, string>, ip?: string) {
  const store = new Map<string, unknown>();
  const cls = {
    set: (key: string, value: unknown) => store.set(key, value),
  } as unknown as ClsService;
  const req = { headers, ip } as unknown as IncomingMessage;
  const res = { headersSent: false, setHeader: jest.fn() } as unknown as ServerResponse;
  void CLS_MIDDLEWARE_OPTIONS.setup?.(cls, req, res);
  return store;
}

describe('CLS request setup (D-136, D-215)', () => {
  it('should keep the address and user agent for audit rows, and track by default', () => {
    const store = run({ 'user-agent': 'jest' }, '10.0.0.1');
    expect(store.get('ip')).toBe('10.0.0.1');
    expect(store.get('userAgent')).toBe('jest');
    expect(store.has('doNotTrack')).toBe(false);
  });

  it('should set nothing it was not given', () => {
    const store = run({});
    expect(store.has('ip')).toBe(false);
    expect(store.has('userAgent')).toBe(false);
  });

  it.each<Record<string, string>>([{ dnt: '1' }, { 'sec-gpc': '1' }])(
    'should mark %o as Do Not Track',
    (headers) => {
      expect(run(headers).get('doNotTrack')).toBe(true);
    },
  );

  it('should not treat DNT: 0 as an opt-out', () => {
    expect(run({ dnt: '0' }).has('doNotTrack')).toBe(false);
  });
});
