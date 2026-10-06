import type { Locale } from '@nexlegtiq/shared-types';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

import { NexProvider } from '../NexProvider';
import type { NexProviderProps } from '../NexProvider';
import { useFormat } from './Format';

afterEach(() => {
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
});

const AT = '2026-10-13T21:30:00Z'; // 14 Oct 00:30 in Hebron, 13 Oct 21:30 UTC

function formatIn(locale: Locale, settings: Omit<NexProviderProps, 'children' | 'userLocale'> = {}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NexProvider userLocale={locale} {...settings}>
      {children}
    </NexProvider>
  );
  return renderHook(() => useFormat(), { wrapper }).result.current;
}

describe('useFormat', () => {
  it('should format in the current language, in Hebron time with Western digits by default', () => {
    const format = formatIn('ar');
    expect(format.date(AT)).toBe('14/10/2026');
    expect(format.date(AT, 'long')).toBe('14 أكتوبر 2026');
    expect(format.time(AT)).toBe('12:30 ص');
    expect(format.dateTime(AT)).toBe('14/10/2026 12:30 ص');
    expect(format.relative('2026-10-12T21:30:00Z', AT)).toBe('أمس');
    expect(format.number('1234.5')).toBe('1,234.5');
    expect(format.money('1234.5', 'ILS')).toBe('\u200F1,234.50\u00A0₪');
  });

  it('should follow the user time zone and Arabic-Indic digits when set', () => {
    const format = formatIn('ar', { timeZone: 'UTC', digits: 'arab' });
    expect(format.date(AT)).toBe('١٣/١٠/٢٠٢٦');
    expect(format.time(AT)).toBe('٩:٣٠ م');
    expect(format.number(2, 0)).toBe('٢');
  });

  it('should format English with AM/PM and the currency symbol first', () => {
    const format = formatIn('en');
    expect(format.dateTime(AT)).toBe('14/10/2026 12:30 AM');
    expect(format.money('1000', 'USD')).toBe('$1,000.00');
  });
});

describe('useFormat memoisation', () => {
  it('should keep the same formatters across renders, and give new ones when a setting changes', () => {
    let digits: 'latn' | 'arab' = 'latn';
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NexProvider userLocale="ar" digits={digits}>
        {children}
      </NexProvider>
    );
    const { result, rerender } = renderHook(() => useFormat(), { wrapper });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    digits = 'arab';
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current.number(12)).toBe('١٢');
  });
});

describe('FormatSettingsProvider', () => {
  it('should fall back to Asia/Hebron when the saved time zone is not one the runtime knows', () => {
    const format = formatIn('en', { timeZone: 'Mars/Olympus' });
    expect(format.date(AT)).toBe('14/10/2026');
  });
});
