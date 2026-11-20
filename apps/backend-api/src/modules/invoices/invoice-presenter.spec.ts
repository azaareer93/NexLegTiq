import { day, plusDays, toInvoice, toListItem } from './invoice-presenter';
import { Prisma } from '../../generated/prisma/client';

const D = (value: string) => new Prisma.Decimal(value);
const at = new Date('2026-11-16T08:30:00Z');

const row = (over: object = {}) => ({
  id: 'i1',
  invoiceNumber: null,
  status: 'DRAFT' as const,
  currency: 'ILS' as const,
  issueDate: null,
  dueDate: null,
  subtotal: D('100'),
  taxRatePercent: D('16'),
  taxAmount: D('16'),
  total: D('116'),
  sentAt: null,
  paidAt: null,
  createdAt: at,
  updatedAt: at,
  client: { id: 'c1', displayName: 'Client' },
  file: null,
  paymentMethod: null,
  paymentReference: null,
  notes: null,
  sharedWithClient: false,
  lines: [] as {
    id: string;
    timeEntryId: string | null;
    description: string;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    amount: Prisma.Decimal;
  }[],
  ...over,
});

describe('invoice presenter (D-162)', () => {
  it('should leave a draft without dates, and amounts in the currency minor digits', () => {
    expect(toListItem(row())).toMatchObject({
      issueDate: null,
      dueDate: null,
      sentAt: null,
      paidAt: null,
      subtotal: '100.00',
      taxRatePercent: '16.00',
      total: '116.00',
    });
  });

  it('should give a sent and paid invoice its days and times, and JOD three digits', () => {
    const issued = new Date('2026-11-01T00:00:00Z');
    const invoice = toInvoice(
      row({
        status: 'PAID',
        currency: 'JOD',
        issueDate: issued,
        dueDate: new Date('2026-12-01T00:00:00Z'),
        sentAt: at,
        paidAt: at,
        total: D('116.0006'),
        lines: [
          {
            id: 'l1',
            timeEntryId: 't1',
            description: 'Hearing',
            quantity: D('1.5'),
            unitPrice: D('40'),
            amount: D('60'),
          },
        ],
      }),
    );
    expect(invoice).toMatchObject({
      issueDate: '2026-11-01',
      dueDate: '2026-12-01',
      sentAt: at.toISOString(),
      paidAt: at.toISOString(),
      total: '116.001',
      lines: [{ quantity: '1.50', unitPrice: '40.000', amount: '60.000', timeEntryId: 't1' }],
    });
  });

  it('should count due days on calendar dates', () => {
    expect(day(new Date('2026-02-28T23:00:00Z'))).toBe('2026-02-28');
    expect(plusDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});
