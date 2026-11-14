import {
  CreatePlanSchema,
  SubscriptionActionSchema,
  UpdatePlanSchema,
} from './admin-plans.contract.js';

const plan = {
  code: 'PS_PRO',
  name: 'Pro',
  market: 'PALESTINE',
  priceMonthly: '25',
  currency: 'USD',
  maxUsers: null,
  aiQuotaMonthly: null,
  storageQuotaMb: 1024,
};

describe('admin plans contracts', () => {
  it('should default the optional plan fields', () => {
    expect(CreatePlanSchema.parse(plan)).toMatchObject({
      ocrPagesMonthly: 0,
      trialDays: null,
      features: {},
      isActive: true,
      sortOrder: 0,
    });
  });

  it.each([
    ['a lower-case code', { code: 'ps_pro' }],
    ['a float price', { priceMonthly: '1.234' }],
    ['a currency of two letters', { currency: 'US' }],
    ['a feature flag that is not a boolean', { features: { ai: 'yes' } }],
    ['a feature flag with odd characters', { features: { 'a-b': true } }],
    ['zero users', { maxUsers: 0 }],
  ])('should refuse %s', (_name, over) => {
    expect(CreatePlanSchema.safeParse({ ...plan, ...over }).success).toBe(false);
  });

  it('should keep the code out of an update and refuse an empty one', () => {
    expect(UpdatePlanSchema.parse({ code: 'X', name: 'Pro+' })).toEqual({ name: 'Pro+' });
    expect(UpdatePlanSchema.safeParse({}).success).toBe(false);
  });

  it('should take one action with its own fields', () => {
    expect(
      SubscriptionActionSchema.parse({ action: 'EXTEND_PERIOD', until: '2027-01-31' }),
    ).toEqual({ action: 'EXTEND_PERIOD', until: '2027-01-31' });
    expect(SubscriptionActionSchema.safeParse({ action: 'CHANGE_PLAN' }).success).toBe(false);
    expect(
      SubscriptionActionSchema.safeParse({ action: 'SET_TRIAL', until: '31/01/2027' }).success,
    ).toBe(false);
  });
});
