import type { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { ClsService } from 'nestjs-cls';

import { AdminAuthGuard } from './admin-guards';
import type { PlatformAuditService } from './platform-audit.service';
import { PlatformSessions } from './platform-sessions';
import type { RequestContext } from '../../common/context/request-context';
import type { AppConfig } from '../../config/app-config';
import type { PrismaService } from '../../database/prisma.service';

const NOW = new Date('2026-10-26T10:00:00Z');
const CLIENT = { ip: '203.0.113.7', userAgent: null, requestId: null };
const later = (ms: number) => new Date(NOW.getTime() + ms);

function sessionsWith(found: Record<string, unknown> | null, claimed = 1) {
  const table = {
    findUnique: jest.fn().mockResolvedValue(found),
    findFirst: jest.fn().mockResolvedValue(found),
    updateMany: jest.fn().mockResolvedValueOnce({ count: claimed }).mockResolvedValue({ count: 2 }),
    update: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'next' }),
  };
  const raw = { platformSession: table, $transaction: jest.fn() };
  raw.$transaction.mockImplementation((work: (tx: unknown) => unknown) => work(raw));
  const audit = { log: jest.fn() };
  return {
    sessions: new PlatformSessions(
      { unscoped: () => raw } as unknown as PrismaService,
      audit as unknown as PlatformAuditService,
    ),
    table,
    audit,
  };
}

const live = {
  id: 's1',
  adminId: 'a1',
  familyId: 'f1',
  startedAt: NOW,
  expiresAt: later(3_600_000),
  idleUntil: later(60_000),
  revokedAt: null,
};

describe('PlatformSessions (D-145)', () => {
  it('should start a session of 8 h whose idle window is 30 min', async () => {
    const { sessions, table } = sessionsWith(null);
    const issued = await sessions.start({ platformSession: table } as never, 'a1', NOW);
    expect(issued.expiresAt).toEqual(later(8 * 3_600_000));
    expect(table.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ idleUntil: later(30 * 60_000) }) }),
    );
  });

  it('should rotate a live token, and refuse unknown, reused, raced, idle and expired ones', async () => {
    await expect(sessionsWith(live).sessions.rotate('t', NOW, CLIENT)).resolves.toMatchObject({
      adminId: 'a1',
      familyId: 'f1',
    });
    await expect(sessionsWith(null).sessions.rotate('t', NOW, CLIENT)).rejects.toMatchObject({
      code: 'AUTH-005',
    });
    const reused = sessionsWith({ ...live, revokedAt: NOW });
    await expect(reused.sessions.rotate('t', NOW, CLIENT)).rejects.toMatchObject({
      code: 'AUTH-005',
    });
    // The family's end is written outside the refused transaction, so it sticks; the reuse is a SECURITY row.
    expect(reused.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: 'a1', action: 'SECURITY', entityId: 'f1' }),
      CLIENT,
    );
    expect(reused.table.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'f1', revokedAt: null },
      data: { revokedAt: NOW },
    });
    await expect(sessionsWith(live, 0).sessions.rotate('t', NOW, CLIENT)).rejects.toMatchObject({
      code: 'AUTH-005',
    });
    await expect(
      sessionsWith({ ...live, idleUntil: NOW }).sessions.rotate('t', NOW, CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH-004' });
    await expect(
      sessionsWith({ ...live, expiresAt: NOW }).sessions.rotate('t', NOW, CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH-004' });
  });

  it('should report a sign-out only when it ended something, and tell whether a family is live', async () => {
    await expect(sessionsWith(null).sessions.end('t', NOW)).resolves.toBeNull();
    await expect(sessionsWith(live).sessions.end('t', NOW)).resolves.toBe('a1');
    await expect(sessionsWith(live, 0).sessions.end('t', NOW)).resolves.toBeNull();
    await expect(sessionsWith(live).sessions.live('f1', NOW)).resolves.toBe(true);
    await expect(sessionsWith(null).sessions.live('f1', NOW)).resolves.toBe(false);
  });
});

describe('AdminAuthGuard (D-145)', () => {
  const SECRET = 'unit-only-admin-secret-0123456789abcdefgh';
  const jwt = new JwtService();
  const sign = (opts: Record<string, unknown> = {}) =>
    jwt.signAsync(
      { sub: 'a1', sid: 'f1' },
      { secret: SECRET, audience: 'admin', issuer: 'nexlegtiq', expiresIn: 60, ...opts },
    );

  function guard({ live: isLive = true, active = true, secret = SECRET as string | null } = {}) {
    const cls = { set: jest.fn() };
    const prisma = {
      unscoped: () => ({
        platformAdmin: {
          findUnique: jest.fn().mockResolvedValue(active ? { isActive: true } : null),
        },
      }),
    };
    const g = new AdminAuthGuard(
      jwt,
      {
        admin: secret ? { jwtSecret: secret, ipAllowlist: [], origins: [] } : null,
      } as unknown as AppConfig,
      { live: jest.fn().mockResolvedValue(isLive) } as unknown as PlatformSessions,
      prisma as unknown as PrismaService,
      cls as unknown as ClsService<RequestContext>,
    );
    return { g, cls };
  }
  const ctx = (authorization?: string) => {
    const req = { get: () => authorization } as Record<string, unknown>;
    return {
      req,
      context: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext,
    };
  };

  it('should admit a live, active admin and set the PLATFORM realm', async () => {
    const { g, cls } = guard();
    const { req, context } = ctx(`Bearer ${await sign()}`);
    await expect(g.canActivate(context)).resolves.toBe(true);
    expect(req['platformAdminId']).toBe('a1');
    expect(cls.set).toHaveBeenCalledWith('realm', 'PLATFORM');
  });

  it('should refuse missing, expired, foreign, ended and inactive', async () => {
    await expect(guard().g.canActivate(ctx().context)).rejects.toMatchObject({ code: 'AUTH-003' });
    await expect(
      guard({ secret: null }).g.canActivate(ctx(`Bearer ${await sign()}`).context),
    ).rejects.toMatchObject({ code: 'AUTH-003' });
    await expect(
      guard().g.canActivate(ctx(`Bearer ${await sign({ expiresIn: -10 })}`).context),
    ).rejects.toMatchObject({ code: 'AUTH-002' });
    await expect(
      guard().g.canActivate(ctx(`Bearer ${await sign({ audience: 'office' })}`).context),
    ).rejects.toMatchObject({ code: 'AUTH-003' });
    await expect(
      guard({ live: false }).g.canActivate(ctx(`Bearer ${await sign()}`).context),
    ).rejects.toMatchObject({ code: 'AUTH-004' });
    await expect(
      guard({ active: false }).g.canActivate(ctx(`Bearer ${await sign()}`).context),
    ).rejects.toMatchObject({ code: 'AUTH-006' });
  });
});
