import { Decimal } from 'decimal.js';

/**
 * Money math on decimal.js (D-017): never JS floats. Amounts are decimal strings (as the API sends them); results are
 * decimal strings too. Rounding is half-even ("banker's"), so rounding many line items does not drift upwards.
 */
const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

type Amount = string | Decimal;

/**
 * Only a plain decimal is an amount: optional minus, up to 30 integer and 20 fraction digits. decimal.js alone would also
 * take `1e200000000` (writing it out freezes the page), hex/binary/octal (`0x10` is 16), `NaN` and `Infinity`.
 */
const PLAIN_DECIMAL = /^-?\d{1,30}(\.\d{1,20})?$/;

/** Parses an amount strictly (see `PLAIN_DECIMAL`); a `RangeError` otherwise. */
export function parseAmount(value: Amount): Decimal {
  if (typeof value === 'string' && !PLAIN_DECIMAL.test(value)) {
    throw new RangeError(`Not a decimal amount: ${value.slice(0, 40)}`);
  }
  const decimal = new Money(value);
  if (!decimal.isFinite()) {
    throw new RangeError('Not a finite amount');
  }
  return decimal;
}

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const digitsByCurrency = new Map<string, number>();

/** Minor digits of an ISO-4217 currency (ILS 2, JOD 3, JPY 0); an unknown code is a `RangeError`, not a silent default. */
export function currencyDigits(currency: string): number {
  let digits = digitsByCurrency.get(currency);
  if (digits === undefined) {
    if (!CURRENCIES.has(currency)) {
      throw new RangeError(`Unknown currency: ${currency.slice(0, 10)}`);
    }
    const fraction = new Intl.NumberFormat('en', { style: 'currency', currency })
      .formatToParts(1)
      .find((part) => part.type === 'fraction');
    digits = fraction?.value.length ?? 0;
    digitsByCurrency.set(currency, digits);
  }
  return digits;
}

export const addMoney = (...amounts: readonly Amount[]): string =>
  amounts.reduce<Decimal>((sum, amount) => sum.plus(parseAmount(amount)), new Money(0)).toFixed();

export const subtractMoney = (amount: Amount, ...minus: readonly Amount[]): string =>
  minus
    .reduce<Decimal>((rest, value) => rest.minus(parseAmount(value)), parseAmount(amount))
    .toFixed();

/** `amount × factor` (hours × rate, quantity × price), unrounded: round once, at the end, with `roundMoney`. */
export const multiplyMoney = (amount: Amount, factor: Amount): string =>
  parseAmount(amount).times(parseAmount(factor)).toFixed();

/** `percent` % of `amount` (tax, discount), unrounded. */
export const percentOf = (amount: Amount, percent: Amount): string =>
  parseAmount(amount).times(parseAmount(percent)).dividedBy(100).toFixed();

/** Rounds half-even to `digits` decimals, or to the currency's minor digits. Never returns "-0.00". */
export function roundMoney(amount: Amount, digitsOrCurrency: number | string = 2): string {
  const digits =
    typeof digitsOrCurrency === 'string' ? currencyDigits(digitsOrCurrency) : digitsOrCurrency;
  const rounded = parseAmount(amount).toDecimalPlaces(digits, Decimal.ROUND_HALF_EVEN);
  return (rounded.isZero() ? rounded.abs() : rounded).toFixed(digits);
}

/** Compares two amounts: -1, 0 or 1. */
export const compareMoney = (left: Amount, right: Amount): -1 | 0 | 1 =>
  parseAmount(left).comparedTo(parseAmount(right)) as -1 | 0 | 1;
