import type { TenantResource } from './tenant-isolation.matrix';

/** Tenant rows written by the platform realm (D-174), listed here to keep the matrix file short. */
export const PLATFORM_RESOURCES: readonly TenantResource[] = [
  {
    model: 'PlatformPayment',
    create: async (db, { officeId }) => {
      // One shared fixture admin: payments must name who recorded them.
      const admin = await db.platformAdmin.upsert({
        where: { email: 'isolation-admin@example.test' },
        create: { email: 'isolation-admin@example.test', fullName: 'Isolation', passwordHash: '!' },
        update: {},
      });
      return db.platformPayment.create({
        data: {
          officeId,
          receiptNumber: `RCT-9999-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
          amount: '10.00',
          currency: 'ILS',
          method: 'CASH',
          paidAt: new Date('2026-11-01'),
          recordedById: admin.id,
          payerName: 'Isolation office',
        },
      });
    },
    update: { reference: 'changed' },
  },
  // Product analytics (D-215): written by office id, read by the platform realm as counts.
  {
    model: 'ProductEvent',
    create: (db, { officeId }) =>
      db.productEvent.create({ data: { officeId, event: 'APP_ACTIVE' } }),
    update: { props: { changed: true } },
  },
  // Missing-court reports (D-266): written by the office, resolved by the platform realm.
  {
    model: 'CourtReport',
    create: (db, { officeId, userId }) =>
      db.courtReport.create({ data: { officeId, reportedById: userId, name: 'Isolation court' } }),
    update: { note: 'Changed' },
  },
];
