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
        },
      });
    },
    update: { reference: 'changed' },
  },
];
