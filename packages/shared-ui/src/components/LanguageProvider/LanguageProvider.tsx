import { createI18n, DEFAULT_LOCALE } from '@nexlegtiq/shared-i18n';
import { isLocale } from '@nexlegtiq/shared-types';
import type { Locale } from '@nexlegtiq/shared-types';
import { textDirectionOf } from '@nexlegtiq/shared-utils';
import { ConfigProvider } from 'antd';
import arEG from 'antd/locale/ar_EG';
import enUS from 'antd/locale/en_US';
import dayjs from 'dayjs';
// Registers dayjs's Arabic names (months, weekdays, ص/م). Digits stay Western: Arabic-Indic digits need the
// preParsePostFormat plugin, which is not loaded (frontend.md: Western digits by default).
import 'dayjs/locale/ar';
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

/** Pre-login language choice. A convenience only: once signed in, the user's `uiLanguage` from the server wins. */
export const LANGUAGE_STORAGE_KEY = 'nlq.locale';

const ANTD_LOCALES = { ar: arEG, en: enUS } as const;

export interface LanguageContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export interface LanguageProviderProps {
  /** The signed-in user's language (server `uiLanguage`). When it changes, the UI follows. */
  readonly userLocale?: Locale | null;
  /** Called when the user picks a language, e.g. to save it to their profile. */
  readonly onLocaleChange?: (locale: Locale) => void;
  readonly children: ReactNode;
}

/**
 * Applies one language everywhere at once: `<html lang dir>` (so AntD portals, modals and popovers follow), i18next,
 * AntD's `ConfigProvider` (direction and component texts) and dayjs — before the browser paints, so nobody sees a frame in
 * the wrong direction. Order of choice: the user's language, then the last language picked on this device, then Arabic.
 * Only an explicit pick is remembered on the device: a signed-in user's language never becomes the next person's default
 * on a shared office computer. Signing out keeps the language on screen until the page reloads.
 */
export function LanguageProvider({ userLocale, onLocaleChange, children }: LanguageProviderProps): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => userLocale ?? readStoredLocale() ?? DEFAULT_LOCALE);
  const [i18n] = useState(() => createI18n(locale));

  // A new server language (sign-in, profile refetch) is adopted in the same render, not one paint later.
  const [seenUserLocale, setSeenUserLocale] = useState(userLocale);
  if (userLocale !== seenUserLocale) {
    setSeenUserLocale(userLocale);
    if (userLocale) setLocaleState(userLocale);
  }

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = textDirectionOf(locale);
    dayjs.locale(locale);
    void i18n.changeLanguage(locale);
  }, [i18n, locale]);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      storeLocale(next);
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <LanguageContext.Provider value={value}>
      <I18nextProvider i18n={i18n}>
        <ConfigProvider direction={textDirectionOf(locale)} locale={ANTD_LOCALES[locale]}>
          {children}
        </ConfigProvider>
      </I18nextProvider>
    </LanguageContext.Provider>
  );
}

/** The current language and a way to change it; only inside a `LanguageProvider`. */
export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error('useLanguage must be used inside a LanguageProvider');
  return value;
}

// Storage can be unavailable (private mode, blocked site data): the choice is then simply not remembered.
function readStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // Not remembered on this device; nothing else depends on it.
  }
}
