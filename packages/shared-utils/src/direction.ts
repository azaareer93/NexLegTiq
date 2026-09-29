import type { Locale } from '@nexlegtiq/shared-types';

export type TextDirection = 'rtl' | 'ltr';

const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar']);

export function textDirectionOf(locale: Locale): TextDirection {
  return RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}
