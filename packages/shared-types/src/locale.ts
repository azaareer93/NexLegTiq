export const SUPPORTED_LOCALES = ['ar', 'en'] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
