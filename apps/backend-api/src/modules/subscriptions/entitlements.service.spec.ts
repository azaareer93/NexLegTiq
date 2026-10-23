import type { OfficeId, Permission } from '@nexlegtiq/shared-types';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import { EntitlementsService } from './entitlements.service';
import type { StorageUsageService } from './storage-usage.service';
import { SubscriptionsController } from './subscriptions.controller';
import type { SubscriptionsRepository } from './subscriptions.repository';
import type { RequestContext } from '../../common/context/request-context';

const OFFICE = 'office-1' as OfficeId;
const OTHER = 'office-2' as OfficeId;
const MIB = 1024n * 1024n;

const plan = {
  code: 'PS_FREE',
  name: 'Free',
  maxUsers: 3 as number | null,
  aiQuotaMonthly: 5 as number | null,
  storageQuotaMb: 1,
  features: {},
};

function setup({
  users = 1,
  invitations = 0,
  usedBytes = 0n,
  aiCalls = 0,
  maxUsers = 3 as number | null,
  permissions = permissionsFor('OFFICE_MANAGER') as readonly Permission[] | undefined,
} = {}) {
  const subscriptionOf = jest.fn().mockResolvedValue([
    {
      status: 'TRIALING',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      trialEndsAt: null,
      plan: { ...plan, maxUsers },
    },
  ]);
  const repository = {
    subscriptionOf,
    activeUsers: jest.fn().mockResolvedValue(users),
    pendingInvitations: jest.fn().mockResolvedValue(invitations),
    aiCallsSince: jest.fn().mockResolvedValue(aiCalls),
  } as unknown as SubscriptionsRepository;
  const context: Record<string, unknown> = { officeId: OFFICE, permissions };
  const cls = {
    get: jest.fn((key: string) => context[key]),
  } as unknown as ClsService<RequestContext>;
  const storage = {
    usedBytes: jest.fn().mockResolvedValue(usedBytes),
  } as unknown as StorageUsageService;
  const service = new EntitlementsService(repository, cls, storage);
  return {
    service,
    subscriptionOf,
    context,
    controller: new SubscriptionsController(service, cls),
  };
}

describe('EntitlementsService (D-122)', () => {
  afterEach(() => jest.useRealTimers());

  it('should cache each office for 30 s, apart from other offices, and reload after invalidate', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    const { service, subscriptionOf } = setup();
    await service.forOffice(OFFICE);
    await service.current();
    expect(subscriptionOf).toHaveBeenCalledTimes(1);
    await service.forOffice(OTHER);
    expect(subscriptionOf).toHaveBeenLastCalledWith(OTHER);
    jest.advanceTimersByTime(29_999);
    await service.forOffice(OFFICE);
    expect(subscriptionOf).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    await service.forOffice(OFFICE);
    expect(subscriptionOf).toHaveBeenCalledTimes(3);
    service.invalidate(OFFICE);
    await service.current();
    expect(subscriptionOf).toHaveBeenCalledTimes(4);
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
    await expect(setup({ aiCalls: 4 }).service.assertAiQuota()).resolves.toBeUndefined();
    await expect(setup({ aiCalls: 5 }).service.assertAiQuota()).rejects.toMatchObject({
      code: 'AUTH-103',
    });
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
    const { service, context } = setup();
    delete context['officeId'];
    expect(() => service.current()).toThrow('No office in the request context');
  });

  it('should answer the subscription view with limits and usage for a manager', async () => {
    const view = await setup({ users: 2, usedBytes: MIB + 1n }).controller.get();
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

  it('should leave limits and usage out for anyone without manage:subscription, without counting', async () => {
    const { controller, service } = setup({ permissions: permissionsFor('EXTERNAL_COLLABORATOR') });
    const activeUsers = jest.spyOn(service, 'activeUsers');
    expect(await controller.get()).toMatchObject({
      status: 'TRIALING',
      readOnly: false,
      limits: null,
      usage: null,
    });
    expect(activeUsers).not.toHaveBeenCalled();
  });
});
