import { RetainerController } from './retainer.controller';
import { RetainerService } from './retainer.service';
import { Prisma } from '../../generated/prisma/client';

const FILE = '01920000-0000-7000-8000-0000000000f1';
const NOW = '2026-11-10T09:00:00+02:00';

function build(
  file: object | null = {
    status: 'OPEN',
    currency: 'ILS',
    retainerBalance: new Prisma.Decimal('100'),
  },
) {
  const tx = {
    $queryRaw: jest.fn(),
    legalFile: { findFirst: jest.fn().mockResolvedValue(file), update: jest.fn() },
    retainerEntry: { create: jest.fn().mockResolvedValue({ id: 'e1' }) },
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
  };
  const view = {
    id: FILE,
    currency: 'ILS',
    retainerBalance: new Prisma.Decimal('100'),
    retainerEntries: [
      {
        id: 'e1',
        kind: 'DEPOSIT',
        amount: new Prisma.Decimal('100'),
        paidAt: new Date(NOW),
        method: 'CASH',
        reference: null,
        createdAt: new Date(NOW),
        invoice: null,
        createdBy: { id: 'u1', fullName: 'U' },
      },
    ],
  };
  const prisma = {
    db: { legalFile: { findFirst: jest.fn().mockResolvedValue(file ? view : null) } },
  };
  const uow = { run: (work: (t: typeof tx) => unknown) => work(tx) };
  const access = { fileScope: () => ({}), caller: () => ({ officeId: 'o1', userId: 'u1' }) };
  const audit = { log: jest.fn() };
  const timeline = { record: jest.fn() };
  const service = new RetainerService(
    prisma as never,
    uow as never,
    access as never,
    audit as never,
    timeline as never,
  );
  return { service, tx, audit, timeline };
}

const debit = (over: Record<string, unknown> = {}) => ({
  invoiceId: 'i1',
  invoiceNumber: 'INV-2026-0001',
  fileId: FILE,
  currency: 'ILS',
  total: '40.00',
  paidAt: NOW,
  ...over,
});

describe('RetainerService (D-176)', () => {
  it('should add a deposit to the balance with its timeline event and audit row', async () => {
    const { service, tx, audit, timeline } = build();
    const view = await service.deposit(FILE, { amount: '25.50', paidAt: NOW, method: 'CASH' });
    expect(view).toMatchObject({
      balance: '100.00',
      entries: [{ amount: '100.00', kind: 'DEPOSIT' }],
    });
    expect(tx.legalFile.update).toHaveBeenCalledWith({
      where: { id: FILE },
      data: { retainerBalance: '125.50' },
    });
    expect(tx.retainerEntry.create.mock.calls[0][0].data).toMatchObject({
      amount: '25.50',
      reference: null,
    });
    expect(timeline.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ eventType: 'RETAINER_DEPOSITED' }),
    );
    expect(audit.log).toHaveBeenCalled();
  });

  it.each([
    [
      'an archived file',
      { status: 'ARCHIVED', currency: 'ILS', retainerBalance: new Prisma.Decimal(0) },
      '1',
      NOW,
      'BIZ-007',
    ],
    ['too many decimals', undefined, '1.005', NOW, 'VAL-001'],
    ['a future day', undefined, '1', '2999-01-01T09:00:00+02:00', 'VAL-001'],
  ])('should refuse a deposit on %s', async (_label, file, amount, paidAt, code) => {
    const { service } = build(file);
    await expect(service.deposit(FILE, { amount, paidAt, method: 'CASH' })).rejects.toMatchObject({
      code,
    });
  });

  it('should answer 404 for a file the caller cannot see', async () => {
    const { service } = build(null);
    await expect(service.get(FILE)).rejects.toMatchObject({ code: 'RES-001' });
    await expect(
      service.deposit(FILE, { amount: '1', paidAt: NOW, method: 'CASH' }),
    ).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should debit an invoice payment, or refuse a short balance, a consolidated invoice or another currency', async () => {
    const ok = build();
    await ok.service.payInvoice(ok.tx as never, debit());
    expect(ok.tx.retainerEntry.create.mock.calls[0][0].data).toMatchObject({
      kind: 'INVOICE_PAYMENT',
      amount: '-40.00',
      method: 'RETAINER',
    });
    expect(ok.tx.legalFile.update).toHaveBeenCalledWith({
      where: { id: FILE },
      data: { retainerBalance: '60.00' },
    });
    const short = build();
    await expect(
      short.service.payInvoice(short.tx as never, debit({ total: '100.01' })),
    ).rejects.toMatchObject({
      code: 'BIZ-005',
    });
    const exact = build();
    await expect(
      exact.service.payInvoice(exact.tx as never, debit({ total: '100.00' })),
    ).resolves.toBeUndefined();
    const none = build();
    await expect(
      none.service.payInvoice(none.tx as never, debit({ fileId: null })),
    ).rejects.toMatchObject({
      code: 'VAL-001',
    });
    const usd = build();
    await expect(
      usd.service.payInvoice(usd.tx as never, debit({ currency: 'USD' })),
    ).rejects.toMatchObject({
      code: 'VAL-001',
    });
  });

  it('should refuse a zero total, an archived file and a balance the column cannot hold', async () => {
    const zero = build();
    await expect(
      zero.service.payInvoice(zero.tx as never, debit({ total: '0.00' })),
    ).rejects.toMatchObject({
      code: 'VAL-001',
    });
    const archived = build({
      status: 'ARCHIVED',
      currency: 'ILS',
      retainerBalance: new Prisma.Decimal('100'),
    });
    await expect(archived.service.payInvoice(archived.tx as never, debit())).rejects.toMatchObject({
      code: 'BIZ-007',
    });
    const full = build({
      status: 'OPEN',
      currency: 'ILS',
      retainerBalance: new Prisma.Decimal('99999999999.99'),
    });
    await expect(
      full.service.deposit(FILE, { amount: '10', paidAt: NOW, method: 'CASH' }),
    ).rejects.toMatchObject({
      code: 'VAL-001',
    });
  });

  it('should add decimal amounts exactly and pay a JOD balance down to zero', async () => {
    const small = build({
      status: 'OPEN',
      currency: 'ILS',
      retainerBalance: new Prisma.Decimal('0.1'),
    });
    await small.service.deposit(FILE, { amount: '0.20', paidAt: NOW, method: 'CASH' });
    expect(small.tx.legalFile.update.mock.calls[0][0].data).toEqual({ retainerBalance: '0.30' });
    const jod = build({
      status: 'OPEN',
      currency: 'JOD',
      retainerBalance: new Prisma.Decimal('0.001'),
    });
    await jod.service.payInvoice(jod.tx as never, debit({ currency: 'JOD', total: '0.001' }));
    expect(jod.tx.legalFile.update.mock.calls[0][0].data).toEqual({ retainerBalance: '0.000' });
    expect(jod.tx.retainerEntry.create.mock.calls[0][0].data.amount).toBe('-0.001');
  });
});

describe('RetainerController', () => {
  it('should pass reads and deposits to the service', async () => {
    const retainers = {
      get: jest.fn().mockResolvedValue('view'),
      deposit: jest.fn().mockResolvedValue('after'),
    };
    const controller = new RetainerController(retainers as never);
    await expect(controller.get(FILE)).resolves.toBe('view');
    const body = { amount: '1', paidAt: NOW, method: 'CASH' as const };
    await expect(controller.deposit(FILE, body)).resolves.toBe('after');
    expect(retainers.deposit).toHaveBeenCalledWith(FILE, body);
  });
});
