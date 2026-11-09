import { ClsServiceManager } from 'nestjs-cls';

import type { PortalAccounts } from './portal-accounts';
import type { PortalAuthService } from './portal-auth.service';
import { PortalInvitationAcceptService } from './portal-invitation-accept.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import type { PrismaService } from '../../database/prisma.service';
import type { LoginAttemptRepository } from '../auth/login-attempt.repository';
import type { PasswordHasher } from '../auth/password-hasher';
import type { EntitlementsService } from '../subscriptions/entitlements.service';

const CLIENT = { ip: '203.0.113.7', userAgent: 'jest', requestId: null };
const future = () => new Date(Date.now() + 86_400_000);
const invitation = (extra: object = {}) => ({
  id: 'i1',
  officeId: '01920000-0000-7000-8000-00000000000a',
  clientId: 'c1',
  contactPersonId: null,
  invitedById: 'm1',
  email: 'l@x.test',
  status: 'PENDING',
  expiresAt: future(),
  office: { name: 'Office', isActive: true },
  client: { displayName: 'Layla', isActive: true, deletedAt: null },
  ...extra,
});
const account = { id: 'u1', email: 'l@x.test', passwordHash: 'h', isActive: true };
const body = {
  token: 't'.repeat(20),
  fullName: 'Layla Portal',
  password: 'Correct-Horse-42',
  acceptTerms: true as const,
  acceptPrivacy: true as const,
};

function setup({
  found = invitation() as object | null,
  existing = null as object | null,
  readOnly = false,
  claimed = 1,
  valid = true,
  failures = [] as Date[],
  txError = undefined as unknown,
} = {}) {
  const tx = {
    clientInvitation: { updateMany: jest.fn().mockResolvedValue({ count: claimed }) },
    clientUser: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'new', email: 'l@x.test', fullName: 'Layla Portal' }),
    },
    clientPortalAccess: { create: jest.fn().mockResolvedValue({ id: 'a1' }) },
    auditLog: { create: jest.fn() },
  };
  const raw = {
    clientInvitation: { findUnique: jest.fn().mockResolvedValue(found) },
    clientUser: { findUnique: jest.fn().mockResolvedValue(existing) },
    $transaction: jest.fn(async (work: (t: unknown) => unknown) => {
      if (txError) throw txError;
      return work(tx);
    }),
  };
  const auth = {
    openSession: jest
      .fn()
      .mockResolvedValue({ refreshToken: 'rt', familyId: 'f', expiresAt: new Date() }),
    signedIn: jest.fn().mockResolvedValue({ session: { ok: true }, issued: {} }),
  };
  const hasher = {
    hash: jest.fn().mockResolvedValue('hashed'),
    verify: jest.fn().mockResolvedValue(valid),
  };
  const attempts = { recentFailures: jest.fn().mockResolvedValue(failures), record: jest.fn() };
  const service = new PortalInvitationAcceptService(
    { unscoped: () => raw } as unknown as PrismaService,
    hasher as unknown as PasswordHasher,
    attempts as unknown as LoginAttemptRepository,
    auth as unknown as PortalAuthService,
    { offices: jest.fn().mockResolvedValue([]) } as unknown as PortalAccounts,
    new TenantRunner(ClsServiceManager.getClsService()),
    { current: jest.fn().mockResolvedValue({ readOnly }) } as unknown as EntitlementsService,
  );
  return { service, tx, hasher, attempts, auth };
}

const locked = Array.from({ length: 5 }, (_, i) => new Date(Date.now() - i * 1000));

describe('PortalInvitationAcceptService (D-157)', () => {
  it('should preview an invitation and tell whether the address already has an account', async () => {
    await expect(setup().service.preview(body.token)).resolves.toMatchObject({
      officeName: 'Office',
      clientName: 'Layla',
      accountExists: false,
    });
    await expect(setup({ existing: account }).service.preview(body.token)).resolves.toMatchObject({
      accountExists: true,
    });
  });

  it('should refuse unknown, used, expired and deleted-client links, a suspended office and a read-only one', async () => {
    for (const found of [
      null,
      invitation({ status: 'ACCEPTED' }),
      invitation({ expiresAt: new Date(0) }),
      invitation({ client: { displayName: 'x', isActive: false, deletedAt: null } }),
      invitation({ client: { displayName: 'x', isActive: true, deletedAt: new Date() } }),
    ]) {
      await expect(setup({ found }).service.preview(body.token)).rejects.toMatchObject({
        code: 'RES-004',
      });
    }
    await expect(
      setup({ found: invitation({ office: { name: 'O', isActive: false } }) }).service.preview(
        body.token,
      ),
    ).rejects.toMatchObject({ code: 'AUTH-006' });
    await expect(setup({ readOnly: true }).service.accept(body, CLIENT)).rejects.toMatchObject({
      code: 'AUTH-104',
    });
  });

  it('should create the account, grant access, audit it and sign in for a new address', async () => {
    const { service, tx, hasher, auth } = setup();
    await service.accept(body, { ...CLIENT, requestId: 'req-12345678' });
    expect(hasher.hash).toHaveBeenCalledWith(body.password);
    expect(tx.clientUser.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'l@x.test', passwordHash: 'hashed' }),
      }),
    );
    expect(tx.clientPortalAccess.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientId: 'c1', grantedById: 'm1' }),
      }),
    );
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(auth.signedIn).toHaveBeenCalled();
  });

  it('should refuse the email as the password of a new account', async () => {
    await expect(
      setup().service.accept({ ...body, password: 'l@x.test' }, CLIENT),
    ).rejects.toMatchObject({ code: 'VAL-001' });
  });

  it('should add the office to an existing account that gives its password', async () => {
    const { service, tx, hasher } = setup({ existing: account });
    await service.accept(body, CLIENT);
    expect(hasher.hash).not.toHaveBeenCalled();
    expect(tx.clientUser.create).not.toHaveBeenCalled();
    expect(tx.clientPortalAccess.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ clientUserId: 'u1' }) }),
    );
  });

  it('should refuse an existing account with a wrong password, when locked or inactive', async () => {
    const wrong = setup({ existing: account, valid: false });
    await expect(wrong.service.accept(body, CLIENT)).rejects.toMatchObject({ code: 'AUTH-001' });
    expect(wrong.attempts.record).toHaveBeenCalledWith('portal:l@x.test', CLIENT.ip, false);
    await expect(
      setup({ existing: account, failures: locked }).service.accept(body, CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH-007' });
    await expect(
      setup({ existing: { ...account, isActive: false } }).service.accept(body, CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH-006' });
  });

  it('should refuse a link claimed meanwhile and turn a unique violation into a conflict', async () => {
    await expect(setup({ claimed: 0 }).service.accept(body, CLIENT)).rejects.toMatchObject({
      code: 'RES-004',
    });
    await expect(
      setup({ txError: Object.assign(new Error('unique'), { code: 'P2002' }) }).service.accept(
        body,
        CLIENT,
      ),
    ).rejects.toMatchObject({ code: 'RES-002' });
    await expect(
      setup({ txError: new Error('db down') }).service.accept(body, CLIENT),
    ).rejects.toThrow('db down');
  });
});
