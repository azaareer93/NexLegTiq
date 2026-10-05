import type { Locale } from '@nexlegtiq/shared-types';
import type { ThemeConfig } from 'antd';

/**
 * Font stacks (D-088). Inter comes first in both languages, so Latin text and Western digits look the same everywhere; it
 * has no Arabic glyphs, so Arabic falls through to IBM Plex Sans Arabic. Both are self-hosted (see `fonts.ts`).
 */
export const FONT_FAMILY = {
  en: "'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  ar: "'Inter Variable', 'IBM Plex Sans Arabic', Tahoma, 'Segoe UI', system-ui, sans-serif",
} as const satisfies Record<Locale, string>;

/** Brand colours from frontend.md#theme; components use AntD tokens, never these values directly. */
export const BRAND = {
  primary: '#1a3c6e',
  primaryHover: '#2a5a9c',
  primaryBg: '#e6edf5',
  success: '#2e7d32',
  warning: '#ed6c02',
  error: '#d32f2f',
  info: '#0288d1',
  bgBase: '#ffffff',
  bgLayout: '#f8f9fa',
  text: '#1a2332',
  textSecondary: '#5a6a7e',
  border: '#d9e1ec',
} as const;

const BASE_TOKENS = {
  colorPrimary: BRAND.primary,
  colorPrimaryHover: BRAND.primaryHover,
  colorPrimaryBg: BRAND.primaryBg,
  colorSuccess: BRAND.success,
  colorWarning: BRAND.warning,
  colorError: BRAND.error,
  colorInfo: BRAND.info,
  colorBgBase: BRAND.bgBase,
  // frontend.md's "container" grey is the page behind cards: AntD calls that colorBgLayout. colorBgContainer stays white,
  // since AntD uses it for inputs, cards, tables and default buttons.
  colorBgLayout: BRAND.bgLayout,
  colorBgContainer: BRAND.bgBase,
  colorTextBase: BRAND.text,
  colorTextSecondary: BRAND.textSecondary,
  colorBorder: BRAND.border,
  fontSizeHeading1: 28,
  fontSizeHeading2: 24,
  fontSizeHeading3: 20,
  fontSizeHeading4: 18,
  fontSizeHeading5: 16,
  borderRadius: 8,
  borderRadiusLG: 12,
  borderRadiusSM: 4,
  controlHeight: 40,
  controlHeightLG: 48,
  controlHeightSM: 32,
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04)',
  boxShadowSecondary: '0 4px 12px rgba(0, 0, 0, 0.08)',
} as const satisfies ThemeConfig['token'];

/** Arabic script needs one pixel more and a taller line to stay legible (frontend.md#theme). */
const TYPOGRAPHY: Record<Locale, { fontSize: number; lineHeight: number }> = {
  en: { fontSize: 14, lineHeight: 1.5715 },
  ar: { fontSize: 15, lineHeight: 1.8 },
};

/** The NexLegTiq AntD theme for a language. */
export function nexTheme(locale: Locale): ThemeConfig {
  return {
    cssVar: { prefix: 'nlq' },
    token: { ...BASE_TOKENS, fontFamily: FONT_FAMILY[locale], ...TYPOGRAPHY[locale] },
  };
}
