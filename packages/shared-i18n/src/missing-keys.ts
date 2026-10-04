import type { TranslationTree } from './resources.js';

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

type Resources = Readonly<Record<string, Readonly<Record<string, TranslationTree>>>>;

/**
 * Every problem that would make one locale show a raw key: a key present in one locale only, or a plural key lacking a form
 * the locale's plural rules need (Arabic: zero, one, two, few, many, other; English: one, other). Empty when consistent.
 */
export function findMissingKeys(resources: Resources): string[] {
  const keysByLocale = Object.fromEntries(Object.entries(resources).map(([locale, tree]) => [locale, flatten(tree)]));
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
      if (keys.has(key)) continue;
      const missing = forms.filter((form) => !keys.has(`${key}_${form}`));
      if (missing.length > 0) problems.push(`${locale}: ${key} lacks plural forms ${missing.join(', ')}`);
    }
  }
  return problems;
}

function baseKey(key: string): string {
  return key.replace(PLURAL_SUFFIX, '');
}

function flatten(tree: Readonly<Record<string, TranslationTree | string>>, prefix = ''): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') keys.add(path);
    else for (const nested of flatten(value, path)) keys.add(nested);
  }
  return keys;
}
