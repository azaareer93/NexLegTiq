import { SUPPORTED_LOCALES } from '@nexlegtiq/shared-types';
import type { Locale } from '@nexlegtiq/shared-types';
import i18next from 'i18next';
import type { i18n } from 'i18next';

import { DEFAULT_NAMESPACE, I18N_NAMESPACES } from './namespaces.js';
import { RESOURCES } from './resources.js';

/** Arabic is the default UI language (frontend.md). */
export const DEFAULT_LOCALE: Locale = 'ar';

/**
 * A ready i18next instance with every resource bundled (no HTTP backend: the bundles are small, and a screen never renders
 * raw keys while one loads). Plurals follow `Intl.PluralRules`, so Arabic gets zero/one/two/few/many/other.
 */
export function createI18n(locale: Locale = DEFAULT_LOCALE): i18n {
  const instance = i18next.createInstance();
  void instance.init({
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: [...I18N_NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    nsSeparator: '.',
    resources: RESOURCES,
    initAsync: false,
    // React escapes rendered text; escaping here too would show `&amp;` to the user.
    interpolation: { escapeValue: false },
  });
  return instance;
}
