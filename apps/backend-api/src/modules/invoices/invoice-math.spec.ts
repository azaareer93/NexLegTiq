import { invoiceNumber, invoiceTotals, lineAmount } from './invoice-math';

describe('lineAmount (D-162)', () => {
  it.each([
    ['1.50', '100.000', 'ILS', '150.00'],
    // half-even ties: 0.125 -> 0.12, 0.135 -> 0.14 at two digits
    ['1.00', '0.125', 'ILS', '0.12'],
    ['1.00', '0.135', 'ILS', '0.14'],
    // JOD keeps three digits
    ['0.33', '10.000', 'JOD', '3.300'],
    ['0.10', '1.005', 'JOD', '0.100'],
    ['1.00', '0.0125', 'JOD', '0.012'],
  ])('should multiply %s x %s in %s to %s', (quantity, price, currency, expected) => {
    expect(lineAmount(quantity, price, currency)).toBe(expected);
  });
});

describe('invoiceTotals (D-162)', () => {
  it('should apply the tax once to the subtotal, not per line', () => {
    // Tax once on the 0.30 subtotal: 0.045 rounds half-even to 0.04 (per line it would be 3 x 0.02).
    expect(invoiceTotals(['0.10', '0.10', '0.10'], '15.00', true, 'ILS')).toEqual({
      subtotal: '0.30',
      taxRatePercent: '15.00',
      taxAmount: '0.04',
      total: '0.34',
    });
  });

  it('should round the tax half-even to the currency digits', () => {
    expect(invoiceTotals(['100.500'], '17.00', true, 'JOD')).toMatchObject({
      subtotal: '100.500',
      taxAmount: '17.085',
      total: '117.585',
    });
    expect(invoiceTotals(['10.50'], '5.00', true, 'ILS').taxAmount).toBe('0.52');
  });

  it('should store a zero rate and no tax when tax is not included', () => {
    expect(invoiceTotals(['50.00'], '17.00', false, 'ILS')).toEqual({
      subtotal: '50.00',
      taxRatePercent: '0.00',
      taxAmount: '0.00',
      total: '50.00',
    });
  });
});

describe('invoiceNumber', () => {
  it('should pad to four digits and grow past them', () => {
    expect(invoiceNumber(2026, 7)).toBe('INV-2026-0007');
    expect(invoiceNumber(2026, 12345)).toBe('INV-2026-12345');
  });
});
