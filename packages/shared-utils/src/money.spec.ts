import { Decimal } from 'decimal.js';

import { addMoney, compareMoney, currencyDigits, multiplyMoney, parseAmount, percentOf, roundMoney, subtractMoney } from './money.js';

describe('money math', () => {
  it('should add without float error (0.1 + 0.2 is 0.3)', () => {
    expect(addMoney('0.1', '0.2')).toBe('0.3');
    expect(addMoney('1999.99', '0.01', '-500')).toBe('1500');
    expect(addMoney()).toBe('0');
  });

  it('should subtract, multiply and take percentages exactly', () => {
    expect(subtractMoney('100', '33.33', '33.33')).toBe('33.34');
    expect(multiplyMoney('150.00', '2.5')).toBe('375');
    expect(multiplyMoney('0.07', '3')).toBe('0.21');
    expect(percentOf('1234.56', '16')).toBe('197.5296');
  });

  it.each([
    ['2.345', 2, '2.34'],
    ['2.355', 2, '2.36'],
    ['-2.345', 2, '-2.34'],
    ['2.3451', 2, '2.35'],
    ['10', 2, '10.00'],
    ['0.5', 0, '0'],
    ['1.5', 0, '2'],
  ])('should round %s half-even to %i decimals as %s', (amount, digits, expected) => {
    expect(roundMoney(amount, digits)).toBe(expected);
  });

  it('should round to a currency own minor digits', () => {
    expect([currencyDigits('ILS'), currencyDigits('JOD'), currencyDigits('JPY')]).toEqual([2, 3, 0]);
    expect(roundMoney('1.2345', 'JOD')).toBe('1.234');
    expect(roundMoney('1.2355', 'JOD')).toBe('1.236');
    expect(roundMoney('1.5', 'JPY')).toBe('2');
  });

  it('should parse a plain decimal and keep a Decimal as it is', () => {
    expect(parseAmount('-12.50').toFixed()).toBe('-12.5');
    expect(parseAmount(new Decimal('3.14')).toFixed()).toBe('3.14');
  });

  it('should compare amounts', () => {
    expect([compareMoney('1.10', '1.1'), compareMoney('2', '10'), compareMoney('10', '2')]).toEqual([0, -1, 1]);
  });

  it.each(['abc', 'Infinity', 'NaN', '0x10', '0b101', '1e1000000', '1.', '.5', '+1', '1 '])('should refuse %j as an amount', (amount) => {
    expect(() => addMoney(amount)).toThrow(RangeError);
  });

  it('should refuse a non-finite decimal, and an unknown currency', () => {
    expect(() => addMoney(new Decimal(Infinity))).toThrow(RangeError);
    expect(() => roundMoney('1', 'XYZ')).toThrow(RangeError);
  });

  it('should never return a negative zero', () => {
    expect(roundMoney('-0.001', 2)).toBe('0.00');
    expect(roundMoney('-0.005', 2)).toBe('0.00');
    expect(roundMoney('-0.015', 2)).toBe('-0.02');
  });
});

/**
 * Property-style check of half-even rounding against an independent integer implementation (BigInt), over many
 * pseudo-random amounts (a fixed seed, so a failure reproduces).
 */
describe('roundMoney (property)', () => {
  const SEED = 0x2f6b_1234;

  /** mulberry32: well-mixed 32-bit output (the low bits of a power-of-two LCG repeat with a short period). */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let value = Math.imul(state ^ (state >>> 15), 1 | state);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return (value ^ (value >>> 14)) >>> 0;
    };
  }

  /** Amounts with 5 decimals; one in four is an exact tie (…5000 below the rounding place) for `digits`. */
  function* amounts(count: number, digits: number): Generator<string> {
    const next = random(SEED + digits);
    for (let index = 0; index < count; index += 1) {
      const whole = next() % 1_000_000;
      let fraction = String(next() % 100_000).padStart(5, '0');
      if (next() % 4 === 0) fraction = `${fraction.slice(0, digits)}5${'0'.repeat(4 - digits)}`;
      yield `${next() % 4 === 0 ? '-' : ''}${whole}.${fraction}`;
    }
  }

  /** Reference: half-even rounding of a 5-decimal string to `digits` places with integer arithmetic only. */
  function referenceRound(amount: string, digits: number): string {
    const negative = amount.startsWith('-');
    const [whole = '0', fraction = ''] = amount.replace('-', '').split('.');
    const scaled = BigInt(whole + fraction.padEnd(5, '0'));
    const unit = 10n ** BigInt(5 - digits);
    let quotient = scaled / unit;
    const remainder = scaled % unit;
    if (remainder * 2n > unit || (remainder * 2n === unit && quotient % 2n === 1n)) quotient += 1n;
    const text = quotient.toString().padStart(digits + 1, '0');
    const result = digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
    return negative && quotient !== 0n ? `-${result}` : result;
  }

  it.each([0, 1, 2, 3])('should match integer half-even rounding to %i decimals on 2,000 amounts (seed %#)', (digits) => {
    for (const amount of amounts(2_000, digits)) {
      expect(roundMoney(amount, digits), `seed ${SEED + digits}, amount ${amount}`).toBe(referenceRound(amount, digits));
    }
  });

  it('should be idempotent, commutative and reversible on random amounts', () => {
    const list = [...amounts(300, 2)];
    for (let index = 1; index < list.length; index += 1) {
      const [a, b] = [list[index - 1] as string, list[index] as string];
      const rounded = roundMoney(a, 2);
      expect(roundMoney(rounded, 2)).toBe(rounded);
      expect(addMoney(a, b)).toBe(addMoney(b, a));
      expect(compareMoney(subtractMoney(addMoney(a, b), b), a)).toBe(0);
    }
  });
});
