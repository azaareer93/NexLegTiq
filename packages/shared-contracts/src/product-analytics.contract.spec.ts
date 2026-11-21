import { PRODUCT_EVENT_TYPES } from '@nexlegtiq/shared-types';

import { AdminAnalyticsQuerySchema, ProductEventSchema } from './product-analytics.contract.js';

describe('ProductEventSchema (D-215)', () => {
  it('should cover every product event type', () => {
    const listed = ProductEventSchema.options.map((o) => o.shape.event.value);
    expect([...listed].sort()).toEqual([...PRODUCT_EVENT_TYPES].sort());
  });

  it('should accept the allow-listed props only', () => {
    expect(
      ProductEventSchema.safeParse({ event: 'ONBOARDING_STEP_COMPLETED', props: { step: 'CASE' } })
        .success,
    ).toBe(true);
    expect(
      ProductEventSchema.safeParse({
        event: 'FIRST_CASE_CREATED',
        props: { secondsSinceSignup: 95 },
      }).success,
    ).toBe(true);
    expect(ProductEventSchema.safeParse({ event: 'APP_ACTIVE', props: {} }).success).toBe(true);
  });

  it.each([
    ['a name', { event: 'SIGNUP_COMPLETED', props: { name: 'Haddad Law' } }],
    ['an email', { event: 'INVITE_SENT', props: { email: 'a@example.test' } }],
    ['a case title', { event: 'FIRST_CASE_CREATED', props: { secondsSinceSignup: 1, title: 'X' } }],
    ['document content', { event: 'DOCUMENT_UPLOADED', props: { text: 'contract body' } }],
    ['a user id', { event: 'APP_ACTIVE', props: { userId: 'u-1' } }],
    ['a free-text step', { event: 'ONBOARDING_STEP_COMPLETED', props: { step: 'Ahmad' } }],
    ['an unknown event', { event: 'PAGE_VIEW', props: {} }],
    ['a top-level extra key', { event: 'APP_ACTIVE', props: {}, email: 'a@example.test' }],
  ])('should refuse %s', (_what, payload) => {
    expect(ProductEventSchema.safeParse(payload).success).toBe(false);
  });

  it('should default the period to 90 days and bound it', () => {
    expect(AdminAnalyticsQuerySchema.parse({})).toEqual({ days: 90 });
    expect(AdminAnalyticsQuerySchema.safeParse({ days: '400' }).success).toBe(false);
  });
});
