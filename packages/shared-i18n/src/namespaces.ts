/**
 * i18next namespaces, one JSON file per locale in `src/locales/{ar,en}/<namespace>.json`. Keys are written with the
 * namespace as their first segment (`errors.AUTH-001`, `enums.role.LAWYER`, `common.actions.save`): `nsSeparator` is `.`
 * too, and i18next treats the first segment as the namespace only when it is one of these.
 */
export const I18N_NAMESPACES = ['common', 'auth', 'errors', 'enums', 'legal', 'validation', 'shell'] as const;

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export const DEFAULT_NAMESPACE = 'common' satisfies I18nNamespace;
