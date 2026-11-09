import { JwtService } from '@nestjs/jwt';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import type { PortalAccounts } from './portal-accounts';
import { PortalAuthService } from './portal-auth.service';
import type { PortalSessions } from './portal-sessions';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import type { QueueProducer } from '../../common/queue/queue-producer';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import type { AppConfig } from '../../config/app-config';
import type { PrismaService } from '../../database/prisma.service';
import type { LoginAttemptRepository } from '../auth/login-attempt.repository';
import type { PasswordHasher } from '../auth/password-hasher';

const CLIENT = { ip: '203.0.113.7', userAgent: null, requestId: 'req-12345678' };
const user = { id: 'u1', email: 'l@x.test', fullName: 'Layla', passwordHash: 'h', isActive: true };
const office = {
  officeId: '01920000-0000-7000-8000-00000000000a',
  officeName: 'O',
  clientId: 'c1',
  clientName: 'L',
};
const issued = { refreshToken: 'rt', familyId: 'f1', expiresAt: new Date('2026-11-16T00:00:00Z') };

function setup({
  found = user as object | null,
  valid = true,
  offices = [office] as object[],
  failures = [] as Date[],
  portal = true,
} = {}) {
  const tx = {
    clientUser: { update: jest.fn() },
    clientPasswordResetToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const raw = {
    clientUser: {
      findUnique: jest.fn().mockResolvedValue(found),
      findFirst: jest.fn().mockResolvedValue(found),
      update: jest.fn(),
    },
    clientPasswordResetToken: { findUnique: jest.fn() },
    $transaction: jest.fn((work: (t: unknown) => unknown) => work(tx)),
  };
  const sessions = {
    start: jest.fn().mockResolvedValue(issued),
    rotate: jest.fn().mockResolvedValue({ ...issued, clientUserId: 'u1' }),
    end: jest.fn().mockResolvedValue('u1'),
    endAll: jest.fn(),
  };
  const accounts = { offices: jest.fn().mockResolvedValue(offices), audit: jest.fn() };
  const attempts = {
    recentFailures: jest.fn().mockResolvedValue(failures),
    record: jest.fn().mockResolvedValue(undefined),
  };
  const hasher = {
    verify: jest.fn().mockResolvedValue(valid),
    hash: jest.fn().mockResolvedValue('new-hash'),
  };
  const queues = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new PortalAuthService(
    { unscoped: () => raw } as unknown as PrismaService,
    hasher as unknown as PasswordHasher,
    attempts as unknown as LoginAttemptRepository,
    sessions as unknown as PortalSessions,
    accounts as unknown as PortalAccounts,
    new TenantRunner(ClsServiceManager.getClsService()),
    queues as unknown as QueueProducer,
    new JwtService(),
    { portal: portal ? { jwtSecret: 'p'.repeat(40), origin: 'x' } : null } as unknown as AppConfig,
    logger as unknown as PinoLogger,
  );
  return { service, raw, tx, sessions, accounts, attempts, hasher, queues, logger };
}

const lockedFailures = Array.from({ length: 5 }, (_, i) => new Date(Date.now() - i * 1000));

describe('PortalAuthService (D-157)', () => {
  it('should sign in with a signed portal token, record the success and audit the LOGIN', async () => {
    const { service, attempts, accounts, tx } = setup();
    const result = await service.login({ email: 'l@x.test', password: 'pw' }, CLIENT);
    expect(result.session.user).toMatchObject({ id: 'u1', offices: [office] });
    expect(result.session.accessToken.split('.')).toHaveLength(3);
    expect(attempts.record).toHaveBeenCalledWith('portal:l@x.test', CLIENT.ip, true);
    expect(accounts.audit).toHaveBeenCalledWith(tx, 'u1', 'LOGIN', CLIENT);
  });

  it('should not fail a sign-in when recording the success fails', async () => {
    const { service, attempts, logger } = setup();
    attempts.record.mockRejectedValueOnce(new Error('db'));
    await expect(
      service.login({ email: 'l@x.test', password: 'pw' }, CLIENT),
    ).resolves.toBeDefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should refuse a locked pair, unknown or wrong credentials, and inactive or access-less accounts', async () => {
    const body = { email: 'l@x.test', password: 'pw' };
    await expect(
      setup({ failures: lockedFailures }).service.login(body, CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH-007' });
    await expect(
      setup({ found: null, valid: false }).service.login(body, CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH-001' });
    const wrong = setup({ valid: false });
    await expect(wrong.service.login(body, CLIENT)).rejects.toMatchObject({ code: 'AUTH-001' });
    expect(wrong.attempts.record).toHaveBeenCalledWith('portal:l@x.test', CLIENT.ip, false);
    await expect(
      setup({ found: { ...user, isActive: false } }).service.login(body, CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH-006' });
    await expect(setup({ offices: [] }).service.login(body, CLIENT)).rejects.toMatchObject({
      code: 'AUTH-006',
    });
  });

  it('should refuse a portal realm that is off when signing a token', async () => {
    await expect(
      setup({ portal: false }).service.login({ email: 'l@x.test', password: 'pw' }, CLIENT),
    ).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should rotate on refresh and end the session when the account lost its access', async () => {
    await expect(setup().service.refresh(undefined)).rejects.toMatchObject({ code: 'AUTH-005' });
    const ok = await setup().service.refresh('rt');
    expect(ok.session.user.id).toBe('u1');
    for (const options of [{ found: null }, { offices: [] }]) {
      const lost = setup(options);
      await expect(lost.service.refresh('rt')).rejects.toMatchObject({ code: 'AUTH-006' });
      expect(lost.sessions.end).toHaveBeenCalledWith('rt', expect.any(Date));
    }
  });

  it('should log out idempotently and audit only a logout that ended something', async () => {
    const { service, sessions, accounts } = setup();
    await service.logout(undefined, CLIENT);
    expect(sessions.end).not.toHaveBeenCalled();
    await service.logout('rt', CLIENT);
    expect(accounts.audit).toHaveBeenCalledWith(expect.anything(), 'u1', 'LOGOUT', CLIENT);
    sessions.end.mockResolvedValueOnce(null);
    accounts.audit.mockClear();
    await service.logout('rt', CLIENT);
    expect(accounts.audit).not.toHaveBeenCalled();
  });

  it('should return the profile with its offices, and 404 for an unknown account', async () => {
    await expect(setup().service.profile('u1')).resolves.toMatchObject({
      email: 'l@x.test',
      offices: [office],
    });
    await expect(setup({ found: null }).service.profile('u1')).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should queue a reset email in an office of an active account and say nothing otherwise', async () => {
    const queued = setup();
    await queued.service.forgotPassword({ email: 'l@x.test' }, CLIENT);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queued.queues.enqueue).toHaveBeenCalledWith('email', 'send-client-password-reset', {
      clientUserId: 'u1',
    });
    for (const options of [
      { found: null },
      { found: { ...user, isActive: false } },
      { offices: [] },
    ]) {
      const quiet = setup(options);
      await quiet.service.forgotPassword({ email: 'l@x.test' }, { ...CLIENT, requestId: null });
      expect(quiet.queues.enqueue).not.toHaveBeenCalled();
    }
    const broken = setup();
    broken.queues.enqueue.mockRejectedValueOnce(new Error('redis'));
    await broken.service.forgotPassword({ email: 'l@x.test' }, CLIENT);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(broken.logger.error).toHaveBeenCalled();
  });

  describe('resetPassword', () => {
    const token = 't'.repeat(20);
    const body = { token, newPassword: 'New-Password-1', confirmPassword: 'New-Password-1' };
    const link = (extra: object = {}) => ({
      id: 'l1',
      clientUserId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      clientUser: { email: 'l@x.test', isActive: true },
      ...extra,
    });

    it('should set the password, end every link and session, and audit it', async () => {
      const { service, raw, tx, sessions, accounts, hasher } = setup();
      raw.clientPasswordResetToken.findUnique.mockResolvedValue(link());
      await service.resetPassword(body, CLIENT);
      expect(raw.clientPasswordResetToken.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashOpaqueToken(token) } }),
      );
      expect(hasher.hash).toHaveBeenCalledWith('New-Password-1');
      expect(tx.clientUser.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ passwordHash: 'new-hash' }) }),
      );
      expect(sessions.endAll).toHaveBeenCalledWith('u1', expect.any(Date), tx);
      expect(accounts.audit).toHaveBeenCalledWith(tx, 'u1', 'UPDATE', CLIENT, {
        passwordReset: true,
      });
    });

    it('should refuse unknown, used, expired and deactivated links, and the email as password', async () => {
      for (const found of [
        null,
        link({ usedAt: new Date() }),
        link({ expiresAt: new Date(0) }),
        link({ clientUser: { email: 'l@x.test', isActive: false } }),
      ]) {
        const { service, raw } = setup();
        raw.clientPasswordResetToken.findUnique.mockResolvedValue(found);
        await expect(service.resetPassword(body, CLIENT)).rejects.toMatchObject({
          code: 'RES-004',
        });
      }
      const email = setup();
      email.raw.clientPasswordResetToken.findUnique.mockResolvedValue(link());
      await expect(
        email.service.resetPassword(
          { ...body, newPassword: 'l@x.test', confirmPassword: 'l@x.test' },
          CLIENT,
        ),
      ).rejects.toMatchObject({ code: 'VAL-001' });
    });

    it('should refuse a link another request claimed first', async () => {
      const { service, raw, tx } = setup();
      raw.clientPasswordResetToken.findUnique.mockResolvedValue(link());
      tx.clientPasswordResetToken.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.resetPassword(body, CLIENT)).rejects.toMatchObject({ code: 'RES-004' });
    });
  });
});
