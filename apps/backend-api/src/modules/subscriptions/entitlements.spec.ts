import { resolveEntitlements } from './entitlements';
import type { SubscriptionRow } from './entitlements';

const NOW = new Date('2026-10-19T12:00:00Z');
const BEFORE = new Date('2026-10-19T11:59:59Z');
const AFTER = new Date('2026-10-20T00:00:00Z');

const plan = (features: unknown = {}): SubscriptionRow['plan'] => ({
  code: 'PS_FREE',
  name: 'Free',
  maxUsers: 5,
  aiQuotaMonthly: 5,
  storageQuotaMb: 2048,
  features,
});
const row = (overrides: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  status: 'TRIALING',
  currentPeriodEnd: AFTER,
  trialEndsAt: AFTER,
  plan: plan(),
  ...overrides,
});

describe('resolveEntitlements (D-122)', () => {
  it('should give a running trial full access with the plan limits and default flags', () => {
    const e = resolveEntitlements([row()], NOW);
    expect(e).toMatchObject({
      plan: { code: 'PS_FREE', name: 'Free' },
      status: 'TRIALING',
      readOnly: false,
      maxUsers: 5,
      storageQuotaMb: 2048,
      aiQuotaMonthly: 5,
      features: { ai: true, clientPortal: true, googleVisionOcr: false },
    });
  });

  it.each([
    ['a trial whose trial end passed', row({ trialEndsAt: BEFORE })],
    [
      'a trial without trial end whose period ended',
      row({ trialEndsAt: null, currentPeriodEnd: NOW }),
    ],
    ['an active period that ended', row({ status: 'ACTIVE', currentPeriodEnd: BEFORE })],
    ['a cancelled subscription', row({ status: 'CANCELLED' })],
    ['an expired subscription', row({ status: 'EXPIRED' })],
  ])('should make %s read-only', (_name, subscription) => {
    const e = resolveEntitlements([subscription], NOW);
    expect(e.readOnly).toBe(true);
    expect(['EXPIRED', 'CANCELLED']).toContain(e.status);
  });

  it('should keep an active subscription without an end, and a past-due grace period, writable', () => {
    expect(
      resolveEntitlements([row({ status: 'ACTIVE', currentPeriodEnd: null })], NOW).readOnly,
    ).toBe(false);
    expect(
      resolveEntitlements([row({ status: 'PAST_DUE', currentPeriodEnd: BEFORE })], NOW),
    ).toMatchObject({ status: 'PAST_DUE', readOnly: false });
  });

  it('should prefer the live subscription over a newer ended one, else take the newest', () => {
    const ended = row({ status: 'EXPIRED', plan: { ...plan(), code: 'OLD' } });
    const live = row({ status: 'ACTIVE', currentPeriodEnd: null });
    expect(resolveEntitlements([ended, live], NOW)).toMatchObject({
      status: 'ACTIVE',
      readOnly: false,
    });
    expect(resolveEntitlements([ended, row({ status: 'CANCELLED' })], NOW).plan?.code).toBe('OLD');
  });

  it('should read only boolean flags from the plan and ignore unknown keys', () => {
    const e = resolveEntitlements(
      [
        row({
          plan: plan({
            ai: false,
            googleVisionOcr: true,
            clientPortal: 'yes',
            customPricing: true,
          }),
        }),
      ],
      NOW,
    );
    expect(e.features).toEqual({ ai: false, clientPortal: true, googleVisionOcr: true });
    expect(resolveEntitlements([row({ plan: plan(null) })], NOW).features.ai).toBe(true);
  });

  it('should leave an office without any subscription read-only with nothing', () => {
    expect(resolveEntitlements([], NOW)).toMatchObject({
      plan: null,
      readOnly: true,
      maxUsers: 0,
      features: { ai: false, clientPortal: false, googleVisionOcr: false },
    });
  });
});
