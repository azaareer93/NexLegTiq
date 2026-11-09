import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ClsService } from 'nestjs-cls';

import type { PortalAccounts } from './portal-accounts';
import { PortalAuthGuard, PortalRealmGuard } from './portal-guards';
import type { PortalSessions } from './portal-sessions';
import type { RequestContext } from '../../common/context/request-context';
import type { AppConfig } from '../../config/app-config';
import type { PrismaService } from '../../database/prisma.service';
import { JWT_ISSUER } from '../auth/auth.constants';

const SECRET = 'portal-secret-portal-secret-portal-secret';
const jwt = new JwtService();
const sign = (claims: object, options: object = {}) =>
  jwt.signAsync(claims, {
    secret: SECRET,
    issuer: JWT_ISSUER,
    audience: 'portal',
    expiresIn: 60,
    ...options,
  });

function setup({ live = true, active = true, offices = 1, portal = true } = {}) {
  const req: { get: (n: string) => string | undefined; clientUserId?: string; auth?: string } = {
    get: () => req.auth,
  };
  const cls = { set: jest.fn() };
  const guard = new PortalAuthGuard(
    jwt,
    {
      portal: portal ? { jwtSecret: SECRET, origin: 'http://p.test' } : null,
    } as unknown as AppConfig,
    { live: jest.fn().mockResolvedValue(live) } as unknown as PortalSessions,
    {
      offices: jest.fn().mockResolvedValue(Array.from({ length: offices })),
    } as unknown as PortalAccounts,
    {
      unscoped: () => ({
        clientUser: { findUnique: jest.fn().mockResolvedValue(active ? { isActive: true } : null) },
      }),
    } as unknown as PrismaService,
    cls as unknown as ClsService<RequestContext>,
  );
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { guard, req, cls, context };
}

describe('PortalRealmGuard (D-158)', () => {
  it('should answer 404 while the realm is off and let requests in when it is on', () => {
    const off = new PortalRealmGuard({ portal: null } as unknown as AppConfig);
    expect(() => off.canActivate()).toThrow(expect.objectContaining({ code: 'RES-001' }));
    const on = new PortalRealmGuard({ portal: { jwtSecret: 's' } } as unknown as AppConfig);
    expect(on.canActivate()).toBe(true);
  });
});

describe('PortalAuthGuard (D-158)', () => {
  it('should accept a portal token of a live session and set the PORTAL realm', async () => {
    const { guard, req, cls, context } = setup();
    req.auth = `Bearer ${await sign({ sub: 'c1', sid: 'f1' })}`;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.clientUserId).toBe('c1');
    expect(cls.set).toHaveBeenCalledWith('realm', 'PORTAL');
  });

  it('should refuse missing, foreign, wrong-audience and expired tokens', async () => {
    const { guard, req, context } = setup();
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUTH-003' });
    req.auth = `Bearer ${await sign({ sub: 'c1', sid: 'f' }, { audience: 'office' })}`;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUTH-003' });
    req.auth = `Bearer ${await sign({ sub: 'c1', sid: 'f' }, { secret: 'x'.repeat(40) })}`;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUTH-003' });
    req.auth = `Bearer ${await jwt.signAsync({ sub: 'c1', sid: 'f', exp: 1 }, { secret: SECRET, issuer: JWT_ISSUER, audience: 'portal' })}`;
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUTH-002' });
    const off = setup({ portal: false });
    off.req.auth = `Bearer ${await sign({ sub: 'c1', sid: 'f' })}`;
    await expect(off.guard.canActivate(off.context)).rejects.toMatchObject({ code: 'AUTH-003' });
  });

  it('should refuse an ended session, an inactive account and an account without access', async () => {
    const token = `Bearer ${await sign({ sub: 'c1', sid: 'f1' })}`;
    for (const [options, code] of [
      [{ live: false }, 'AUTH-004'],
      [{ active: false }, 'AUTH-006'],
      [{ offices: 0 }, 'AUTH-006'],
    ] as const) {
      const { guard, req, context } = setup(options);
      req.auth = token;
      await expect(guard.canActivate(context)).rejects.toMatchObject({ code });
    }
  });
});
