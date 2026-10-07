import {
  DEFAULT_TIME_ZONE,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelative,
  formatTime,
} from '@nexlegtiq/shared-utils';
import type { DigitSystem, FormatOptions } from '@nexlegtiq/shared-utils';
import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';

import { useLanguage } from '../LanguageProvider';

export interface FormatSettings {
  /** The zone the user reads dates in (the user's, else the office's; D-092). Defaults to Asia/Hebron. */
  readonly timeZone?: string;
  /** Western digits unless the user prefers Arabic-Indic. */
  readonly digits?: DigitSystem;
}

const FormatSettingsContext = createContext<FormatSettings>({});

/** A zone the runtime knows; anything else (a bad saved setting) must not break every page, so it falls back. */
function knownZone(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** The user's time zone and digit preference for `useFormat` (set by `NexProvider`). */
export function FormatSettingsProvider({
  timeZone,
  digits,
  children,
}: FormatSettings & { readonly children: ReactNode }): React.JSX.Element {
  const value = useMemo(() => ({ timeZone: knownZone(timeZone), digits }), [timeZone, digits]);
  return <FormatSettingsContext.Provider value={value}>{children}</FormatSettingsContext.Provider>;
}

type DateInput = Date | string | number;

export interface Formatters {
  /** 13/10/2026 (`long`: 13 أكتوبر 2026 / 13 October 2026). */
  readonly date: (value: DateInput, style?: 'short' | 'long') => string;
  /** 3:05 م / 3:05 PM. */
  readonly time: (value: DateInput) => string;
  /** 13/10/2026 3:05 م. */
  readonly dateTime: (value: DateInput) => string;
  /** أمس / yesterday, قبل 3 أيام / 3 days ago. */
  readonly relative: (value: DateInput, now?: DateInput) => string;
  readonly number: (value: number | string, maximumFractionDigits?: number) => string;
  /** An API amount (decimal string) in its currency. */
  readonly money: (amount: string, currency: string) => string;
}

/**
 * Formatters bound to the current language, the user's time zone and digit preference (MVP-46, D-092). They return plain
 * text. In running text: money and long dates are already in the reading direction — wrap them in `<Bdi>` at most, never
 * `<Ltr>` (that would put the ₪ on the wrong side and read an Arabic date backwards); `<Ltr>` is for file numbers, phones,
 * emails and a short date next to Latin text. In plain-text contexts (titles, `aria-label`s) use `isolate`/`isolateLtr`.
 */
export function useFormat(): Formatters {
  const { locale } = useLanguage();
  const { timeZone = DEFAULT_TIME_ZONE, digits = 'latn' } = useContext(FormatSettingsContext);
  return useMemo(() => {
    const options: FormatOptions = { locale, timeZone, digits };
    return {
      date: (value, style = 'short') => formatDate(value, { ...options, style }),
      time: (value) => formatTime(value, options),
      dateTime: (value) => formatDateTime(value, options),
      relative: (value, now) => formatRelative(value, { ...options, now }),
      number: (value, maximumFractionDigits) =>
        formatNumber(value, { ...options, maximumFractionDigits }),
      money: (amount, currency) => formatMoney(amount, currency, options),
    };
  }, [locale, timeZone, digits]);
}
