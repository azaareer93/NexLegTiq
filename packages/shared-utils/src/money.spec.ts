import { addMoney, compareMoney, currencyDigits, multiplyMoney, percentOf, roundMoney, subtractMoney } from './money.js';

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

  it('should compare amounts', () => {
    expect([compareMoney('1.10', '1.1'), compareMoney('2', '10'), compareMoney('10', '2')]).toEqual([0, -1, 1]);
  });

  it('should refuse values that are not finite amounts', () => {
    expect(() => addMoney('abc')).toThrow();
    expect(() => addMoney('Infinity')).toThrow(RangeError);
    expect(() => roundMoney('NaN')).toThrow(RangeError);
  });
});

/**
 * Property-style check of half-even rounding against an independent integer implementation (BigInt), over many
 * pseudo-random amounts (a fixed seed, so a failure reproduces).
 */
describe('roundMoney (property)', () => {
  function* amounts(count: number): Generator<string> {
    let seed = 0x2f6b_1234;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed;
    };
    for (let index = 0; index < count; index += 1) {
      const whole = next() % 1_000_000;
      const fraction = String(next() % 100_000).padStart(5, '0');
      yield `${next() % 4 === 0 ? '-' : ''}${whole}.${fraction}`;
    }
  }

  /** Reference: half-even rounding of a decimal string to 2 places using integer arithmetic only. */
  function referenceRound(amount: string): string {
    const negative = amount.startsWith('-');
    const [whole = '0', fraction = ''] = amount.replace('-', '').split('.');
    const scaled = BigInt(whole + fraction.padEnd(5, '0')); // 5 decimals
    const unit = 1000n; // from 5 to 2 decimals
    let quotient = scaled / unit;
    const remainder = scaled % unit;
    if (remainder > 500n || (remainder === 500n && quotient % 2n === 1n)) quotient += 1n;
    const text = quotient.toString().padStart(3, '0');
    const result = `${text.slice(0, -2)}.${text.slice(-2)}`;
    return negative && quotient !== 0n ? `-${result}` : result;
  }

  it('should match integer half-even rounding on 5,000 amounts', () => {
    for (const amount of amounts(5_000)) {
      expect(roundMoney(amount, 2)).toBe(referenceRound(amount));
    }
  });

  it('should never let rounding then summing drift from summing then rounding by more than half a cent per line', () => {
    const lines = [...amounts(200)];
    const roundedSum = addMoney(...lines.map((line) => roundMoney(line, 2)));
    const exactSum = addMoney(...lines);
    const drift = Math.abs(Number(subtractMoney(roundedSum, exactSum)));
    expect(drift).toBeLessThanOrEqual(lines.length * 0.005);
  });
});
