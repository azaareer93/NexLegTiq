import { OfficePurge } from './office-purge';

const OFFICE = '01920000-0000-7000-8000-000000000001';
const dec = (value: string) => ({ toString: () => value });

/** An issued invoice as Prisma returns it, every optional field empty unless `extra` sets it. */
const invoice = (extra: object = {}) => ({
  invoiceNumber: 'INV-1',
  status: 'SENT',
  currency: 'ILS',
  issueDate: null,
  dueDate: null,
  subtotal: dec('100'),
  taxRatePercent: dec('0'),
  taxAmount: dec('0'),
  total: dec('100'),
  sentAt: null,
  paidAt: null,
  paymentMethod: null,
  paymentReference: null,
  notes: null,
  client: { displayName: 'Client' },
  lines: [],
  ...extra,
});

function build({
  locked = true,
  invoices = [] as object[],
  removed = [{ removed: 5 }] as { removed: number }[],
  lateFails = false,
} = {}) {
  const tx = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce(locked ? [{ id: OFFICE }] : [])
      .mockResolvedValueOnce(removed),
    office: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ name: 'Office', taxId: '1', registrationNumber: null }),
      update: jest.fn(),
    },
    invoice: { findMany: jest.fn().mockResolvedValue(invoices) },
    retainedInvoice: { createMany: jest.fn().mockResolvedValue({ count: invoices.length }) },
    platformPayment: { updateMany: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    unscoped: () => ({ $transaction: (work: (t: typeof tx) => unknown) => work(tx) }),
  };
  const storage = {
    deleteOfficeObjects: jest
      .fn()
      .mockResolvedValueOnce(4)
      .mockImplementationOnce(() =>
        lateFails ? Promise.reject(new Error('s3')) : Promise.resolve(2),
      ),
  };
  const tenant = { run: (_ctx: unknown, work: () => unknown) => work() };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const purge = new OfficePurge(
    prisma as never,
    tenant as never,
    storage as never,
    { retainedRecordsYears: 7 } as never,
    logger as never,
  );
  return { purge, tx, storage, logger };
}

const newValuesOf = (tx: ReturnType<typeof build>['tx']) =>
  (tx.auditLog.create.mock.calls[0]?.[0] as { data: { newValues: object } }).data.newValues;

describe('OfficePurge.purge (D-251)', () => {
  it('should skip an office that is no longer due without touching storage or rows', async () => {
    const { purge, storage, tx } = build({ locked: false });
    await expect(purge.purge(OFFICE as never)).resolves.toBe(false);
    expect(storage.deleteOfficeObjects).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('should keep issued invoices as issued, with or without their optional fields, and audit the purge', async () => {
    const full = invoice({
      invoiceNumber: 'INV-2',
      issueDate: new Date('2026-11-01T00:00:00Z'),
      dueDate: new Date('2026-11-15T00:00:00Z'),
      sentAt: new Date('2026-11-01T08:00:00Z'),
      paidAt: new Date('2026-11-10T08:00:00Z'),
      paymentMethod: 'CASH',
      lines: [
        { description: 'Work', quantity: dec('1'), unitPrice: dec('100'), amount: dec('100') },
      ],
    });
    const { purge, tx, storage } = build({ invoices: [invoice({ invoiceNumber: null }), full] });
    await expect(purge.purge(OFFICE as never)).resolves.toBe(true);
    const { data } = tx.retainedInvoice.createMany.mock.calls[0]?.[0] as {
      data: { invoiceNumber: string; snapshot: object }[];
    };
    expect(data[0]).toMatchObject({
      invoiceNumber: '',
      snapshot: { issueDate: null, dueDate: null, sentAt: null, paidAt: null, lines: [] },
    });
    expect(data[1]?.snapshot).toMatchObject({
      issueDate: '2026-11-01',
      dueDate: '2026-11-15',
      paidAt: '2026-11-10T08:00:00.000Z',
      lines: [{ description: 'Work', quantity: '1', unitPrice: '100', amount: '100' }],
    });
    expect(newValuesOf(tx)).toMatchObject({
      deletion: 'PURGED',
      rows: 5,
      storageObjects: 4,
      invoicesRetained: 2,
    });
    expect(tx.platformPayment.updateMany).toHaveBeenCalled();
    expect(storage.deleteOfficeObjects).toHaveBeenCalledTimes(2); // under the lock, then the late sweep
  });

  it('should count no rows when the function returned none, and only log a failed late sweep', async () => {
    const { purge, tx, logger } = build({ removed: [], lateFails: true });
    await expect(purge.purge(OFFICE as never)).resolves.toBe(true);
    expect(tx.retainedInvoice.createMany).not.toHaveBeenCalled();
    expect(newValuesOf(tx)).toMatchObject({ rows: 0, invoicesRetained: 0 });
    expect(logger.warn).toHaveBeenCalled();
  });
});
