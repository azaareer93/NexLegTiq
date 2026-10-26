import type { ExecutionContext } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';

import { AdminRealmGuard, allowList } from './admin-guards';
import type { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';

const logger = { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger;
const from = (ip: string) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ ip }) }) }) as unknown as ExecutionContext;
const guard = (admin: AppConfig['admin']) =>
  new AdminRealmGuard({ admin } as unknown as AppConfig, logger);

describe('admin realm guard (D-145)', () => {
  it('should answer 404 while the realm is off (no ADMIN_JWT_SECRET)', () => {
    expect(() => guard(null).canActivate(from('127.0.0.1'))).toThrow(
      expect.objectContaining({ code: 'RES-001' }),
    );
  });

  it('should let every address in without an allow-list, and only listed ones with one', () => {
    expect(guard({ jwtSecret: 's', ipAllowlist: [] }).canActivate(from('198.51.100.9'))).toBe(true);
    const listed = guard({
      jwtSecret: 's',
      ipAllowlist: ['203.0.113.7', '10.0.0.0/8', '2001:db8::/32'],
    });
    expect(listed.canActivate(from('203.0.113.7'))).toBe(true);
    expect(listed.canActivate(from('::ffff:10.20.30.40'))).toBe(true);
    expect(listed.canActivate(from('2001:db8::1'))).toBe(true);
    expect(() => listed.canActivate(from('203.0.113.8'))).toThrow(
      expect.objectContaining({ code: 'AUTH-100' }),
    );
    expect(() => listed.canActivate(from('2001:db9::1'))).toThrow(
      expect.objectContaining({ code: 'AUTH-100' }),
    );
    expect(() => listed.canActivate(from(''))).toThrow(
      expect.objectContaining({ code: 'AUTH-100' }),
    );
  });

  it('should refuse a malformed allow-list entry and an admin secret equal to the office one at boot', () => {
    expect(allowList([])).toBeNull();
    expect(
      parseEnv(testEnv({ ADMIN_IP_ALLOWLIST: '203.0.113.7, 10.0.0.0/8 ::1' })).ADMIN_IP_ALLOWLIST,
    ).toEqual(['203.0.113.7', '10.0.0.0/8', '::1']);
    for (const bad of ['10.0.0.0/33', 'not-an-ip', '10.0.0.1/8/1', '::1/129', '10.0.0.0/x']) {
      expect(() => parseEnv(testEnv({ ADMIN_IP_ALLOWLIST: bad }))).toThrow(/ADMIN_IP_ALLOWLIST/);
    }
    const env = testEnv();
    expect(() => parseEnv({ ...env, ADMIN_JWT_SECRET: env['JWT_SECRET'] })).toThrow(
      /must differ from JWT_SECRET/,
    );
  });
});
