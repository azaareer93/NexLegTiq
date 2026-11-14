import { RecordPaymentSchema, VoidPaymentSchema } from './admin-payments.contract.js';

const payment = {
  amount: '150.50',
  currency: 'ils',
  method: 'CASH',
  paidAt: '2026-11-14',
};

describe('admin payments contracts', () => {
  it('should upper-case the currency and email the office by default', () => {
    expect(RecordPaymentSchema.parse(payment)).toEqual({
      ...payment,
      currency: 'ILS',
      emailOffice: true,
    });
    expect(RecordPaymentSchema.parse({ ...payment, amount: '10.125' }).amount).toBe('10.125');
  });

  it.each([
    ['a zero amount', { amount: '0.00' }],
    ['a negative amount', { amount: '-5' }],
    ['four decimals', { amount: '1.2345' }],
    ['an unknown currency', { currency: 'XYZ' }],
    ['a card payment', { method: 'CARD' }],
    ['a date in another format', { paidAt: '14/11/2026' }],
    ['a typo year', { paidAt: '0202-11-14' }],
  ])('should refuse %s', (_label, over) => {
    expect(RecordPaymentSchema.safeParse({ ...payment, ...over }).success).toBe(false);
  });

  it('should need a reason to void', () => {
    expect(VoidPaymentSchema.safeParse({ reason: ' x ' }).success).toBe(false);
    expect(VoidPaymentSchema.parse({ reason: ' recorded twice ' }).reason).toBe('recorded twice');
  });
});
