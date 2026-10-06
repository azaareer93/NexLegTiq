import type { Locale } from '@nexlegtiq/shared-types';

import { parseAmount, roundMoney } from './money.js';

/** Western (0-9) by default; Arabic-Indic (٠-٩) as a user preference (frontend.md, D-092). */
export type DigitSystem = 'latn' | 'arab';

/** The default time zone of offices in the launch market (`Office.timezone` default). */
export const DEFAULT_TIME_ZONE = 'Asia/Hebron';

export interface FormatOptions {
  readonly locale: Locale;
  /** IANA zone the user reads dates in; every instant is shown in it, never in the device's own zone. */
  readonly timeZone?: string;
  readonly digits?: DigitSystem;
}

type DateInput = Date | string | number;

/**
 * Intl formatters are costly to build (≈0.3 ms each) and cheap to reuse; the combinations (locale × zone × currency) are
 * few, so they are kept for the page's lifetime.
 */
const formatters = new Map<string, unknown>();
function cached<T>(key: string, make: () => T): T {
  let formatter = formatters.get(key) as T | undefined;
  if (formatter === undefined) {
    formatter = make();
    formatters.set(key, formatter);
  }
  return formatter;
}
const dateTimeFormat = (locale: string, options: Intl.DateTimeFormatOptions) =>
  cached(`dt|${locale}|${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(locale, options));

/** `signDisplay: 'negative'` (ES2023, typed here: the workspace compiles with the es2022 lib) never prints "-0.00". */
type NumberOptions = Omit<Intl.NumberFormatOptions, 'signDisplay'> & { readonly signDisplay: 'negative' };
const numberFormat = (locale: string, options: NumberOptions) =>
  cached(`nf|${locale}|${JSON.stringify(options)}`, () => new Intl.NumberFormat(locale, options as unknown as Intl.NumberFormatOptions));
/**
 * Formats an already-rounded decimal string. Engines with ES2023 Intl format the string exactly; older ones (e.g. Firefox
 * 115 ESR) convert it to a float first, which is harmless once it is rounded to its final digits.
 */
const formatRounded = (format: Intl.NumberFormat, rounded: string): string => format.format(rounded as unknown as number);

/**
 * The Intl locale: the UI language with the digit system pinned. Plain `ar` uses MSA month names (أكتوبر) everywhere
 * (owner's choice, D-092); the numbering system is always explicit, as engines disagree on Arabic's default.
 */
const intlLocale = (locale: string, digits: DigitSystem = 'latn') => `${locale}-u-nu-${digits}`;

/** `YYYY-MM-DD`: a calendar date (a deadline), not an instant — shown as written, whatever the zone. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A date and time without `Z` or an offset: `new Date` would read it in the machine's own zone, so it is refused. */
const ZONELESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

function toDate(value: DateInput): Date {
  if (typeof value === 'string' && ZONELESS_DATE_TIME.test(value)) {
    throw new RangeError(`A date and time needs a zone (Z or an offset): ${value}`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Not a valid date: ${String(value).slice(0, 40)}`);
  }
  return date;
}

/** A date-only string is read in UTC (where `new Date` placed it); an instant in the user's zone. */
const zoneFor = (value: DateInput, timeZone: string | undefined) =>
  typeof value === 'string' && DATE_ONLY.test(value) ? 'UTC' : (timeZone ?? DEFAULT_TIME_ZONE);

/** Western digits to Arabic-Indic (U+0660–0669; other characters unchanged). */
export const toArabicIndicDigits = (text: string): string => text.replace(/[0-9]/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));

/**
 * What a user typed, back to Western: Arabic-Indic (U+0660) and Persian (U+06F0) digits (the low nibble is the digit), the
 * Arabic decimal separator ٫ to "." and the thousands separator ٬ dropped, so "١٬٢٣٤٫٥٠" parses as "1234.50".
 */
export const toWesternDigits = (text: string): string =>
  text
    .replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) & 0xf))
    .replace(/٫/g, '.')
    .replace(/٬/g, '');

/**
 * `dd/MM/yyyy` in both languages (frontend.md), in `timeZone`, whatever the locale's own pattern; the digits follow the
 * preference. `style: 'long'` writes the month (13 أكتوبر 2026 / 13 October 2026).
 */
export function formatDate(value: DateInput, options: FormatOptions & { readonly style?: 'short' | 'long' }): string {
  const date = toDate(value);
  const timeZone = zoneFor(value, options.timeZone);
  if (options.style === 'long') {
    // English in day-month order like the short form (13 October 2026), not the US month-first default.
    const locale = intlLocale(options.locale === 'en' ? 'en-GB' : options.locale, options.digits);
    return dateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(date);
  }
  // British English writes exactly dd/MM/yyyy with Western digits; the digit preference is applied after.
  const text = dateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone }).format(date);
  return options.digits === 'arab' ? toArabicIndicDigits(text) : text;
}

/** The time of day: 12-hour with ص/م in Arabic, AM/PM in English. */
export function formatTime(value: DateInput, options: FormatOptions): string {
  return dateTimeFormat(intlLocale(options.locale, options.digits), {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
  }).format(toDate(value));
}

/** `dd/MM/yyyy` and the time, e.g. 13/10/2026 3:00 م. */
export function formatDateTime(value: DateInput, options: FormatOptions): string {
  return `${formatDate(value, options)} ${formatTime(value, options)}`;
}

/** Days since 1970-01-01 of the calendar date `date` falls on in `timeZone`. */
function dayNumber(date: Date, timeZone: string): number {
  const [year, month, day] = dateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone })
    .format(date)
    .split('-')
    .map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

/**
 * "3 days ago" / "قبل 3 أيام", "tomorrow" / "غدًا" (Intl handles Arabic's dual and plural forms). Within the same calendar day
 * in the user's zone: minutes or hours ("now" under a minute). Otherwise **calendar days**, so a hearing at 05:00 the day
 * after tomorrow, seen at 17:00 today, is "بعد غد" — never "tomorrow" because it is 36 hours away. Days up to 13 (deadlines
 * are counted in days), then weeks, months and years. `now` is a parameter so callers and tests control the clock.
 */
export function formatRelative(value: DateInput, options: FormatOptions & { readonly now?: DateInput }): string {
  const target = toDate(value);
  const now = toDate(options.now ?? Date.now());
  const timeZone = zoneFor(value, options.timeZone);
  const format = cached(`rt|${options.locale}|${options.digits ?? 'latn'}`, () =>
    new Intl.RelativeTimeFormat(intlLocale(options.locale, options.digits), { numeric: 'auto' }),
  );
  const days = dayNumber(target, timeZone) - dayNumber(now, timeZone);
  if (days === 0) {
    const seconds = (target.getTime() - now.getTime()) / 1000;
    if (Math.abs(seconds) < 60) return format.format(0, 'second');
    if (Math.abs(seconds) < 3600) return format.format(Math.trunc(seconds / 60), 'minute');
    return format.format(Math.trunc(seconds / 3600), 'hour');
  }
  if (Math.abs(days) <= 13) return format.format(days, 'day');
  if (Math.abs(days) < 60) return format.format(Math.round(days / 7), 'week');
  if (Math.abs(days) < 365) return format.format(Math.round(days / 30.44), 'month');
  return format.format(Math.round(days / 365.25), 'year');
}

/**
 * A number in the user's language and digits. A string is rounded half-even with decimal.js first, so the exact value is
 * kept and no engine float or rounding mode is involved.
 */
export function formatNumber(value: number | string, options: FormatOptions & { readonly maximumFractionDigits?: number }): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError('Not a finite number');
  }
  const digits = options.maximumFractionDigits ?? 3;
  const format = numberFormat(intlLocale(options.locale, options.digits), { maximumFractionDigits: digits, signDisplay: 'negative' });
  return typeof value === 'string' ? formatRounded(format, roundMoney(value, digits)) : format.format(value);
}

/**
 * An amount from the API (a decimal string, D-017) in its currency: rounded half-even to the currency's own minor digits
 * (ILS 2, JOD 3) with decimal.js, then laid out by Intl (symbol, its position, grouping, digits). Never "-0.00".
 */
export function formatMoney(amount: string, currency: string, options: FormatOptions): string {
  const rounded = roundMoney(parseAmount(amount), currency);
  const format = numberFormat(intlLocale(options.locale, options.digits), { style: 'currency', currency, signDisplay: 'negative' });
  return formatRounded(format, rounded);
}
