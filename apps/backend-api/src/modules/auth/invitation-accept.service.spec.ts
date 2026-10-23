import { ClsServiceManager } from 'nestjs-cls';

import type { AuthService } from './auth.service';
import { InvitationAcceptService } from './invitation-accept.service';
import type { PasswordHasher } from './password-hasher';
import type { RequestContext } from '../../common/context/request-context';
import type { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { EntitlementsService } from '../subscriptions/entitlements.service';

const client = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const TOKEN = 't'.repeat(43);
const body = {
  token: TOKEN,
  fullName: 'Nadia New',
  password: 'Testtesttest1',
  acceptTerms: true as const,
  acceptPrivacy: true as const,
};

const invitation = (extra: object = {}) => ({
  id: 'inv-1',
  officeId: '01920000-0000-7000-8000-00000000000a',
  email: 'nadia@example.test',
  role: 'LAWYER',
  fullName: 'Nadia',
  status: 'PENDING',
  expiresAt: new Date(Date.now() + 86_400_000),
  office: { name: 'Adel & Partners', defaultLanguage: 'EN', isActive: true },
  invitedBy: { id: 'manager-1', fullName: 'Basma', isActive: true },
  ...extra,
});

function setup(
  found: object | null = invitation(),
  { taken = null as object | null, claimed = 1, readOnly = false, managers = ['manager-1'] } = {},
) {
  const after: (() => Promise<unknown>)[] = [];
  const tx = {
    officeInvitation: { updateMany: jest.fn().mockResolvedValue({ count: claimed }) },
    user: {
      create: jest.fn().mockResolvedValue({ id: 'new-user' }),
      findMany: jest.fn().mockResolvedValue(managers.map((id) => ({ id }))),
    },
    legalAcceptance: { createMany: jest.fn() },
    auditLog: { create: jest.fn() },
    notification: { create: jest.fn().mockResolvedValue({ id: 'n1' }) },
  };
  const prisma = {
    unscoped: () => ({
      officeInvitation: { findUnique: jest.fn().mockResolvedValue(found) },
      user: { findUnique: jest.fn().mockResolvedValue(taken) },
    }),
  } as unknown as PrismaService;
  const uow = {
    run: (work: (t: typeof tx, afterCommit: (task: () => Promise<unknown>) => void) => unknown) =>
      work(tx, (task) => after.push(task)),
  } as unknown as UnitOfWork;
  const auth = {
    openSession: jest.fn().mockResolvedValue({ familyId: 'f' }),
    issue: jest.fn().mockResolvedValue({ session: 'issued' }),
  };
  const realtime = { toUser: jest.fn() };
  const service = new InvitationAcceptService(
    prisma,
    new TenantRunner(ClsServiceManager.getClsService<RequestContext>()),
    uow,
    auth as unknown as AuthService,
    { hash: jest.fn().mockResolvedValue('hash') } as unknown as PasswordHasher,
    realtime as unknown as RealtimePublisher,
    { current: jest.fn().mockResolvedValue({ readOnly }) } as unknown as EntitlementsService,
  );
  return { service, tx, auth, realtime, after };
}

describe('InvitationAcceptService (D-134)', () => {
  it('should preview a pending invitation and refuse anything else with 410, a suspended office with AUTH-006', async () => {
    await expect(setup().service.preview(TOKEN)).resolves.toMatchObject({
      officeName: 'Adel & Partners',
      inviterName: 'Basma',
      role: 'LAWYER',
    });
    for (const found of [
      null,
      invitation({ status: 'REVOKED' }),
      invitation({ expiresAt: new Date(Date.now() - 1) }),
    ]) {
      await expect(setup(found).service.preview(TOKEN)).rejects.toMatchObject({ code: 'RES-004' });
    }
    await expect(
      setup(
        invitation({ office: { name: 'x', defaultLanguage: 'AR', isActive: false } }),
      ).service.preview(TOKEN),
    ).rejects.toMatchObject({ code: 'AUTH-006' });
  });

  it('should create a verified user with the invitation role, notify the office managers and sign in', async () => {
    const { service, tx, auth, realtime, after } = setup();
    await expect(service.accept(body, client)).resolves.toEqual({ session: 'issued' });
    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'nadia@example.test',
          role: 'LAWYER',
          uiLanguage: 'EN',
          passwordHash: 'hash',
          phone: null,
          emailVerifiedAt: expect.any(Date),
        }),
      }),
    );
    expect(tx.legalAcceptance.createMany).toHaveBeenCalled();
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'manager-1', link: '/team' }),
      }),
    );
    expect(auth.openSession).toHaveBeenCalled();
    await Promise.all(after.map((task) => task()));
    expect(realtime.toUser).toHaveBeenCalledWith('manager-1', 'notification', {
      notificationId: 'n1',
    });
  });

  it('should notify every active office manager, and refuse a read-only office (AUTH-104)', async () => {
    const two = setup(invitation(), { managers: ['manager-1', 'manager-2'] });
    await two.service.accept(body, client);
    expect(two.tx.notification.create).toHaveBeenCalledTimes(2);
    const ended = setup(invitation(), { readOnly: true });
    await expect(ended.service.accept(body, client)).rejects.toMatchObject({ code: 'AUTH-104' });
    expect(ended.tx.officeInvitation.updateMany).not.toHaveBeenCalled();
  });

  it('should refuse the email as password, a taken email and a link used meanwhile', async () => {
    await expect(
      setup().service.accept({ ...body, password: 'Nadia@example.test' }, client),
    ).rejects.toMatchObject({ code: 'VAL-001' });
    await expect(
      setup(invitation(), { taken: { id: 'u' } }).service.accept(body, client),
    ).rejects.toMatchObject({
      code: 'RES-002',
    });
    await expect(
      setup(invitation(), { claimed: 0 }).service.accept(body, client),
    ).rejects.toMatchObject({
      code: 'RES-004',
    });
  });
});
