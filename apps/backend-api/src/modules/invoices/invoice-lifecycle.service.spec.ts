import { InvoiceLifecycle } from './invoice-lifecycle.service';
import { Prisma } from '../../generated/prisma/client';

const ID = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const INVOICE = ID(1);

const line = (over: object = {}) => ({
  fileId: ID(2),
  timeEntryId: ID(3),
  amount: new Prisma.Decimal('100.00'),
  ...over,
});

const row = (over: object = {}) => ({
  id: INVOICE,
  status: 'DRAFT',
  currency: 'ILS',
  fileId: null,
  invoiceNumber: 'INV-2026-0001',
  dueDate: null,
  taxRatePercent: new Prisma.Decimal('16'),
  total: new Prisma.Decimal('116.00'),
  lines: [line(), line({ fileId: null, timeEntryId: null, amount: new Prisma.Decimal('10.00') })],
  ...over,
});

function setup(locked: object = row()) {
  const tx = {
    invoice: { update: jest.fn(), delete: jest.fn() },
    invoiceLineItem: { deleteMany: jest.fn(), createMany: jest.fn() },
    timeEntry: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    officeSettings: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ taxRatePercent: new Prisma.Decimal('10') }),
    },
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
  };
  const access = {
    caller: () => ({ officeId: ID(9) }),
    locked: jest.fn().mockResolvedValue(locked),
  };
  const invoices = { get: jest.fn().mockResolvedValue({ id: INVOICE }) };
  const numbers = { next: jest.fn().mockResolvedValue('INV-2026-0007') };
  const audit = { log: jest.fn() };
  const timeline = { record: jest.fn() };
  const lifecycle = new InvoiceLifecycle(
    { run: (work: (t: typeof tx) => unknown) => work(tx) } as never,
    access as never,
    invoices as never,
    numbers as never,
    audit as never,
    timeline as never,
  );
  return { lifecycle, tx, access, numbers, audit, timeline };
}

describe('InvoiceLifecycle.update (D-162)', () => {
  it('should keep the time lines, replace the extras and recompute with the office rate', async () => {
    const { lifecycle, tx } = setup();
    await lifecycle.update(INVOICE, {
      notes: '',
      dueDate: '2026-12-01',
      includeTax: true,
      extraLines: [{ description: 'Stamp', quantity: '2', unitPrice: '5.00' }],
    });
    expect(tx.invoiceLineItem.deleteMany).toHaveBeenCalledWith({
      where: { invoiceId: INVOICE, timeEntryId: null },
    });
    expect(tx.invoiceLineItem.createMany.mock.calls[0][0].data[0]).toMatchObject({
      position: 1,
      amount: '10.00',
    });
    expect(tx.invoice.update.mock.calls[0][0].data).toMatchObject({
      subtotal: '110.00',
      taxRatePercent: '10.00',
      taxAmount: '11.00',
      total: '121.00',
      notes: null,
    });
  });

  it('should recompute from the stored lines and rate when only the note changes', async () => {
    const { lifecycle, tx } = setup();
    await lifecycle.update(INVOICE, { notes: 'Thanks' });
    expect(tx.invoiceLineItem.deleteMany).not.toHaveBeenCalled();
    expect(tx.invoice.update.mock.calls[0][0].data).toMatchObject({
      subtotal: '110.00',
      taxRatePercent: '16.00',
      taxAmount: '17.60',
      notes: 'Thanks',
    });
  });

  it('should drop tax when includeTax is false', async () => {
    const { lifecycle, tx } = setup();
    await lifecycle.update(INVOICE, { includeTax: false });
    expect(tx.invoice.update.mock.calls[0][0].data).toMatchObject({ total: '110.00' });
  });
});

describe('InvoiceLifecycle send, pay, void, delete (D-162)', () => {
  it('should number the draft, fix the dates and record the event on every billed file', async () => {
    const { lifecycle, tx, numbers, timeline } = setup(
      row({ lines: [line(), line({ fileId: ID(4) }), line({ fileId: null })] }),
    );
    await lifecycle.send(INVOICE);
    expect(numbers.next).toHaveBeenCalledWith(tx, expect.any(Number));
    const data = tx.invoice.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'SENT', invoiceNumber: 'INV-2026-0007' });
    expect(data.dueDate.getTime() - data.issueDate.getTime()).toBe(30 * 86_400_000);
    expect(timeline.record).toHaveBeenCalledTimes(2);
    expect(timeline.record.mock.calls[0][1]).toMatchObject({
      eventType: 'INVOICE_SENT',
      payload: { invoiceNumber: 'INV-2026-0007' },
    });
  });

  it('should keep a chosen due date and refuse one already past', async () => {
    const ok = setup(row({ dueDate: new Date('2099-01-01T00:00:00Z') }));
    await ok.lifecycle.send(INVOICE);
    expect(ok.tx.invoice.update.mock.calls[0][0].data.dueDate).toEqual(
      new Date('2099-01-01T00:00:00Z'),
    );
    const past = setup(row({ dueDate: new Date('2020-01-01T00:00:00Z') }));
    await expect(past.lifecycle.send(INVOICE)).rejects.toMatchObject({ code: 'VAL-001' });
  });

  it('should mark paid with the method and record INVOICE_PAID', async () => {
    const { lifecycle, tx, timeline } = setup(row({ status: 'SENT', fileId: ID(2) }));
    await lifecycle.markPaid(INVOICE, {
      paidAt: '2026-11-10T09:00:00+02:00',
      method: 'CASH',
    });
    expect(tx.invoice.update.mock.calls[0][0].data).toMatchObject({
      status: 'PAID',
      paymentMethod: 'CASH',
      paymentReference: null,
    });
    expect(timeline.record.mock.calls[0][1]).toMatchObject({ eventType: 'INVOICE_PAID' });
  });

  it('should void, freeing the entries, and delete a draft, freeing them too', async () => {
    const voided = setup(row({ status: 'SENT' }));
    await voided.lifecycle.void(INVOICE);
    expect(voided.tx.invoice.update).toHaveBeenCalledWith({
      where: { id: INVOICE },
      data: { status: 'VOID' },
    });
    expect(voided.tx.timeEntry.updateMany).toHaveBeenCalledWith({
      where: { invoiceId: INVOICE },
      data: { invoiceId: null },
    });
    const deleted = setup();
    await deleted.lifecycle.remove(INVOICE);
    expect(deleted.tx.invoice.delete).toHaveBeenCalledWith({ where: { id: INVOICE } });
    expect(deleted.audit.log).toHaveBeenCalled();
  });
});
