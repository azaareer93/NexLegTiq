import { ClsServiceManager } from 'nestjs-cls';

import type { AccountMailer } from './account-mailer';
import type { ClientInfo } from './client-info';
import { mayIssueLink } from './link-limits';
import type { PasswordHasher } from './password-hasher';
import { PasswordResetLinks } from './password-reset-links';
import type { PasswordRepository } from './password.repository';
import { PasswordService } from './password.service';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';
const cls = ClsServiceManager.getClsService<RequestContext>();
const runner = new TenantRunner(cls);
const client: ClientInfo = { ip: '10.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const now = new Date('2026-10-03T10:00:00Z');

describe('mayIssueLink', () => {
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('should allow one link a minute, retries exempt, and five a day', () => {
    expect(mayIssueLink([], now, false)).toBe(true);
    expect(mayIssueLink([ago(30_000)], now, false)).toBe(false);
    expect(mayIssueLink([ago(30_000)], now, true)).toBe(true);
    expect(mayIssueLink([ago(60_000)], now, false)).toBe(true);
    const five = [1, 2, 3, 4, 5].map((hour) => ago(hour * 3_600_000));
    expect(mayIssueLink(five, now, true)).toBe(false);
  });
});

describe('PasswordResetLinks (worker side, D-086)', () => {
  function setup(
    user: object | null = { email: 'a@b.test', fullName: 'Omar', uiLanguage: 'AR', isActive: true },
    recent: Date[] = [],
  ) {
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue(user) },
      passwordResetToken: {
        findMany: jest.fn().mockResolvedValue(recent.map((createdAt) => ({ createdAt }))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      db: { $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) },
    } as unknown as PrismaService;
    const config = new AppConfig(
      parseEnv(testEnv({ NODE_ENV: 'development', OFFICE_APP_URL: 'https://app.test' })),
    );
    return { links: new PasswordResetLinks(prisma, cls, config), tx };
  }
  const issue = (links: PasswordResetLinks, retry = false) =>
    runner.run({ officeId: OFFICE as never }, () => links.issue(USER, now, { retry }));

  it('should end earlier reset links, store only the hash of a one-hour link and return the email', async () => {
    const { links, tx } = setup();
    const email = await issue(links);
    const token = new URL(email?.vars.link ?? 'http://x').searchParams.get('token') ?? '';
    expect(email).toMatchObject({
      to: 'a@b.test',
      locale: 'AR',
      vars: { name: 'Omar', minutes: 60 },
    });
    expect(email?.vars.link.startsWith('https://app.test/reset-password?token=')).toBe(true);
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, usedAt: null },
      data: { usedAt: now },
    });
    expect(tx.passwordResetToken.create).toHaveBeenCalledWith({
      data: {
        officeId: OFFICE,
        userId: USER,
        tokenHash: hashOpaqueToken(token),
        expiresAt: new Date('2026-10-03T11:00:00Z'),
      },
    });
  });

  it.each([
    ['an unknown user', null, []],
    [
      'a deactivated user',
      { email: 'a@b.test', fullName: 'O', uiLanguage: 'EN', isActive: false },
      [],
    ],
    ['a link issued 10 s ago', undefined, [new Date(now.getTime() - 10_000)]],
  ])('should issue nothing for %s', async (_label, user, recent) => {
    const { links, tx } = setup(user === undefined ? undefined : user, recent);
    await expect(issue(links)).resolves.toBeNull();
    expect(tx.passwordResetToken.create).not.toHaveBeenCalled();
  });

  it('should refuse to run outside an office', async () => {
    await expect(setup().links.issue(USER, now)).rejects.toBeInstanceOf(TenantContextMissingError);
  });
});

describe('PasswordService', () => {
  const link = (extra: object = {}) => ({
    id: 'link',
    officeId: OFFICE,
    userId: USER,
    expiresAt: new Date(Date.now() + 3_600_000),
    usedAt: null,
    user: { email: 'omar@example.test', isActive: true, office: { isActive: true } },
    ...extra,
  });

  function setup(
    options: {
      account?: object | null;
      link?: object | null;
      used?: boolean;
      credentials?: object | null;
      valid?: boolean;
    } = {},
  ) {
    const accounts = {
      findAccount: jest
        .fn()
        .mockResolvedValue(options.account === undefined ? null : options.account),
      findResetLink: jest
        .fn()
        .mockResolvedValue(options.link === undefined ? link() : options.link),
      resetPassword: jest.fn().mockResolvedValue(options.used ?? true),
      findCredentials: jest
        .fn()
        .mockResolvedValue(
          options.credentials === undefined
            ? { passwordHash: '$argon2id$h', email: 'omar@example.test' }
            : options.credentials,
        ),
      changePassword: jest.fn().mockResolvedValue(undefined),
    };
    const passwords = {
      hash: jest.fn().mockResolvedValue('$argon2id$new'),
      verify: jest.fn().mockResolvedValue(options.valid ?? true),
    };
    const mailer = { sendPasswordReset: jest.fn().mockResolvedValue(undefined) };
    const service = new PasswordService(
      passwords as unknown as PasswordHasher,
      accounts as unknown as PasswordRepository,
      runner,
      mailer as unknown as AccountMailer,
    );
    return { service, accounts, passwords, mailer };
  }

  describe('forgotPassword', () => {
    it('should ask the worker for a reset email for an active account', async () => {
      const { service, mailer } = setup({
        account: { id: USER, officeId: OFFICE, isActive: true, office: { isActive: true } },
      });
      await service.forgotPassword({ email: 'omar@example.test' }, client);
      expect(mailer.sendPasswordReset).toHaveBeenCalledWith(
        { userId: USER, officeId: OFFICE },
        client,
      );
    });

    it('should answer without waiting for the enqueue, so a known email is not slower than an unknown one', async () => {
      const { service, mailer } = setup({
        account: { id: USER, officeId: OFFICE, isActive: true, office: { isActive: true } },
      });
      mailer.sendPasswordReset.mockReturnValue(new Promise(() => undefined));
      await expect(
        service.forgotPassword({ email: 'omar@example.test' }, client),
      ).resolves.toBeUndefined();
      expect(mailer.sendPasswordReset).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['no account', null],
      [
        'a deactivated user',
        { id: USER, officeId: OFFICE, isActive: false, office: { isActive: true } },
      ],
      [
        'a suspended office',
        { id: USER, officeId: OFFICE, isActive: true, office: { isActive: false } },
      ],
    ])('should quietly send nothing for %s', async (_label, account) => {
      const { service, mailer } = setup({ account });
      await expect(
        service.forgotPassword({ email: 'x@example.test' }, client),
      ).resolves.toBeUndefined();
      expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    const body = {
      token: 'A'.repeat(43),
      newPassword: 'New-Pass-2026x',
      confirmPassword: 'New-Pass-2026x',
    };

    it('should hash the new password and reset it in the link office', async () => {
      const { service, accounts, passwords } = setup();
      await service.resetPassword(body, client);
      expect(accounts.findResetLink).toHaveBeenCalledWith(hashOpaqueToken(body.token));
      expect(passwords.hash).toHaveBeenCalledWith('New-Pass-2026x');
      expect(accounts.resetPassword).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'link' }),
        '$argon2id$new',
        expect.any(Date),
        client,
      );
    });

    it.each([
      ['unknown', null, true],
      ['used', link({ usedAt: new Date() }), true],
      ['expired', link({ expiresAt: new Date(Date.now() - 1) }), true],
      [
        'for a deactivated user',
        link({ user: { email: 'omar@example.test', isActive: false, office: { isActive: true } } }),
        true,
      ],
      [
        'for a suspended office',
        link({ user: { email: 'omar@example.test', isActive: true, office: { isActive: false } } }),
        true,
      ],
      ['used concurrently', link(), false],
    ])('should answer 410 RES-004 for a link that is %s', async (_label, found, used) => {
      const { service } = setup({ link: found, used });
      await expect(service.resetPassword(body, client)).rejects.toMatchObject({ code: 'RES-004' });
    });

    it('should refuse the email as the new password', async () => {
      const { service, accounts } = setup({
        link: link({
          user: { email: 'omar12345A@example.test', isActive: true, office: { isActive: true } },
        }),
      });
      const sameAsEmail = { ...body, newPassword: 'Omar12345A', confirmPassword: 'Omar12345A' };
      await expect(service.resetPassword(sameAsEmail, client)).rejects.toMatchObject({
        code: 'VAL-001',
        details: [{ field: 'newPassword', message: 'validation.password.sameAsEmail' }],
      });
      expect(accounts.resetPassword).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    const principal = {
      userId: USER as never,
      officeId: OFFICE as never,
      role: 'LAWYER' as const,
      realm: 'OFFICE' as const,
      sessionId: 'family-1',
    };
    const body = { currentPassword: 'Old-Pass-2026x', newPassword: 'New-Pass-2026x' };

    it('should verify the current password and keep this session', async () => {
      const { service, accounts, passwords } = setup();
      await service.changePassword(principal, body, client);
      expect(passwords.verify).toHaveBeenCalledWith('$argon2id$h', 'Old-Pass-2026x');
      expect(accounts.changePassword).toHaveBeenCalledWith(
        principal,
        '$argon2id$new',
        expect.any(Date),
        client,
      );
    });

    it('should answer 400 VAL-001 on currentPassword when it is wrong', async () => {
      const { service, accounts } = setup({ valid: false });
      await expect(service.changePassword(principal, body, client)).rejects.toMatchObject({
        code: 'VAL-001',
        details: [{ field: 'currentPassword', message: 'validation.password.currentWrong' }],
      });
      expect(accounts.changePassword).not.toHaveBeenCalled();
    });

    it('should refuse the email as the new password', async () => {
      const { service } = setup({
        credentials: { passwordHash: '$argon2id$h', email: 'Omar12345A@example.test' },
      });
      await expect(
        service.changePassword(principal, { ...body, newPassword: 'Omar12345A' }, client),
      ).rejects.toMatchObject({ code: 'VAL-001' });
    });
  });
});
