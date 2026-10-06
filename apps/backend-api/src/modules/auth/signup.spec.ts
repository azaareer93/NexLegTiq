import type { RegisterRequest } from '@nexlegtiq/shared-contracts';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { hashOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import type { AuthService, IssuedSession } from './auth.service';
import type { ClientInfo } from './client-info';
import { isVerificationOverdue, verificationLinkExpiry, verifyBy } from './email-verification';
import type { PasswordHasher } from './password-hasher';
import { LEGAL_VERSIONS, SignupRepository } from './signup.repository';
import type { ExistingAccount, NewOfficeAccount } from './signup.repository';
import { SignupService, signupPlanCode } from './signup.service';
import { AccountMailer } from './account-mailer';

const DAY = 86_400_000;
const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';
const client: ClientInfo = { ip: '10.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const cls = ClsServiceManager.getClsService<RequestContext>();
const logger = () =>
  ({ setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }) as unknown as PinoLogger;

const body: RegisterRequest = {
  fullName: 'Omar',
  email: 'omar@example.test',
  password: 'Testtesttest1',
  officeName: 'Office',
  accountType: 'SOLO',
  jurisdiction: 'PALESTINE',
  defaultLanguage: 'EN',
  currency: 'ILS',
  acceptTerms: true,
  acceptPrivacy: true,
};

describe('email verification window (D-083)', () => {
  const createdAt = new Date('2026-10-01T00:00:00Z');

  it('should give an unverified account 7 days, and no deadline once verified', () => {
    expect(verifyBy({ emailVerifiedAt: null, createdAt })?.toISOString()).toBe(
      '2026-10-08T00:00:00.000Z',
    );
    expect(verifyBy({ emailVerifiedAt: createdAt, createdAt })).toBeNull();
    expect(verificationLinkExpiry(createdAt).toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it('should be overdue from the deadline on, never when verified', () => {
    const unverified = { emailVerifiedAt: null, createdAt };
    expect(isVerificationOverdue(unverified, new Date('2026-10-07T23:59:59Z'))).toBe(false);
    expect(isVerificationOverdue(unverified, new Date('2026-10-08T00:00:00Z'))).toBe(true);
    expect(
      isVerificationOverdue({ emailVerifiedAt: createdAt, createdAt }, new Date('2027-01-01')),
    ).toBe(false);
  });
});

describe('signupPlanCode (D-006, D-083)', () => {
  it.each([
    ['PALESTINE', 'FIRM', 'PS_FREE'],
    ['JORDAN', 'SOLO', 'GLOBAL_SOLO'],
    ['UAE', 'FIRM', 'GLOBAL_SMALL_FIRM'],
    ['UK', 'CORPORATE', 'GLOBAL_PROFESSIONAL'],
  ] as const)('should give %s / %s the %s plan', (jurisdiction, accountType, plan) => {
    expect(signupPlanCode({ jurisdiction, accountType })).toBe(plan);
  });
});

describe('SignupService', () => {
  const issued = { session: {}, refreshToken: 'r', refreshExpiresAt: new Date() } as IssuedSession;
  const user = { id: USER, officeId: OFFICE, email: body.email };
  const overdueAccount: ExistingAccount = {
    id: 'old-user',
    officeId: 'old-office',
    emailVerifiedAt: null,
    createdAt: new Date(Date.now() - 8 * DAY),
    isActive: true,
    officeActive: true,
    officeUsers: 1,
  };

  function setup(
    options: {
      existing?: ExistingAccount | null;
      enforced?: boolean;
      link?: object | null;
      used?: boolean;
    } = {},
  ) {
    const signups = {
      findAccount: jest.fn().mockResolvedValue(options.existing ?? null),
      createOfficeAccount: jest.fn().mockResolvedValue(user),
      findVerificationLink: jest.fn().mockResolvedValue(options.link ?? null),
      confirmVerification: jest.fn().mockResolvedValue(options.used ?? true),
    };
    const tx = {};
    const prisma = {
      db: { $transaction: jest.fn((work: (t: object) => unknown) => work(tx)) },
    } as unknown as PrismaService;
    const auth = {
      openSession: jest
        .fn()
        .mockResolvedValue({ familyId: 'f', refreshToken: 'r', refreshExpiresAt: new Date() }),
      issue: jest.fn().mockResolvedValue(issued),
    };
    const mailer = { sendVerification: jest.fn().mockResolvedValue(undefined) };
    const send = mailer.sendVerification;
    const passwords = {
      hash: jest.fn().mockResolvedValue('$argon2id$hash'),
    } as unknown as PasswordHasher;
    const config = new AppConfig(
      parseEnv(testEnv({ EMAIL_VERIFICATION_ENFORCED: String(options.enforced ?? true) })),
    );
    const service = new SignupService(
      prisma,
      new TenantRunner(cls),
      auth as unknown as AuthService,
      passwords,
      signups as unknown as SignupRepository,
      mailer as unknown as AccountMailer,
      config,
      logger(),
    );
    return { service, signups, auth, send, tx };
  }

  it('should create the account, log in in the new office and ask the worker for the verification email', async () => {
    const { service, signups, auth, send, tx } = setup();
    await expect(service.register(body, client)).resolves.toBe(issued);

    const input = signups.createOfficeAccount.mock.calls[0][0] as NewOfficeAccount;
    expect(input).toMatchObject({
      planCode: 'PS_FREE',
      passwordHash: '$argon2id$hash',
      uiLanguage: 'EN',
    });
    expect(input.release).toBeUndefined();
    expect(auth.openSession).toHaveBeenCalledWith(tx, user, {
      rememberMe: false,
      now: input.now,
      client,
    });
    expect(send).toHaveBeenCalledWith({ userId: USER, officeId: OFFICE }, client);
  });

  it.each([
    ['a verified account', { ...overdueAccount, emailVerifiedAt: new Date() }, true],
    [
      'an unverified account still within 7 days',
      { ...overdueAccount, createdAt: new Date() },
      true,
    ],
    ['an office with other users', { ...overdueAccount, officeUsers: 2 }, true],
    ['an overdue account while verification is not enforced', overdueAccount, false],
  ])('should refuse the email of %s with 409 RES-002', async (_label, existing, enforced) => {
    const { service, signups } = setup({ existing, enforced });
    await expect(service.register(body, client)).rejects.toMatchObject({ code: 'RES-002' });
    expect(signups.createOfficeAccount).not.toHaveBeenCalled();
  });

  it('should reclaim the email of an abandoned unverified signup (D-083)', async () => {
    const { service, signups } = setup({ existing: overdueAccount });
    await service.register(body, client);
    expect(signups.createOfficeAccount).toHaveBeenCalledWith(
      expect.objectContaining({ release: { userId: 'old-user', officeId: 'old-office' } }),
    );
  });

  describe('resendVerification', () => {
    it('should ask for a new link for an unverified, active account', async () => {
      const { service, send } = setup({ existing: { ...overdueAccount, createdAt: new Date() } });
      await service.resendVerification({ email: body.email }, client);
      expect(send).toHaveBeenCalledWith({ userId: 'old-user', officeId: 'old-office' }, client);
    });

    it.each([
      ['no account', null],
      ['a verified account', { ...overdueAccount, emailVerifiedAt: new Date() }],
      ['a deactivated user', { ...overdueAccount, isActive: false }],
      ['a suspended office', { ...overdueAccount, officeActive: false }],
    ])('should quietly send nothing for %s', async (_label, existing) => {
      const { service, send } = setup({ existing });
      await expect(
        service.resendVerification({ email: body.email }, client),
      ).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('verifyEmail', () => {
    const link = (extra: object = {}) => ({
      id: 'link',
      officeId: OFFICE,
      userId: USER,
      expiresAt: new Date(Date.now() + DAY),
      usedAt: null,
      ...extra,
    });

    it('should confirm a valid link in its office', async () => {
      const { service, signups } = setup({ link: link() });
      await service.verifyEmail({ token: 'x'.repeat(43) }, client);
      expect(signups.findVerificationLink).toHaveBeenCalledWith(hashOpaqueToken('x'.repeat(43)));
      expect(signups.confirmVerification).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'link' }),
        expect.any(Date),
        client,
      );
    });

    it.each([
      ['unknown', null, true],
      ['used', link({ usedAt: new Date() }), true],
      ['expired', link({ expiresAt: new Date(Date.now() - 1) }), true],
      ['expiring right now', link({ expiresAt: new Date(Date.now()) }), true],
      ['used concurrently', link(), false],
    ])('should answer 410 RES-004 for a link that is %s', async (_label, found, used) => {
      const { service } = setup({ link: found, used });
      await expect(service.verifyEmail({ token: 'x'.repeat(43) }, client)).rejects.toMatchObject({
        code: 'RES-004',
      });
    });
  });
});

describe('SignupRepository', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const input: NewOfficeAccount = {
    body,
    planCode: 'PS_FREE',
    passwordHash: '$argon2id$hash',
    uiLanguage: 'EN',
    now,
    client,
  };

  function setup(options: { plan?: object | null; updated?: number; claimed?: number } = {}) {
    const tx = {
      plan: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            options.plan === undefined
              ? { id: 'plan', code: 'PS_FREE', trialDays: 180 }
              : options.plan,
          ),
      },
      office: {
        create: jest.fn().mockResolvedValue({
          id: OFFICE,
          name: 'Office',
          accountType: 'SOLO',
          jurisdiction: 'PALESTINE',
        }),
        update: jest.fn(),
      },
      officeSettings: { create: jest.fn() },
      user: {
        create: jest.fn().mockResolvedValue({ id: USER, officeId: OFFICE }),
        updateMany: jest.fn().mockResolvedValue({ count: options.updated ?? 1 }),
      },
      subscription: { create: jest.fn() },
      legalAcceptance: { createMany: jest.fn() },
      emailVerificationToken: {
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: options.claimed ?? 1 }),
      },
      refreshToken: { updateMany: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const run = jest.fn((work: (t: typeof tx) => unknown) => work(tx));
    const prisma = {
      unscoped: () => ({ $transaction: run }),
      db: { $transaction: run },
    } as unknown as PrismaService;
    return { repository: new SignupRepository(prisma), tx };
  }

  it('should write the office, manager, trial, acceptances, link and audit row', async () => {
    const { repository, tx } = setup();
    await repository.createOfficeAccount(input);

    expect(tx.plan.findFirst).toHaveBeenCalledWith({ where: { code: 'PS_FREE', isActive: true } });
    expect(tx.user.create.mock.calls[0][0].data).toMatchObject({
      role: 'OFFICE_MANAGER',
      uiLanguage: 'EN',
      createdAt: now,
    });
    const subscription = tx.subscription.create.mock.calls[0][0].data;
    expect(subscription).toMatchObject({
      officeId: OFFICE,
      status: 'TRIALING',
      currentPeriodStart: now,
    });
    expect(subscription.trialEndsAt.getTime() - now.getTime()).toBe(180 * DAY);
    expect(tx.legalAcceptance.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        documentType: 'TOS',
        version: LEGAL_VERSIONS.TOS,
        ipAddress: '10.0.0.1',
      }),
      expect.objectContaining({ documentType: 'PRIVACY', version: LEGAL_VERSIONS.PRIVACY }),
    ]);
    expect(tx.emailVerificationToken.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: 'Office', action: 'CREATE' }),
    });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['missing or inactive', null],
    ['without a trial length', { id: 'plan', code: 'PS_FREE', trialDays: null }],
  ])('should fail as a server error (not 404) when the plan is %s', async (_label, plan) => {
    const { repository, tx } = setup({ plan });
    await expect(repository.createOfficeAccount(input)).rejects.toThrow(/Signup plan PS_FREE/);
    expect(tx.office.create).not.toHaveBeenCalled();
  });

  it('should release an abandoned signup in the same transaction before creating the new office', async () => {
    const { repository, tx } = setup();
    await repository.createOfficeAccount({
      ...input,
      release: { userId: 'old-user', officeId: 'old-office' },
    });

    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'old-user', email: body.email, emailVerifiedAt: null },
      data: { email: 'released+old-user@invalid.nexlegtiq', isActive: false },
    });
    expect(tx.office.update).toHaveBeenCalledWith({
      where: { id: 'old-office' },
      data: { isActive: false },
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { officeId: 'old-office', revokedAt: null },
      data: { revokedAt: now },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        officeId: 'old-office',
        action: 'SECURITY',
        newValues: { reason: 'ABANDONED_SIGNUP_RELEASED' },
      }),
    });
  });

  it('should answer 409 RES-002 when the abandoned signup was verified in the meantime', async () => {
    const { repository, tx } = setup({ updated: 0 });
    await expect(
      repository.createOfficeAccount({
        ...input,
        release: { userId: 'old-user', officeId: 'old-office' },
      }),
    ).rejects.toMatchObject({
      code: 'RES-002',
    });
    expect(tx.office.create).not.toHaveBeenCalled();
  });

  describe('confirmVerification', () => {
    const link = { id: 'link', officeId: OFFICE, userId: USER };

    it('should use the link, verify the user and audit the change', async () => {
      const { repository, tx } = setup();
      await expect(repository.confirmVerification(link, now, client)).resolves.toBe(true);
      expect(tx.user.updateMany).toHaveBeenCalledWith({
        where: { id: USER, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: 'UPDATE', newValues: { emailVerified: true } }),
      });
    });

    it('should not audit when the user was already verified', async () => {
      const { repository, tx } = setup({ updated: 0 });
      await expect(repository.confirmVerification(link, now, client)).resolves.toBe(true);
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    });

    it('should answer false when the link was used concurrently', async () => {
      const { repository, tx } = setup({ claimed: 0 });
      await expect(repository.confirmVerification(link, now, client)).resolves.toBe(false);
      expect(tx.user.updateMany).not.toHaveBeenCalled();
    });
  });
});
