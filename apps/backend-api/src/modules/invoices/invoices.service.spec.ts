import { InvoicesService } from './invoices.service';
import { Prisma } from '../../generated/prisma/client';

const ID = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CLIENT = ID(1);
const FILE = ID(2);

const entry = (n: number, over: object = {}) => ({
  id: ID(100 + n),
  fileId: FILE,
  description: 'Work',
  durationHours: new Prisma.Decimal('1.50'),
  hourlyRate: new Prisma.Decimal('150'),
  currency: 'ILS',
  ...over,
});

const body = (over: object = {}) =>
  ({
    clientId: CLIENT,
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    includeTax: true,
    extraLines: [],
    ...over,
  }) as never;

function setup(
  entries: object[] = [entry(1)],
  files: object[] = [{ id: FILE, currency: 'ILS', status: 'OPEN' }],
) {
  const tx = {
    $queryRaw: jest.fn(),
    timeEntry: {
      findMany: jest.fn().mockResolvedValue(entries),
      updateMany: jest.fn().mockResolvedValue({ count: entries.length }),
    },
    officeSettings: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ taxRatePercent: new Prisma.Decimal('16') }),
    },
    invoice: { create: jest.fn().mockResolvedValue({ id: ID(50) }) },
    invoiceLineItem: { createMany: jest.fn() },
  };
  const db = {
    client: { findFirst: jest.fn().mockResolvedValue({ id: CLIENT }) },
    legalFile: {
      findMany: jest.fn().mockResolvedValue(files),
      findFirst: jest.fn().mockResolvedValue(files[0] ?? null),
    },
    fileClient: { count: jest.fn().mockResolvedValue(1) },
    invoice: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
  const audit = { log: jest.fn() };
  const access = {
    caller: () => ({ userId: ID(7), officeId: ID(9) }),
    fileScope: () => ({}),
    visibleWhere: () => ({}),
  };
  const service = new InvoicesService(
    { db } as never,
    { run: (work: (t: typeof tx) => unknown) => work(tx) } as never,
    access as never,
    audit as never,
  );
  // `get` after the write reads the created invoice back.
  jest.spyOn(service, 'get').mockResolvedValue({ id: ID(50) } as never);
  return { service, tx, db, audit };
}

describe('InvoicesService.create (D-162)', () => {
  it('should draft lines from the entries, round, claim them and audit', async () => {
    const { service, tx, audit } = setup([
      entry(1),
      entry(2, { hourlyRate: new Prisma.Decimal('0.35') }),
    ]);
    await service.create(body({ fileId: FILE, dueDate: '2026-12-01', notes: 'Hi' }));
    const data = tx.invoice.create.mock.calls[0][0].data;
    // 1.5 x 150 = 225.00 and 1.5 x 0.35 = 0.525 -> 0.52 (half-even); tax 16% of 225.52 = 36.0832 -> 36.08
    expect(data).toMatchObject({
      fileId: FILE,
      currency: 'ILS',
      subtotal: '225.52',
      taxAmount: '36.08',
      total: '261.60',
      notes: 'Hi',
    });
    expect(tx.invoiceLineItem.createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(tx.timeEntry.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [ID(101), ID(102)] }, invoiceId: null },
      data: { invoiceId: ID(50) },
    });
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('should bill extra items alone on the files currency, only on a named file', async () => {
    const { service, tx, db } = setup([], [{ id: FILE, currency: 'JOD', status: 'OPEN' }]);
    await service.create(
      body({
        fileId: FILE,
        includeTax: false,
        extraLines: [{ description: 'Fee', quantity: '1', unitPrice: '2.5' }],
      }),
    );
    expect(tx.invoice.create.mock.calls[0][0].data).toMatchObject({
      fileId: FILE,
      currency: 'JOD',
      total: '2.500',
      dueDate: null,
    });
    expect(db.legalFile.findFirst).toHaveBeenCalled();
  });

  it('should refuse a consolidated invoice with extra items but no time (it names no file)', async () => {
    const { service } = setup([], [{ id: FILE, currency: 'ILS', status: 'OPEN' }]);
    await expect(
      service.create(body({ extraLines: [{ description: 'x', quantity: '1', unitPrice: '1' }] })),
    ).rejects.toMatchObject({ code: 'VAL-001' });
  });

  it('should refuse unknown clients, unrated entries, nothing to bill and mixed currencies', async () => {
    const unknown = setup();
    unknown.db.client.findFirst.mockResolvedValue(null);
    await expect(unknown.service.create(body())).rejects.toMatchObject({ code: 'VAL-001' });

    const unrated = setup([entry(1, { hourlyRate: null })]);
    await expect(unrated.service.create(body())).rejects.toMatchObject({ code: 'VAL-001' });

    const nothing = setup([]);
    await expect(nothing.service.create(body())).rejects.toMatchObject({ code: 'VAL-001' });

    const noFiles = setup([], []);
    await expect(
      noFiles.service.create(
        body({ extraLines: [{ description: 'x', quantity: '1', unitPrice: '1' }] }),
      ),
    ).rejects.toMatchObject({ code: 'VAL-001' });

    const mixed = setup([entry(1), entry(2, { currency: 'USD' })]);
    await expect(mixed.service.create(body())).rejects.toMatchObject({ code: 'BIZ-021' });
  });

  it('should answer 409 when an entry was claimed meanwhile', async () => {
    const { service, tx } = setup();
    tx.timeEntry.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.create(body())).rejects.toMatchObject({ code: 'RES-003' });
  });

  it('should check the file of a per-file invoice: visible, not archived, client linked', async () => {
    const missing = setup();
    missing.db.legalFile.findFirst.mockResolvedValue(null);
    await expect(missing.service.create(body({ fileId: FILE }))).rejects.toMatchObject({
      code: 'RES-001',
    });
    const archived = setup([entry(1)], [{ id: FILE, currency: 'ILS', status: 'ARCHIVED' }]);
    await expect(archived.service.create(body({ fileId: FILE }))).rejects.toMatchObject({
      code: 'BIZ-007',
    });
    const unlinked = setup();
    unlinked.db.fileClient.count.mockResolvedValue(0);
    await expect(unlinked.service.create(body({ fileId: FILE }))).rejects.toMatchObject({
      code: 'VAL-001',
    });
  });
});

describe('InvoicesService reads (D-162)', () => {
  it("should total a client's invoices per currency, rounded to its digits (MVP-55)", async () => {
    const { service, db } = setup();
    db.invoice.groupBy
      .mockResolvedValueOnce([
        { currency: 'ILS', _sum: { total: new Prisma.Decimal('10.5') }, _count: { _all: 2 } },
        { currency: 'JOD', _sum: { total: null }, _count: { _all: 0 } },
      ])
      .mockResolvedValueOnce([]);
    expect(await service.summary(CLIENT)).toEqual({
      billed: [
        { currency: 'ILS', amount: '10.50', count: 2 },
        { currency: 'JOD', amount: '0.000', count: 0 },
      ],
      outstanding: [],
    });
    expect(db.invoice.groupBy.mock.calls[1]?.[0].where.AND[1]).toEqual({
      clientId: CLIENT,
      status: { in: ['SENT', 'OVERDUE'] },
    });
  });

  it('should list with filters and sort, id as tie-breaker', async () => {
    const { service, db } = setup();
    const result = await service.list({
      status: 'SENT',
      clientId: CLIENT,
      fileId: FILE,
      from: '2026-01-01',
      to: '2026-12-31',
      sort: [{ field: 'total', direction: 'asc' }],
      page: 2,
      limit: 10,
    });
    expect(result.pagination).toMatchObject({ page: 2, limit: 10, total: 0 });
    expect(db.invoice.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: [{ total: 'asc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
    });
    await service.list({ sort: [], page: 1, limit: 20 });
  });
});
