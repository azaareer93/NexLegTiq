import { JwtService } from '@nestjs/jwt';
import type { PinoLogger } from 'nestjs-pino';

import type { PlatformAuditService } from './platform-audit.service';
import { PlatformAuthService } from './platform-auth.service';
import type { PlatformSessions } from './platform-sessions';
import { newTotpSecret, totpCode, totpStep } from './totp';
import { FieldCipher } from '../../common/crypto/field-cipher';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import type { LoginAttemptRepository } from '../auth/login-attempt.repository';
import type { PasswordHasher } from '../auth/password-hasher';

const SECRET = 'unit-only-admin-secret-0123456789abcdefgh';
const config = new AppConfig(
  parseEnv(testEnv({ ADMIN_JWT_SECRET: SECRET, ADMIN_ORIGINS: 'https://admin.example.test' })),
);
const cipher = new FieldCipher(config);
const client = { ip: '203.0.113.7', userAgent: 'jest', requestId: 'req-12345678' };
const ID = '01920000-0000-7000-8000-00000000ad01';

function admin(extra: Record<string, unknown> = {}) {
  const secret = newTotpSecret();
  return {
    secret,
    row: {
      id: ID,
      email: 'admin@example.test',
      fullName: 'Admin',
      passwordHash: '$argon2id$x',
      isActive: true,
      mfaSecret: cipher.encrypt(secret, `platform_admins.mfa_secret:${ID}`),
      mfaEnrolledAt: new Date('2026-10-01T00:00:00Z'),
      mfaLastStep: null as number | null,
      createdAt: new Date(),
      ...extra,
    },
  };
}

const DEFAULTS = {
  row: admin().row as Record<string, unknown> | null,
  valid: true,
  failures: [] as Date[],
  accountFailures: 0,
  claimed: 1,
  recovery: 1,
  enrolled: 1,
  active: true,
};

function setup(overrides: Partial<typeof DEFAULTS> = {}) {
  const { row, valid, failures, accountFailures, claimed, recovery, enrolled, active } = {
    ...DEFAULTS,
    ...overrides,
  };
  const raw = {
    platformAdmin: {
      findUnique: jest.fn().mockResolvedValue(row),
      findFirst: jest.fn().mockResolvedValue(active ? row : null),
      updateMany: jest
        .fn()
        .mockResolvedValueOnce({ count: claimed })
        .mockResolvedValue({ count: enrolled }),
      update: jest.fn(),
    },
    platformRecoveryCode: {
      updateMany: jest.fn().mockResolvedValue({ count: recovery }),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  raw.$transaction.mockImplementation((work: (tx: unknown) => unknown) => work(raw));
  const prisma = { unscoped: () => raw } as unknown as PrismaService;
  const attempts = {
    recentFailures: jest.fn().mockResolvedValue(failures),
    accountFailures: jest.fn().mockResolvedValue(accountFailures),
    record: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const hasher = { verify: jest.fn().mockResolvedValue(valid) };
  const sessions = {
    start: jest
      .fn()
      .mockResolvedValue({ refreshToken: 'rt', familyId: 'fam', expiresAt: new Date() }),
    rotate: jest.fn().mockResolvedValue({
      refreshToken: 'rt2',
      familyId: 'fam',
      expiresAt: new Date(),
      adminId: ID,
    }),
    end: jest.fn().mockResolvedValue(ID),
  };
  const audit = { log: jest.fn() };
  const service = new PlatformAuthService(
    prisma,
    hasher as unknown as PasswordHasher,
    attempts as unknown as LoginAttemptRepository,
    cipher,
    sessions as unknown as PlatformSessions,
    audit as unknown as PlatformAuditService,
    new JwtService(),
    config,
    logger as unknown as PinoLogger,
  );
  return { service, raw, attempts, sessions, audit, logger };
}

const login = <T extends object = object>(extra?: T) => ({
  email: 'admin@example.test',
  password: 'pw',
  ...(extra as T),
});

describe('PlatformAuthService (D-145)', () => {
  it('should lock the account after ten failures from any address, and only enrol within a day', async () => {
    await expect(
      setup({ accountFailures: 10 }).service.login(login(), client),
    ).rejects.toMatchObject({
      code: 'AUTH-007',
    });
    await expect(
      setup({ accountFailures: 9 }).service.login(login(), client),
    ).rejects.toMatchObject({
      code: 'AUTH-008',
    });
    const stale = admin({
      mfaEnrolledAt: null,
      createdAt: new Date(Date.now() - 25 * 3_600_000),
    }).row;
    await expect(setup({ row: stale }).service.enroll(login(), client)).rejects.toMatchObject({
      code: 'RES-004',
    });
    // Confirmed between the password check and the update: the secret was never stored, so it is not shown.
    const racing = setup({ row: admin({ mfaEnrolledAt: null }).row, claimed: 0 });
    await expect(racing.service.enroll(login(), client)).rejects.toMatchObject({ code: 'RES-003' });
  });

  it('should still sign in when the success attempt cannot be recorded (logged)', async () => {
    const { secret, row } = admin();
    const ok = setup({ row });
    ok.attempts.record.mockRejectedValueOnce(new Error('db blip'));
    const code = totpCode(secret, totpStep(new Date()));
    await expect(ok.service.login(login({ code }), client)).resolves.toMatchObject({
      session: { admin: { id: ID } },
    });
    expect(ok.logger.warn).toHaveBeenCalled();
  });

  it('should refuse a locked address, wrong credentials and an inactive admin', async () => {
    const now = Date.now();
    const locked = Array.from({ length: 5 }, (_, i) => new Date(now - i * 1000));
    await expect(setup({ failures: locked }).service.login(login(), client)).rejects.toMatchObject({
      code: 'AUTH-007',
    });
    const wrong = setup({ valid: false });
    await expect(wrong.service.login(login(), client)).rejects.toMatchObject({ code: 'AUTH-001' });
    expect(wrong.attempts.record).toHaveBeenCalledWith('admin@example.test', client.ip, false);
    await expect(setup({ row: null }).service.login(login(), client)).rejects.toMatchObject({
      code: 'AUTH-001',
    });
    await expect(
      setup({ row: admin({ isActive: false }).row }).service.login(login(), client),
    ).rejects.toMatchObject({ code: 'AUTH-006' });
  });

  it('should send a not-enrolled admin to enrolment and ask an enrolled one for a code', async () => {
    await expect(
      setup({ row: admin({ mfaEnrolledAt: null }).row }).service.login(
        login({ code: '123456' }),
        client,
      ),
    ).rejects.toMatchObject({
      code: 'AUTH-008',
      details: [{ message: 'validation.mfaEnrollment' }],
    });
    const { service, attempts } = setup();
    await expect(service.login(login(), client)).rejects.toMatchObject({
      code: 'AUTH-008',
      details: undefined,
    });
    expect(attempts.record).not.toHaveBeenCalled();
  });

  it('should accept the current code once and sign in with a token of the admin audience', async () => {
    const { secret, row } = admin();
    const ok = setup({ row });
    const code = totpCode(secret, totpStep(new Date()));
    const signed = await ok.service.login(login({ code }), client);
    const claims = await new JwtService().verifyAsync(signed.session.accessToken, {
      secret: SECRET,
      audience: 'admin',
    });
    expect(claims).toMatchObject({ sub: ID, sid: 'fam' });
    expect(ok.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN' }),
      client,
      expect.anything(),
    );
    expect(ok.attempts.record).toHaveBeenCalledWith('admin@example.test', client.ip, true);
    // Lost the race for this step (another sign-in claimed it): refused.
    await expect(
      setup({ row, claimed: 0 }).service.login(login({ code }), client),
    ).rejects.toMatchObject({ code: 'AUTH-009' });
    await expect(
      setup({ row }).service.login(login({ code: '000000' }), client),
    ).rejects.toMatchObject({ code: 'AUTH-009' });
  });

  it('should take a recovery code once, in any case and with or without the dash', async () => {
    const used = setup();
    await used.service.login(login({ recoveryCode: 'abcde-fghij' }), client);
    expect(used.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN_RECOVERY_CODE' }),
      client,
      expect.anything(),
    );
    await expect(
      setup({ recovery: 0 }).service.login(login({ recoveryCode: 'ABCDEFGHIJ' }), client),
    ).rejects.toMatchObject({
      code: 'AUTH-009',
    });
  });

  it('should hand out a new secret only before enrolment, encrypted at rest', async () => {
    await expect(setup().service.enroll(login(), client)).rejects.toMatchObject({
      code: 'RES-003',
    });
    const fresh = setup({ row: admin({ mfaEnrolledAt: null, mfaSecret: null }).row });
    const enrollment = await fresh.service.enroll(login(), client);
    expect(enrollment.otpauthUri).toContain(enrollment.secret);
    const data = (
      fresh.raw.platformAdmin.updateMany.mock.calls[0]?.[0] as { data: { mfaSecret: string } }
    ).data;
    expect(data.mfaSecret).toMatch(/^v1:/);
  });

  it('should confirm enrolment with the first code and return ten recovery codes', async () => {
    const pending = admin({ mfaEnrolledAt: null });
    await expect(
      setup().service.confirmEnrollment(login({ code: '123456' }), client),
    ).rejects.toMatchObject({ code: 'RES-003' });
    await expect(
      setup({ row: admin({ mfaEnrolledAt: null, mfaSecret: null }).row }).service.confirmEnrollment(
        login({ code: '123456' }),
        client,
      ),
    ).rejects.toMatchObject({ code: 'AUTH-008' });
    await expect(
      setup({ row: pending.row }).service.confirmEnrollment(login({ code: '000000' }), client),
    ).rejects.toMatchObject({
      code: 'AUTH-009',
    });
    const code = totpCode(pending.secret, totpStep(new Date()));
    const done = await setup({ row: pending.row }).service.confirmEnrollment(
      login({ code }),
      client,
    );
    expect(done.session.recoveryCodes).toHaveLength(10);
    expect(done.session.recoveryCodes?.[0]).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
    await expect(
      setup({ row: pending.row, claimed: 0 }).service.confirmEnrollment(login({ code }), client),
    ).rejects.toMatchObject({ code: 'RES-003' });
  });

  it('should refresh an active admin, end the session of an inactive one, and sign out idempotently', async () => {
    await expect(setup().service.refresh(undefined, client)).rejects.toMatchObject({
      code: 'AUTH-005',
    });
    await expect(setup().service.refresh('rt', client)).resolves.toMatchObject({
      session: { admin: { id: ID } },
    });
    const gone = setup({ active: false });
    await expect(gone.service.refresh('rt', client)).rejects.toMatchObject({ code: 'AUTH-006' });
    expect(gone.sessions.end).toHaveBeenCalledWith('rt2', expect.any(Date));
    const out = setup();
    await out.service.logout(undefined, client);
    expect(out.sessions.end).not.toHaveBeenCalled();
    await out.service.logout('rt', client);
    expect(out.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGOUT' }),
      client,
    );
    out.sessions.end.mockResolvedValueOnce(null);
    out.audit.log.mockClear();
    await out.service.logout('rt', client);
    expect(out.audit.log).not.toHaveBeenCalled();
    await expect(setup({ active: false }).service.profile(ID)).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(setup().service.profile(ID)).resolves.toEqual({
      id: ID,
      fullName: 'Admin',
      email: 'admin@example.test',
    });
  });
});
