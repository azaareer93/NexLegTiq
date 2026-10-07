import { readdirSync, readFileSync } from 'node:fs';

import * as sharedTypes from '@nexlegtiq/shared-types';
import { ERROR_CODES, SUPPORTED_LOCALES } from '@nexlegtiq/shared-types';

import { createI18n } from './create-i18n.js';
import { findMissingKeys } from './missing-keys.js';
import { I18N_NAMESPACES } from './namespaces.js';
import { RESOURCES } from './resources.js';

const REPO = new URL('../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, REPO), 'utf8');

/** shared-types value lists and their `enums.<name>` key. */
const ENUM_LABELS = {
  JURISDICTIONS: 'jurisdiction',
  ACCOUNT_TYPES: 'accountType',
  OFFICE_LANGUAGES: 'officeLanguage',
  ROLES: 'role',
  PRIORITIES: 'priority',
} as const;
/** Value lists translated elsewhere (`errors.*`, `common.language.*`), or not shown to users yet (permissions, D-087). */
const LABELLED_ELSEWHERE = ['ERROR_CODES', 'SUPPORTED_LOCALES', 'PERMISSIONS'];

describe('findMissingKeys', () => {
  it('should find a key that exists in one locale only, at any depth', () => {
    const problems = findMissingKeys({
      ar: { common: { a: 'أ', nested: { b: 'ب' } } },
      en: { common: { a: 'A', nested: { b: 'B', c: 'C' } }, extra: { d: 'D' } },
    });
    expect(problems).toEqual(['ar: missing common.nested.c', 'ar: missing extra.d']);
  });

  it('should require every plural form of each locale', () => {
    const problems = findMissingKeys({
      ar: { common: { n_one: 'واحد', n_other: '{{count}}' } },
      en: { common: { n_one: 'one' } },
    });
    expect(problems).toEqual([
      'ar: common.n lacks plural forms few, many, two, zero',
      'en: common.n lacks plural forms other',
    ]);
  });

  it('should require the plural forms even beside a plain key', () => {
    expect(findMissingKeys({ ar: { c: { k: 'ك' } }, en: { c: { k: 'K', k_one: 'one' } } })).toEqual(
      ['en: c.k lacks plural forms other'],
    );
  });

  it('should accept a plural key against a plain key of the other locale only with all forms', () => {
    expect(
      findMissingKeys({ ar: { c: { k: 'ك' } }, en: { c: { k_one: 'one', k_other: 'other' } } }),
    ).toEqual([]);
  });
});

describe('translation resources', () => {
  it('should have the same keys and every plural form in Arabic and English (CI fails otherwise)', () => {
    expect(findMissingKeys(RESOURCES)).toEqual([]);
  });

  it('should have one file per namespace in each locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(RESOURCES[locale]).sort()).toEqual([...I18N_NAMESPACES].sort());
      const files = readdirSync(new URL(`./locales/${locale}/`, import.meta.url)).map((file) =>
        file.replace(/\.json$/, ''),
      );
      expect(files.sort()).toEqual([...I18N_NAMESPACES].sort());
    }
  });

  it.each(SUPPORTED_LOCALES)(
    'should translate every API error code, language and enum value in %s',
    (locale) => {
      const i18n = createI18n(locale);
      const missing = [
        ...ERROR_CODES.map((code) => `errors.${code}`),
        ...SUPPORTED_LOCALES.map((value) => `common.language.${value}`),
        ...Object.entries(ENUM_LABELS).flatMap(([list, name]) =>
          (sharedTypes[list as keyof typeof ENUM_LABELS] as readonly string[]).map(
            (value) => `enums.${name}.${value}`,
          ),
        ),
      ].filter((key) => !i18n.exists(key, { lng: locale, fallbackLng: false }));
      expect(missing).toEqual([]);
    },
  );

  it('should know every value list shared-types exports, so a new enum gets labels', () => {
    const lists = Object.entries(sharedTypes)
      .filter(
        ([, value]) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
      )
      .map(([name]) => name);
    expect(
      lists.filter((name) => !(name in ENUM_LABELS) && !LABELLED_ELSEWHERE.includes(name)),
    ).toEqual([]);
  });

  it('should not give common a top-level key named like a namespace (it would be read as that namespace)', () => {
    const namespaces: readonly string[] = I18N_NAMESPACES;
    expect(Object.keys(RESOURCES.en.common).filter((key) => namespaces.includes(key))).toEqual([]);
  });

  it('should have a key for every validation message the contracts and the API send', () => {
    const sources = ['packages/shared-contracts/src/', 'apps/backend-api/src/modules/'].flatMap(
      (dir) =>
        readdirSync(new URL(dir, REPO), { recursive: true, encoding: 'utf8' })
          .filter((file) => file.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(file))
          .map((file) => read(`${dir}${file.replaceAll('\\', '/')}`)),
    );
    const keyPattern = /['"`](validation\.[\w.]+)['"`]/g;
    const used = new Set(
      sources.flatMap((source) => [...source.matchAll(keyPattern)].map((match) => match[1] ?? '')),
    );
    expect(used.size).toBeGreaterThan(10);
    const i18n = createI18n('en');
    expect([...used].filter((key) => !i18n.exists(key))).toEqual([]);
  });

  it('should use the glossary Arabic term (its first alternative) for every glossary row (legal terms and role labels)', () => {
    const rows = read('docs/context/glossary.md')
      .split('\n')
      .filter(
        (line) =>
          line.startsWith('| ') && !line.startsWith('| English') && !line.startsWith('|---'),
      );
    const terms = rows.map((row) => (row.split('|')[2] ?? '').split('/')[0]?.trim() ?? '');
    expect(terms.length).toBeGreaterThan(30);
    const arabic = new Set([
      ...flattenValues(RESOURCES.ar.legal),
      ...flattenValues(RESOURCES.ar.enums),
    ]);
    expect(terms.filter((term) => !arabic.has(term))).toEqual([]);
  });
});

describe('createI18n', () => {
  it('should resolve the namespace from the first key segment', () => {
    const i18n = createI18n('en');
    expect(i18n.t('errors.AUTH-001')).toBe('The email or password is incorrect.');
    expect(i18n.t('enums.role.LAWYER')).toBe('Lawyer');
    expect(i18n.t('common.actions.save')).toBe('Save');
    expect(i18n.t('actions.save')).toBe('Save');
  });

  it('should default to Arabic and switch language', async () => {
    const i18n = createI18n();
    expect(i18n.language).toBe('ar');
    expect(i18n.t('legal.plaintiff')).toBe('المدعي');
    await i18n.changeLanguage('en');
    expect(i18n.t('legal.plaintiff')).toBe('Plaintiff');
  });

  it('should apply the six Arabic plural forms', () => {
    const i18n = createI18n('ar');
    expect([0, 1, 2, 3, 11, 100].map((count) => i18n.t('common.fileCount', { count }))).toEqual([
      'لا توجد ملفات',
      'ملف واحد',
      'ملفان',
      '3 ملفات',
      '11 ملفًا',
      '100 ملف',
    ]);
    expect(createI18n('en').t('common.fileCount', { count: 2 })).toBe('2 cases');
  });
});

function flattenValues(tree: object): string[] {
  return Object.values(tree).flatMap((value: unknown) =>
    typeof value === 'string' ? [value] : flattenValues(value as object),
  );
}
