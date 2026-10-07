import type { TranslationTree } from './resources.js';

// Suffixes are reserved for plurals: a key such as `step_two` is read as a plural form of `step`.
const ALL_PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
const PLURAL_SUFFIX = new RegExp(`_(${ALL_PLURAL_FORMS.join('|')})$`);

type Resources = Readonly<Record<string, Readonly<Record<string, TranslationTree>>>>;

/**
 * Every problem that would make one locale show a raw key: a key present in one locale only, or a plural key lacking a form
 * the locale's plural rules need (Arabic: zero, one, two, few, many, other; English: one, other). Empty when consistent.
 */
export function findMissingKeys(resources: Resources): string[] {
  const keysByLocale = Object.fromEntries(
    Object.entries(resources).map(([locale, tree]) => [locale, flatten(tree)]),
  );
  const allKeys = new Set(Object.values(keysByLocale).flatMap((keys) => [...keys].map(baseKey)));
  const problems: string[] = [];
  for (const [locale, keys] of Object.entries(keysByLocale)) {
    const bases = new Set([...keys].map(baseKey));
    const forms = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    for (const key of [...allKeys].sort()) {
      if (!bases.has(key)) {
        problems.push(`${locale}: missing ${key}`);
        continue;
      }
      // A plural set must be complete even beside a plain key: `t(key, { count })` would otherwise show the plain text.
      const isPlural = ALL_PLURAL_FORMS.some((form) => keys.has(`${key}_${form}`));
      if (!isPlural) continue;
      const missing = forms.filter((form) => !keys.has(`${key}_${form}`));
      if (missing.length > 0)
        problems.push(`${locale}: ${key} lacks plural forms ${missing.join(', ')}`);
    }
  }
  return problems;
}

function baseKey(key: string): string {
  return key.replace(PLURAL_SUFFIX, '');
}

function flatten(
  tree: Readonly<Record<string, TranslationTree | string>>,
  prefix = '',
): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') keys.add(path);
    else for (const nested of flatten(value, path)) keys.add(nested);
  }
  return keys;
}
