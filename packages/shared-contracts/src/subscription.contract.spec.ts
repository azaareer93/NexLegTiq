import { OfficeSubscriptionSchema, PLAN_FEATURES } from './subscription.contract.js';

describe('subscription contract (D-122)', () => {
  it('should read a subscription without limits for a member and refuse a negative count', () => {
    const subscription = {
      plan: { code: 'PS_FREE', name: 'Palestine Free' },
      status: 'TRIALING',
      readOnly: false,
      periodEnd: '2027-04-01T00:00:00.000Z',
      trialEndsAt: '2027-04-01T00:00:00.000Z',
      limits: null,
      features: { ai: true, clientPortal: true, googleVisionOcr: false },
      usage: null,
    };
    expect(OfficeSubscriptionSchema.parse(subscription)).toEqual(subscription);
    expect(
      OfficeSubscriptionSchema.safeParse({
        ...subscription,
        limits: { users: -1, storageMb: 0, aiMonthly: null },
      }).success,
    ).toBe(false);
    expect(PLAN_FEATURES).toEqual(Object.keys(subscription.features));
  });
});
