import type { Locale } from '@nexlegtiq/shared-types';

import arAuth from './locales/ar/auth.json' with { type: 'json' };
import arCases from './locales/ar/cases.json' with { type: 'json' };
import arClients from './locales/ar/clients.json' with { type: 'json' };
import arCommon from './locales/ar/common.json' with { type: 'json' };
import arDocuments from './locales/ar/documents.json' with { type: 'json' };
import arEnums from './locales/ar/enums.json' with { type: 'json' };
import arErrors from './locales/ar/errors.json' with { type: 'json' };
import arLegal from './locales/ar/legal.json' with { type: 'json' };
import arParties from './locales/ar/parties.json' with { type: 'json' };
import arProfile from './locales/ar/profile.json' with { type: 'json' };
import arSessions from './locales/ar/sessions.json' with { type: 'json' };
import arSettings from './locales/ar/settings.json' with { type: 'json' };
import arShell from './locales/ar/shell.json' with { type: 'json' };
import arTasks from './locales/ar/tasks.json' with { type: 'json' };
import arTeam from './locales/ar/team.json' with { type: 'json' };
import arValidation from './locales/ar/validation.json' with { type: 'json' };
import enAuth from './locales/en/auth.json' with { type: 'json' };
import enCases from './locales/en/cases.json' with { type: 'json' };
import enClients from './locales/en/clients.json' with { type: 'json' };
import enCommon from './locales/en/common.json' with { type: 'json' };
import enDocuments from './locales/en/documents.json' with { type: 'json' };
import enEnums from './locales/en/enums.json' with { type: 'json' };
import enErrors from './locales/en/errors.json' with { type: 'json' };
import enLegal from './locales/en/legal.json' with { type: 'json' };
import enParties from './locales/en/parties.json' with { type: 'json' };
import enProfile from './locales/en/profile.json' with { type: 'json' };
import enSessions from './locales/en/sessions.json' with { type: 'json' };
import enSettings from './locales/en/settings.json' with { type: 'json' };
import enShell from './locales/en/shell.json' with { type: 'json' };
import enTasks from './locales/en/tasks.json' with { type: 'json' };
import enTeam from './locales/en/team.json' with { type: 'json' };
import enValidation from './locales/en/validation.json' with { type: 'json' };
import type { I18N_NAMESPACES, I18nNamespace } from './namespaces.js';

const en = {
  common: enCommon,
  auth: enAuth,
  errors: enErrors,
  enums: enEnums,
  legal: enLegal,
  validation: enValidation,
  shell: enShell,
  cases: enCases,
  clients: enClients,
  sessions: enSessions,
  documents: enDocuments,
  tasks: enTasks,
  parties: enParties,
  settings: enSettings,
  team: enTeam,
  profile: enProfile,
};
const ar = {
  common: arCommon,
  auth: arAuth,
  errors: arErrors,
  enums: arEnums,
  legal: arLegal,
  validation: arValidation,
  shell: arShell,
  cases: arCases,
  clients: arClients,
  sessions: arSessions,
  documents: arDocuments,
  tasks: arTasks,
  parties: arParties,
  settings: arSettings,
  team: arTeam,
  profile: arProfile,
};

/** Nested string tree of one namespace file. */
export interface TranslationTree {
  readonly [key: string]: string | TranslationTree;
}

/** Every locale's namespaces. Key parity between locales is enforced by `findMissingKeys` in the test target (CI). */
export const RESOURCES: Readonly<Record<Locale, Readonly<Record<I18nNamespace, TranslationTree>>>> =
  { ar, en };

// Typed `t()` keys come straight from the English files: no generator step to forget. Arabic has more plural forms, so its
// files are not the type source. Listing every namespace as the default (common first) types `t('legal.plaintiff')` from a
// plain `useTranslation()`; at runtime the default stays `common` and the first segment selects the namespace.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof I18N_NAMESPACES;
    nsSeparator: '.';
    resources: typeof en;
  }
}
