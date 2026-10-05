import { act, render, screen } from '@testing-library/react';
import { Button, Empty } from 'antd';
import dayjs from 'dayjs';
import { StrictMode } from 'react';
import { useTranslation } from 'react-i18next';

import { LANGUAGE_STORAGE_KEY, LanguageProvider, useLanguage } from './LanguageProvider';

function Probe(): React.JSX.Element {
  const { t } = useTranslation();
  const { locale, setLocale } = useLanguage();
  return (
    <>
      <span data-testid="text">{t('legal.plaintiff')}</span>
      <span data-testid="locale">{locale}</span>
      <Button data-testid="switch" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}>
        {t('common.language.label')}
      </Button>
      <Empty />
    </>
  );
}

const html = document.documentElement;
const text = (testId: string) => screen.getByTestId(testId).textContent;

describe('LanguageProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    html.removeAttribute('dir');
    html.removeAttribute('lang');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dayjs.locale('en');
  });

  it('should start in Arabic, right to left, everywhere: page, i18next, AntD and dayjs', () => {
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(text('text')).toBe('المدعي');
    expect(html.getAttribute('dir')).toBe('rtl');
    expect(html.getAttribute('lang')).toBe('ar');
    expect(screen.getByTestId('switch').className).toContain('ant-btn-rtl');
    expect(screen.getAllByText('لا توجد بيانات').length).toBeGreaterThan(0);
    expect(dayjs('2026-01-15').format('MMMM D')).toBe('يناير 15');
  });

  it('should switch to English, left to right, remember the pick on this device and report it', () => {
    const onLocaleChange = vi.fn();
    render(
      <LanguageProvider onLocaleChange={onLocaleChange}>
        <Probe />
      </LanguageProvider>,
    );
    act(() => screen.getByTestId('switch').click());

    expect(text('text')).toBe('Plaintiff');
    expect(html.getAttribute('dir')).toBe('ltr');
    expect(html.getAttribute('lang')).toBe('en');
    expect(screen.getByTestId('switch').className).not.toContain('ant-btn-rtl');
    expect(screen.getAllByText('No data').length).toBeGreaterThan(0);
    expect(dayjs('2026-01-15').format('MMMM')).toBe('January');
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(onLocaleChange).toHaveBeenCalledWith('en');
  });

  it('should prefer the user language, then the device choice, then Arabic', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    const { unmount } = render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(text('locale')).toBe('en');
    unmount();

    render(
      <LanguageProvider userLocale="ar">
        <Probe />
      </LanguageProvider>,
    ).unmount();
    expect(html.getAttribute('lang')).toBe('ar');

    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(text('locale')).toBe('ar');
  });

  it('should follow the signed-in user without saving their language on the device, and keep it after sign-out', () => {
    const onLocaleChange = vi.fn();
    const tree = (userLocale: 'ar' | 'en' | null) => (
      <LanguageProvider userLocale={userLocale} onLocaleChange={onLocaleChange}>
        <Probe />
      </LanguageProvider>
    );
    const { rerender } = render(tree(null));
    expect(text('locale')).toBe('ar');

    rerender(tree('en'));
    expect(text('locale')).toBe('en');
    expect(text('text')).toBe('Plaintiff');
    expect(html.getAttribute('dir')).toBe('ltr');

    rerender(tree(null));
    expect(text('locale')).toBe('en');
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    expect(onLocaleChange).not.toHaveBeenCalled();
  });

  it('should behave the same under StrictMode', () => {
    render(
      <StrictMode>
        <LanguageProvider userLocale="en">
          <Probe />
        </LanguageProvider>
      </StrictMode>,
    );
    expect(text('text')).toBe('Plaintiff');
    expect(html.getAttribute('dir')).toBe('ltr');
    expect(html.getAttribute('lang')).toBe('en');
  });

  it('should still work when the browser blocks storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(text('locale')).toBe('ar');
    act(() => screen.getByTestId('switch').click());
    expect(text('locale')).toBe('en');
  });

  it('should refuse useLanguage outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow('useLanguage must be used inside a LanguageProvider');
  });
});
