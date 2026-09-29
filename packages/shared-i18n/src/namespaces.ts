/** i18next namespaces. Resources for `ar` and `en` arrive with the i18n infrastructure story (MVP-44). */
export const I18N_NAMESPACES = ['common'] as const;

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];
