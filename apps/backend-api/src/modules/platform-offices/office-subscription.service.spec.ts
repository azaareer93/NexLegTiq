import { endOfDay, OfficeSubscriptionService } from './office-subscription.service';

const client = { ip: '1.2.3.4', userAgent: null, requestId: 'r1' };
const PLAN = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';
const FUTURE = '2099-12-31';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    officeId: 'o1',
    planId: PLAN,
    status: 'ACTIVE',
    currentPeriodStart: new Date('2026-01-01T00:00:00Z'),
    currentPeriodEnd: null,
    trialEndsAt: null,
    ...over,
  };
}

interface Options {
  readonly office?: boolean;
  readonly plan?: unknown;
}

function build(
  rows: unknown[],
  { office = true, plan = { id: OTHER, isActive: true } }: Options = {},
) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue(office ? [{ timezone: 'Asia/Hebron' }] : []),
    subscription: {
      findMany: jest.fn().mockResolvedValue(rows),
      update: jest.fn(async ({ data }: { data: object }) => ({
        ...row(),
        ...(rows[0] as object),
        ...data,
      })),
      create: jest.fn(async ({ data }: { data: object }) => ({ ...row({ id: 's2' }), ...data })),
    },
    plan: { findUnique: jest.fn().mockResolvedValue(plan) },
  };
  const prisma = {
    unscoped: () => ({ $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) }),
  };
  const audit = { log: jest.fn() };
  const entitlements = { invalidate: jest.fn() };
  const service = new OfficeSubscriptionService(
    prisma as never,
    audit as never,
    entitlements as never,
  );
  return { service, tx, audit, entitlements };
}

describe('endOfDay', () => {
  it('should end after the last day in the office time zone', () => {
    // Hebron is UTC+2 in winter: midnight of 1 February there is 22:00 UTC on 31 January.
    expect(endOfDay('2027-01-31', 'Asia/Hebron').toISOString()).toBe('2027-01-31T22:00:00.000Z');
    expect(endOfDay('2027-12-31', 'UTC').toISOString()).toBe('2028-01-01T00:00:00.000Z');
  });
});

describe('OfficeSubscriptionService', () => {
  it('should change the plan in place, audit it with the reason and drop the cached entitlements', async () => {
    const { service, tx, audit, entitlements } = build([row()]);
    await service.apply(
      'o1',
      { action: 'CHANGE_PLAN', planId: OTHER, reason: ' paid ' },
      'a1',
      client,
    );
    expect(tx.subscription.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { planId: OTHER },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SUBSCRIPTION_PLAN_CHANGED',
        targetOfficeId: 'o1',
        oldValues: expect.objectContaining({ planId: PLAN }),
        newValues: expect.objectContaining({ planId: OTHER, reason: 'paid' }),
      }),
      client,
      tx,
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith('o1');
  });

  it('should change nothing and audit nothing for the same plan', async () => {
    const { service, tx, audit } = build([row()]);
    await service.apply('o1', { action: 'CHANGE_PLAN', planId: PLAN }, 'a1', client);
    expect(tx.subscription.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown plan', null],
    ['an inactive plan', { id: OTHER, isActive: false }],
  ])('should refuse %s', async (_name, plan) => {
    const { service } = build([row()], { plan });
    await expect(
      service.apply('o1', { action: 'CHANGE_PLAN', planId: OTHER }, 'a1', client),
    ).rejects.toMatchObject({ code: 'VAL-001' });
  });

  it('should answer 404 for an unknown office or one without a subscription', async () => {
    const trial = { action: 'SET_TRIAL', until: FUTURE } as const;
    await expect(
      build([], { office: false }).service.apply('o1', trial, 'a1', client),
    ).rejects.toMatchObject({ code: 'RES-001' });
    await expect(build([]).service.apply('o1', trial, 'a1', client)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should refuse a date already past', async () => {
    const { service } = build([row()]);
    await expect(
      service.apply('o1', { action: 'EXTEND_PERIOD', until: '2020-01-01' }, 'a1', client),
    ).rejects.toMatchObject({ code: 'VAL-001' });
  });

  it('should turn a trial paid from now, and extend a paid period keeping its start', async () => {
    const trial = build([row({ status: 'TRIALING' })]);
    await trial.service.apply('o1', { action: 'EXTEND_PERIOD', until: FUTURE }, 'a1', client);
    expect(trial.tx.subscription.update.mock.calls[0][0].data).toMatchObject({
      status: 'ACTIVE',
      currentPeriodStart: expect.any(Date),
    });

    const paid = build([row({ status: 'PAST_DUE' })]);
    await paid.service.apply('o1', { action: 'EXTEND_PERIOD', until: FUTURE }, 'a1', client);
    expect(paid.tx.subscription.update.mock.calls[0][0].data).not.toHaveProperty(
      'currentPeriodStart',
    );
  });

  it('should start a new row after an ended one, on the same plan', async () => {
    const { service, tx } = build([row({ status: 'CANCELLED' })]);
    await service.apply('o1', { action: 'EXTEND_PERIOD', until: FUTURE }, 'a1', client);
    expect(tx.subscription.create.mock.calls[0][0].data).toMatchObject({
      officeId: 'o1',
      planId: PLAN,
      status: 'ACTIVE',
    });
    const again = build([row({ status: 'EXPIRED' })]);
    await again.service.apply('o1', { action: 'SET_TRIAL', until: FUTURE }, 'a1', client);
    expect(again.tx.subscription.create.mock.calls[0][0].data).toMatchObject({
      status: 'TRIALING',
    });
  });

  it('should extend a trial, and refuse a trial on a paid subscription (BIZ-023)', async () => {
    const trial = build([row({ status: 'TRIALING' })]);
    await trial.service.apply('o1', { action: 'SET_TRIAL', until: FUTURE }, 'a1', client);
    expect(trial.tx.subscription.update.mock.calls[0][0].data).toEqual({
      trialEndsAt: expect.any(Date),
    });
    await expect(
      build([row()]).service.apply('o1', { action: 'SET_TRIAL', until: FUTURE }, 'a1', client),
    ).rejects.toMatchObject({ code: 'BIZ-023' });
  });

  it('should act on the live row before a newer ended one', async () => {
    const { service, tx } = build([
      row({ id: 's9', status: 'CANCELLED' }),
      row({ status: 'TRIALING' }),
    ]);
    await service.apply('o1', { action: 'SET_TRIAL', until: FUTURE }, 'a1', client);
    expect(tx.subscription.update.mock.calls[0][0].where).toEqual({ id: 's1' });
  });
});
