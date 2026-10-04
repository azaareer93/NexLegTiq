import { act, render, screen } from '@testing-library/react';
import { Button } from 'antd';
import dayjs from 'dayjs';
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
    </>
  );
}

const html = document.documentElement;

describe('LanguageProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    html.removeAttribute('dir');
    html.removeAttribute('lang');
  });

  it('should start in Arabic, right to left, everywhere', () => {
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('text').textContent).toBe('المدعي');
    expect(html.getAttribute('dir')).toBe('rtl');
    expect(html.getAttribute('lang')).toBe('ar');
    expect(screen.getByTestId('switch').className).toContain('ant-btn-rtl');
    expect(dayjs().locale()).toBe('ar');
  });

  it('should switch to English, left to right, remember it on this device and report the choice', () => {
    const onLocaleChange = vi.fn();
    render(
      <LanguageProvider onLocaleChange={onLocaleChange}>
        <Probe />
      </LanguageProvider>,
    );
    act(() => screen.getByTestId('switch').click());

    expect(screen.getByTestId('text').textContent).toBe('Plaintiff');
    expect(html.getAttribute('dir')).toBe('ltr');
    expect(html.getAttribute('lang')).toBe('en');
    expect(screen.getByTestId('switch').className).not.toContain('ant-btn-rtl');
    expect(dayjs().locale()).toBe('en');
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('en');
    expect(onLocaleChange).toHaveBeenCalledWith('en');
  });

  it('should prefer the user language, then the device choice, then Arabic', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    const { rerender, unmount } = render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('en');

    // Signing in brings the user's own language.
    rerender(
      <LanguageProvider userLocale="ar">
        <Probe />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('ar');
    unmount();

    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('ar');
  });

  it('should still work when the browser blocks storage', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(
      <LanguageProvider>
        <Probe />
      </LanguageProvider>,
    );
    expect(screen.getByTestId('locale').textContent).toBe('ar');
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('should refuse useLanguage outside the provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow('useLanguage must be used inside a LanguageProvider');
  });
});
