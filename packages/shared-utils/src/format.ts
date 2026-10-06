import type { Locale } from '@nexlegtiq/shared-types';
import { Decimal } from 'decimal.js';

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
 * ES2023 Intl, in every runtime we support (Node 22, current browsers) but not in TypeScript's `es2022` lib that the
 * workspace compiles with: half-even rounding, and decimal strings formatted exactly (no float on the way).
 */
type ExactNumberFormatOptions = Intl.NumberFormatOptions & { readonly roundingMode?: 'halfEven' };
const numberFormat = (locale: string, options: ExactNumberFormatOptions): Intl.NumberFormat => new Intl.NumberFormat(locale, options);
const formatExact = (format: Intl.NumberFormat, decimal: string): string => format.format(decimal as unknown as number);

/**
 * The Intl locale: the UI language with the digit system pinned. Plain `ar` uses MSA month names (أكتوبر) everywhere
 * (owner's choice, D-092); the numbering system is always explicit, as engines disagree on Arabic's default.
 */
const intlLocale = ({ locale, digits = 'latn' }: FormatOptions) => `${locale}-u-nu-${digits}`;

function toDate(value: DateInput): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Not a valid date: ${String(value)}`);
  }
  return date;
}

/** Western digits to Arabic-Indic (U+0660–0669; other characters unchanged). */
export const toArabicIndicDigits = (text: string): string => text.replace(/[0-9]/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));
/** Arabic-Indic (U+0660) and Persian (U+06F0) digits back to Western, for what a user typed: the low nibble is the digit. */
export const toWesternDigits = (text: string): string => text.replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) & 0xf));

/**
 * `dd/MM/yyyy` in both languages (frontend.md), in `timeZone`, whatever the locale's own pattern; the digits follow the
 * preference. `style: 'long'` writes the month (13 أكتوبر 2026 / 13 October 2026).
 */
export function formatDate(value: DateInput, options: FormatOptions & { readonly style?: 'short' | 'long' }): string {
  const date = toDate(value);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  if (options.style === 'long') {
    // English in day-month order like the short form (13 October 2026), not the US month-first default.
    const locale = options.locale === 'en' ? `en-GB-u-nu-${options.digits ?? 'latn'}` : intlLocale(options);
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone }).format(date);
  }
  // British English writes exactly dd/MM/yyyy with Western digits; the digit preference is applied after.
  const text = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone }).format(date);
  return options.digits === 'arab' ? toArabicIndicDigits(text) : text;
}

/** The time of day: 12-hour with ص/م in Arabic, AM/PM in English. */
export function formatTime(value: DateInput, options: FormatOptions): string {
  return new Intl.DateTimeFormat(intlLocale(options), {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
  }).format(toDate(value));
}

/** `dd/MM/yyyy` and the time, e.g. 13/10/2026 3:00 م. */
export function formatDateTime(value: DateInput, options: FormatOptions): string {
  return `${formatDate(value, options)} ${formatTime(value, options)}`;
}

const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/**
 * "3 days ago" / "منذ 3 أيام", "tomorrow" / "غدًا" (Intl handles Arabic's dual and plural forms). The largest unit that
 * fits; under a minute is "now". `now` is a parameter so callers and tests control the clock.
 */
export function formatRelative(value: DateInput, options: FormatOptions & { readonly now?: DateInput }): string {
  const seconds = Math.round((toDate(value).getTime() - toDate(options.now ?? Date.now()).getTime()) / 1000);
  const format = new Intl.RelativeTimeFormat(intlLocale(options), { numeric: 'auto' });
  const [unit, size] = RELATIVE_UNITS.find(([, length]) => Math.abs(seconds) >= length) ?? ['second', 1];
  return format.format(unit === 'second' ? 0 : Math.trunc(seconds / size), unit);
}

/** A number in the user's language and digits; strings keep their exact decimals (no float rounding on the way). */
export function formatNumber(value: number | string, options: FormatOptions & { readonly maximumFractionDigits?: number }): string {
  const format = numberFormat(intlLocale(options), { maximumFractionDigits: options.maximumFractionDigits ?? 3, roundingMode: 'halfEven' });
  return typeof value === 'string' ? formatExact(format, new Decimal(value).toFixed()) : format.format(value);
}

/**
 * An amount from the API (a decimal string, D-017) in its currency: the currency's own minor digits (ILS 2, JOD 3) with
 * half-even rounding, the symbol and its position from the locale. Never goes through a JS float.
 */
export function formatMoney(amount: string, currency: string, options: FormatOptions): string {
  const format = numberFormat(intlLocale(options), { style: 'currency', currency, roundingMode: 'halfEven' });
  return formatExact(format, new Decimal(amount).toFixed());
}
