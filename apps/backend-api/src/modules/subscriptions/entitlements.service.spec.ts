import type { OfficeId } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import { EntitlementsService } from './entitlements.service';
import type { StorageUsageService } from './storage-usage.service';
import { SubscriptionsController } from './subscriptions.controller';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';

const OFFICE = 'office-1' as OfficeId;
const MIB = 1024n * 1024n;

const plan = {
  code: 'PS_FREE',
  name: 'Free',
  maxUsers: 3 as number | null,
  aiQuotaMonthly: 5 as number | null,
  storageQuotaMb: 1,
  features: {},
};

function setup({ users = 1, invitations = 0, usedBytes = 0n, maxUsers = 3 as number | null } = {}) {
  const findMany = jest.fn().mockResolvedValue([
    {
      status: 'TRIALING',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      trialEndsAt: null,
      plan: { ...plan, maxUsers },
    },
  ]);
  const prisma = {
    unscoped: () => ({ subscription: { findMany } }),
    db: {
      user: { count: jest.fn().mockResolvedValue(users) },
      officeInvitation: { count: jest.fn().mockResolvedValue(invitations) },
    },
  } as unknown as PrismaService;
  const cls = { get: jest.fn().mockReturnValue(OFFICE) } as unknown as ClsService<RequestContext>;
  const storage = {
    usedBytes: jest.fn().mockResolvedValue(usedBytes),
  } as unknown as StorageUsageService;
  return { service: new EntitlementsService(prisma, cls, storage), findMany, cls };
}

describe('EntitlementsService (D-122)', () => {
  it('should cache an office for a while and reload it after invalidate', async () => {
    const { service, findMany } = setup();
    await service.forOffice(OFFICE);
    await service.current();
    expect(findMany).toHaveBeenCalledTimes(1);
    service.invalidate(OFFICE);
    await service.current();
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('should count pending invitations as seats and allow unlimited plans', async () => {
    await expect(setup({ users: 2 }).service.assertUserSlot()).resolves.toBeUndefined();
    await expect(
      setup({ users: 2, invitations: 1 }).service.assertUserSlot(),
    ).rejects.toMatchObject({ code: 'BIZ-008' });
    await expect(
      setup({ users: 99, maxUsers: null }).service.assertUserSlot(),
    ).resolves.toBeUndefined();
  });

  it('should check storage and AI against the quotas, and features against the flags', async () => {
    const { service } = setup({ usedBytes: MIB - 10n });
    await expect(service.assertStorageFor(10n)).resolves.toBeUndefined();
    await expect(service.assertStorageFor(11n)).rejects.toMatchObject({ code: 'AUTH-103' });
    await expect(service.assertAiQuota(5)).rejects.toMatchObject({ code: 'AUTH-103' });
    await expect(service.assertFeature('ai')).resolves.toBeUndefined();
    await expect(service.assertFeature('googleVisionOcr')).rejects.toMatchObject({
      code: 'AUTH-102',
    });
  });

  it('should round storage up to whole MiB', async () => {
    expect(await setup({ usedBytes: 0n }).service.storageMb()).toBe(0);
    expect(await setup({ usedBytes: 1n }).service.storageMb()).toBe(1);
    expect(await setup({ usedBytes: 2n * MIB }).service.storageMb()).toBe(2);
  });

  it('should fail loudly without an office in the request context', () => {
    const { service, cls } = setup();
    (cls.get as jest.Mock).mockReturnValue(undefined);
    expect(() => service.current()).toThrow('No office in the request context');
  });

  it('should answer the subscription view with dates as ISO strings', async () => {
    const { service } = setup({ users: 2, usedBytes: MIB + 1n });
    const view = await new SubscriptionsController(service).get();
    expect(view).toMatchObject({
      plan: { code: 'PS_FREE', name: 'Free' },
      status: 'TRIALING',
      readOnly: false,
      trialEndsAt: null,
      limits: { users: 3, storageMb: 1, aiMonthly: 5 },
      usage: { users: 2, storageMb: 2, aiThisMonth: 0 },
    });
    expect(view.periodEnd).toMatch(/Z$/);
  });
});
