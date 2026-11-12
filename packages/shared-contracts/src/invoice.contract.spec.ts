import {
  CreateInvoiceSchema,
  InvoiceExtraLineSchema,
  InvoiceQuerySchema,
  MarkInvoicePaidSchema,
  UpdateInvoiceSchema,
} from './invoice.contract.js';

const CLIENT = '01920000-0000-7000-8000-000000000001';
const errorsOf = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? []);

describe('invoice contracts', () => {
  it('should default tax and extra lines on create and accept a consolidated invoice', () => {
    expect(
      CreateInvoiceSchema.parse({
        clientId: CLIENT,
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
      }),
    ).toMatchObject({ includeTax: true, extraLines: [] });
  });

  it('should refuse a period that ends before it starts', () => {
    const result = CreateInvoiceSchema.safeParse({
      clientId: CLIENT,
      periodStart: '2026-10-31',
      periodEnd: '2026-10-01',
    });
    expect(errorsOf(result)).toContain('validation.dateRange');
  });

  it.each([
    [{ quantity: '0', unitPrice: '10' }, 'validation.quantity'],
    [{ quantity: '1.234', unitPrice: '10' }, 'validation.quantity'],
    [{ quantity: '1', unitPrice: '10.1234' }, 'validation.price'],
    [{ quantity: '1', unitPrice: '-5' }, 'validation.price'],
  ])('should refuse the extra line %o', (line, message) => {
    expect(
      errorsOf(InvoiceExtraLineSchema.safeParse({ description: 'Court fee', ...line })),
    ).toContain(message);
  });

  it('should accept a three-decimal (JOD) unit price', () => {
    expect(
      InvoiceExtraLineSchema.parse({ description: 'Stamp', quantity: '2', unitPrice: '10.005' }),
    ).toMatchObject({ unitPrice: '10.005' });
  });

  it('should refuse an empty update and accept a partial one', () => {
    expect(errorsOf(UpdateInvoiceSchema.safeParse({}))).toContain('validation.required');
    expect(UpdateInvoiceSchema.parse({ includeTax: false })).toEqual({ includeTax: false });
  });

  it('should require an offset on the paid time and a known method', () => {
    expect(
      MarkInvoicePaidSchema.safeParse({ paidAt: '2026-11-10T10:00:00', method: 'CASH' }).success,
    ).toBe(false);
    expect(
      MarkInvoicePaidSchema.safeParse({ paidAt: '2026-11-10T10:00:00+02:00', method: 'CHEQUE' })
        .success,
    ).toBe(false);
    expect(
      MarkInvoicePaidSchema.parse({ paidAt: '2026-11-10T10:00:00+02:00', method: 'BANK_TRANSFER' }),
    ).toMatchObject({ method: 'BANK_TRANSFER' });
  });

  it('should default the list query and refuse a reversed date range', () => {
    expect(InvoiceQuerySchema.parse({})).toMatchObject({ page: 1, limit: 20 });
    expect(
      errorsOf(InvoiceQuerySchema.safeParse({ from: '2026-11-10', to: '2026-11-01' })),
    ).toContain('validation.dateRange');
  });
});
