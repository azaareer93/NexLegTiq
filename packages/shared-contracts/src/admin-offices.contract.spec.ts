import {
  AdminOfficeDetailSchema,
  AdminOfficeQuerySchema,
  ReactivateOfficeSchema,
  SuspendOfficeSchema,
} from './admin-offices.contract.js';

describe('admin offices contracts', () => {
  it('should default paging and accept the filters', () => {
    expect(
      AdminOfficeQuerySchema.parse({
        search: 'Haddad',
        status: 'SUSPENDED',
        jurisdiction: 'PALESTINE',
        createdFrom: '2026-10-01',
        createdTo: '2026-10-31',
      }),
    ).toMatchObject({ page: 1, limit: 20, status: 'SUSPENDED' });
  });

  it.each([{ status: 'PAUSED' }, { createdFrom: '01/10/2026' }, { limit: '500' }])(
    'should refuse %o',
    (query) => {
      expect(AdminOfficeQuerySchema.safeParse(query).success).toBe(false);
    },
  );

  it('should require a real reason to suspend', () => {
    expect(SuspendOfficeSchema.safeParse({ reason: '  ab ' }).success).toBe(false);
    expect(SuspendOfficeSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
    expect(SuspendOfficeSchema.safeParse({ reason: 'abc‮' }).success).toBe(false);
    expect(SuspendOfficeSchema.parse({ reason: '  Unpaid since October  ' })).toEqual({
      reason: 'Unpaid since October',
    });
    expect(ReactivateOfficeSchema.parse({})).toEqual({});
  });

  it('should accept a detail with an open-ended subscription', () => {
    const office = {
      id: '01920000-0000-7000-8000-000000000002',
      name: 'Haddad Law',
      jurisdiction: 'PALESTINE',
      status: 'ACTIVE',
      createdAt: '2026-10-01T08:00:00.000Z',
      plan: { code: 'PS_FREE', name: 'Palestine Free' },
      subscriptionStatus: 'TRIALING',
      usage: { activeUsers: 2, liveFiles: 3, storageMb: 1, aiThisMonth: 0 },
      lastActivityAt: null,
      accountType: 'FIRM',
      email: null,
      phone: null,
      currency: 'ILS',
      timezone: 'Asia/Hebron',
      subscriptions: [
        {
          id: '01920000-0000-7000-8000-000000000003',
          plan: { code: 'PS_FREE', name: 'Palestine Free' },
          status: 'TRIALING',
          currentPeriodStart: '2026-10-01T08:00:00.000Z',
          currentPeriodEnd: null,
          trialEndsAt: null,
          createdAt: '2026-10-01T08:00:00.000Z',
        },
      ],
      suspension: null,
    };
    expect(AdminOfficeDetailSchema.safeParse(office).success).toBe(true);
  });
});
