import type { RegisterRequest } from '@nexlegtiq/shared-contracts';
import { ACCOUNT_TYPES, JURISDICTIONS, OFFICE_LANGUAGES } from '@nexlegtiq/shared-types';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { hashOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import type { PrismaService } from '../../database/prisma.service';
import { AccountType, Jurisdiction, OfficeLanguage } from '../../generated/prisma/enums';
import type { AuthService, ClientInfo, IssuedSession } from './auth.service';
import { isVerificationOverdue, verificationLinkExpiry, verifyBy } from './email-verification';
import type { PasswordHasher } from './password-hasher';
import { LEGAL_VERSIONS, SignupService, signupPlanCode } from './signup.service';
import { VerificationMailer } from './verification-mailer';

const DAY = 86_400_000;
const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';
const client: ClientInfo = { ip: '10.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };

describe('email verification window (D-083)', () => {
  const createdAt = new Date('2026-10-01T00:00:00Z');

  it('should give an unverified account 7 days, and no deadline once verified', () => {
    expect(verifyBy({ emailVerifiedAt: null, createdAt })?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(verifyBy({ emailVerifiedAt: createdAt, createdAt })).toBeNull();
    expect(verificationLinkExpiry(createdAt).toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it('should be overdue from the deadline on, never when verified', () => {
    const unverified = { emailVerifiedAt: null, createdAt };
    expect(isVerificationOverdue(unverified, new Date('2026-10-07T23:59:59Z'))).toBe(false);
    expect(isVerificationOverdue(unverified, new Date('2026-10-08T00:00:00Z'))).toBe(true);
    expect(isVerificationOverdue({ emailVerifiedAt: createdAt, createdAt }, new Date('2027-01-01'))).toBe(false);
  });
});

describe('shared office enums', () => {
  it('should match the Prisma enums', () => {
    expect([...JURISDICTIONS].sort()).toEqual(Object.values(Jurisdiction).sort());
    expect([...ACCOUNT_TYPES].sort()).toEqual(Object.values(AccountType).sort());
    expect([...OFFICE_LANGUAGES].sort()).toEqual(Object.values(OfficeLanguage).sort());
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
  const issued = { session: {}, refreshToken: 'r', refreshExpiresAt: new Date() } as IssuedSession;

  function setup(options: { existing?: boolean; trialDays?: number | null; link?: object | null; claimed?: number } = {}) {
    const tx = {
      plan: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'plan', code: 'PS_FREE', trialDays: options.trialDays === undefined ? 180 : options.trialDays }) },
      office: { create: jest.fn().mockResolvedValue({ id: OFFICE, name: 'Office', accountType: 'SOLO', jurisdiction: 'PALESTINE' }) },
      officeSettings: { create: jest.fn() },
      user: {
        create: jest.fn().mockResolvedValue({ id: USER, officeId: OFFICE, email: body.email }),
        updateMany: jest.fn(),
      },
      subscription: { create: jest.fn() },
      legalAcceptance: { createMany: jest.fn() },
      emailVerificationToken: { create: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: options.claimed ?? 1 }) },
      auditLog: { create: jest.fn() },
    };
    const raw = {
      user: { findUnique: jest.fn().mockResolvedValue(options.existing ? { id: USER } : null) },
      emailVerificationToken: { findUnique: jest.fn().mockResolvedValue(options.link === undefined ? null : options.link) },
      $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    };
    const db = { $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) };
    const prisma = { db, unscoped: () => raw } as unknown as PrismaService;
    const auth = {
      openSession: jest.fn().mockResolvedValue({ familyId: 'f', refreshToken: 'r', refreshExpiresAt: new Date() }),
      issue: jest.fn().mockResolvedValue(issued),
    };
    const mailer = new VerificationMailer({ setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger);
    const send = jest.spyOn(mailer, 'send');
    const passwords = { hash: jest.fn().mockResolvedValue('$argon2id$hash') } as unknown as PasswordHasher;
    const service = new SignupService(
      prisma,
      new TenantRunner(ClsServiceManager.getClsService<RequestContext>()),
      auth as unknown as AuthService,
      passwords,
      mailer,
    );
    return { service, tx, auth, send };
  }

  it('should create the office, manager, trial, acceptances, link and audit, then log in and hand off the email', async () => {
    const { service, tx, auth, send } = setup();
    await expect(service.register(body, client)).resolves.toBe(issued);

    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: 'OFFICE_MANAGER', uiLanguage: 'EN', passwordHash: '$argon2id$hash' }) }),
    );
    const subscription = tx.subscription.create.mock.calls[0][0].data;
    expect(subscription).toMatchObject({ officeId: OFFICE, status: 'TRIALING' });
    expect(subscription.trialEndsAt.getTime() - subscription.currentPeriodStart.getTime()).toBe(180 * DAY);
    expect(tx.legalAcceptance.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ documentType: 'TOS', version: LEGAL_VERSIONS.TOS, ipAddress: '10.0.0.1' }),
      expect.objectContaining({ documentType: 'PRIVACY', version: LEGAL_VERSIONS.PRIVACY }),
    ]);
    expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ entityType: 'Office', action: 'CREATE' }) });
    expect(auth.openSession).toHaveBeenCalledWith(tx, expect.objectContaining({ id: USER }), false, expect.any(Date), client);

    const sent = send.mock.calls[0]?.[0];
    expect(sent).toMatchObject({ userId: USER, language: 'EN' });
    const stored = tx.emailVerificationToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(hashOpaqueToken(sent?.token ?? ''));
  });

  it('should refuse an existing email with 409 RES-002 before hashing', async () => {
    const { service, tx } = setup({ existing: true });
    await expect(service.register(body, client)).rejects.toMatchObject({ code: 'RES-002' });
    expect(tx.office.create).not.toHaveBeenCalled();
  });

  it('should fail loudly when the signup plan has no trial length', async () => {
    await expect(setup({ trialDays: null }).service.register(body, client)).rejects.toThrow(/no trial length/);
  });

  describe('verifyEmail', () => {
    const link = (extra: object = {}) => ({ id: 'link', officeId: OFFICE, userId: USER, expiresAt: new Date(Date.now() + DAY), usedAt: null, ...extra });

    it('should mark the link used, verify the user and audit', async () => {
      const { service, tx } = setup({ link: link() });
      await service.verifyEmail({ token: 'x'.repeat(43) }, client);
      expect(tx.user.updateMany).toHaveBeenCalledWith({ where: { id: USER, emailVerifiedAt: null }, data: { emailVerifiedAt: expect.any(Date) } });
      expect(tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'UPDATE', newValues: { emailVerified: true } }) });
    });

    it.each([
      ['unknown', null, 1],
      ['used', link({ usedAt: new Date() }), 1],
      ['expired', link({ expiresAt: new Date(Date.now() - 1) }), 1],
      ['claimed concurrently', link(), 0],
    ])('should answer 410 RES-004 for a link that is %s', async (_label, found, claimed) => {
      const { service, tx } = setup({ link: found, claimed });
      await expect(service.verifyEmail({ token: 'x'.repeat(43) }, client)).rejects.toMatchObject({ code: 'RES-004' });
      expect(tx.user.updateMany).not.toHaveBeenCalled();
    });
  });
});
