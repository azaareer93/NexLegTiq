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
  // A purged office's issued invoices (D-251): written by the purge job by office id.
  {
    model: 'RetainedInvoice',
    create: (db, { officeId }) =>
      db.retainedInvoice.create({
        data: {
          officeId,
          invoiceNumber: `INV-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
          snapshot: {},
          retainUntil: new Date('2033-11-27'),
        },
      }),
    update: { snapshot: { changed: true } },
  },
];
