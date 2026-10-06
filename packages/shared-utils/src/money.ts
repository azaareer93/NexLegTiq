import { Decimal } from 'decimal.js';

/**
 * Money math on decimal.js (D-017): never JS floats. Amounts are decimal strings (as the API sends them); results are
 * decimal strings too. Rounding is half-even ("banker's"), so rounding many line items does not drift upwards.
 */
const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

type Amount = string | Decimal;

const of = (value: Amount): Decimal => {
  const decimal = new Money(value);
  if (!decimal.isFinite()) {
    throw new RangeError(`Not a finite amount: ${String(value)}`);
  }
  return decimal;
};

/** Minor digits of a currency (ILS 2, JOD 3, JPY 0), from the runtime's ISO-4217 data. */
export function currencyDigits(currency: string): number {
  const fraction = new Intl.NumberFormat('en', { style: 'currency', currency }).formatToParts(1).find((part) => part.type === 'fraction');
  return fraction?.value.length ?? 0;
}

export const addMoney = (...amounts: readonly Amount[]): string => amounts.reduce<Decimal>((sum, amount) => sum.plus(of(amount)), new Money(0)).toFixed();

export const subtractMoney = (amount: Amount, ...minus: readonly Amount[]): string =>
  minus.reduce<Decimal>((rest, value) => rest.minus(of(value)), of(amount)).toFixed();

/** `amount × factor` (hours × rate, quantity × price), unrounded: round once, at the end, with `roundMoney`. */
export const multiplyMoney = (amount: Amount, factor: Amount): string => of(amount).times(of(factor)).toFixed();

/** `percent` % of `amount` (tax, discount), unrounded. */
export const percentOf = (amount: Amount, percent: Amount): string => of(amount).times(of(percent)).dividedBy(100).toFixed();

/** Rounds half-even to `digits` decimals, or to the currency's minor digits. */
export function roundMoney(amount: Amount, digitsOrCurrency: number | string = 2): string {
  const digits = typeof digitsOrCurrency === 'string' ? currencyDigits(digitsOrCurrency) : digitsOrCurrency;
  return of(amount).toDecimalPlaces(digits, Decimal.ROUND_HALF_EVEN).toFixed(digits);
}

/** Compares two amounts: -1, 0 or 1. */
export const compareMoney = (left: Amount, right: Amount): -1 | 0 | 1 => of(left).comparedTo(of(right)) as -1 | 0 | 1;
