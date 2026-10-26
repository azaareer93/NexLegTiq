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
  timeZone = 'Asia/Hebron',
  aiQuotaMonthly = 5 as number | null,
  maxUsers = 3 as number | null,
  permissions = permissionsFor('OFFICE_MANAGER') as readonly Permission[] | undefined,
} = {}) {
  const subscriptionOf = jest.fn().mockResolvedValue([
    {
      status: 'TRIALING',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      trialEndsAt: null,
      plan: { ...plan, maxUsers, aiQuotaMonthly },
    },
  ]);
  const repository = {
    subscriptionOf,
    activeUsers: jest.fn().mockResolvedValue(users),
    pendingInvitations: jest.fn().mockResolvedValue(invitations),
    aiCallsSince: jest.fn().mockResolvedValue(aiCalls),
    officeTimeZone: jest.fn().mockResolvedValue(timeZone),
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
    repository,
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
      usage: { users: 2, storageMb: 2, aiThisMonth: 0, aiResetsAt: expect.any(String) },
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

  describe('AI quota month (D-144)', () => {
    it("should start and reset the month at midnight in the office's time zone", async () => {
      // 30 Nov 23:30 UTC is already 1 Dec 01:30 in Hebron (UTC+2): December's count.
      const { service, repository } = setup({ aiCalls: 2 });
      const month = await service.aiMonth(new Date('2026-11-30T23:30:00Z'));
      expect(month.start.toISOString()).toBe('2026-11-30T22:00:00.000Z');
      expect(month.resetsAt.toISOString()).toBe('2026-12-31T22:00:00.000Z');
      await service.aiCallsThisMonth(new Date('2026-11-30T23:30:00Z'));
      expect(jest.mocked(repository.aiCallsSince)).toHaveBeenCalledWith(month.start);
      const utc = await setup({ timeZone: 'UTC' }).service.aiMonth(
        new Date('2026-11-30T23:30:00Z'),
      );
      expect(utc.start.toISOString()).toBe('2026-11-01T00:00:00.000Z');
      expect(utc.resetsAt.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    });

    it('should roll December over into January of the next year', async () => {
      const month = await setup({ timeZone: 'UTC' }).service.aiMonth(
        new Date('2026-12-15T10:00:00Z'),
      );
      expect(month.resetsAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });

    it('should report used, remaining and the reset, and say none remain when refusing', async () => {
      await expect(
        setup({ aiCalls: 3 }).service.aiUsage(new Date('2026-10-20T10:00:00Z')),
      ).resolves.toEqual({
        used: 3,
        quota: 5,
        remaining: 2,
        resetsAt: '2026-10-31T22:00:00.000Z',
      });
      await expect(
        setup({ aiCalls: 9, aiQuotaMonthly: null }).service.aiUsage(),
      ).resolves.toMatchObject({
        used: 9,
        quota: null,
        remaining: null,
      });
      await expect(
        setup({ aiCalls: 9, aiQuotaMonthly: null }).service.assertAiQuota(),
      ).resolves.toBeUndefined();
      await expect(setup({ aiCalls: 7 }).service.assertAiQuota()).rejects.toMatchObject({
        code: 'AUTH-103',
        details: [
          {
            field: 'aiQuota',
            message: 'validation.aiQuotaReached',
            params: { remaining: '0', quota: '5', resetsAt: expect.any(String) },
          },
        ],
      });
    });
  });
});
