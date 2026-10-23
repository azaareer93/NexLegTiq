import { Injectable } from '@nestjs/common';
import { normalizeArabic } from '@nexlegtiq/shared-utils';

import type { AiRedactor, Redacted, RedactionContext } from './redaction';

export type PiiKind = 'PARTY' | 'EMAIL' | 'PHONE' | 'IBAN' | 'ACCOUNT' | 'ID';

/** Invisible characters that may sit inside or between the parts of a value (bidi marks, joiners, soft hyphen). */
// An alternation, not a class: joiners inside a character class read as one joined character (and lint says so).
const INVISIBLE = '\\u00AD|\\u061C|\\u200C|\\u200D|\\u200E|\\u200F|\\u2060';
/** A space or an invisible character. */
const BLANK = `(?:[\\s\\u00A0]|${INVISIBLE})`;
/** Between digit groups: up to two spaces or invisibles, and one of - . ( ) — bounded, so matching stays linear. */
const SEP = `(?:${BLANK}{0,2}[-.()]?${BLANK}{0,2})`;
const NOT_BEFORE = '(?<![\\p{L}\\p{N}@])';
const NOT_AFTER = '(?![\\p{L}\\p{N}])';

/** Country codes of the markets we serve (PS, IL numbers used in PS, JO, EG, GCC, LB, IQ, MA) plus US/UK. */
const COUNTRY = '(?:970|972|962|966|971|965|974|968|973|961|964|212|20|44|1)';
/** Mobile prefixes: 059x / 056x (PS), 05x (IL, SA, AE), 07[789] (JO), 01[0125] (EG). */
const MOBILE = '0(?:5\\d|7[789]|1[0125])';

/**
 * Patterns in the order they run (on a copy with Western digits). Phones run before the digit groups (a mobile would
 * otherwise be an id), IBANs before them too. Every quantifier is bounded and every pattern anchored at its start, so a
 * 400,000-character text is scanned in linear time (the regexes are synchronous: a slow one would block the worker).
 */
const PATTERNS: readonly (readonly [Exclude<PiiKind, 'ACCOUNT' | 'ID'> | 'NUMBER', RegExp])[] = [
  [
    'EMAIL',
    /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.\p{L}{2,24}(?![\p{L}\p{N}])/gu,
  ],
  ['IBAN', /(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:[ \u00A0]?[A-Za-z0-9]){11,30}(?![A-Za-z0-9])/gu],
  [
    'PHONE',
    new RegExp(
      [
        // International: +970 59 123 4567, 00962-7-9123-4567, +1 (555) 123-4567.
        `${NOT_BEFORE}(?:\\+|00)${COUNTRY}${SEP}\\(?\\d{1,4}\\)?(?:${SEP}\\d){5,10}${NOT_AFTER}`,
        // Local mobiles: 059x / 056x (PS), 05x (IL, SA, AE), 07[789] (JO), 01[0125] (EG); any grouping (0599-123-456).
        `${NOT_BEFORE}(?:\\(${MOBILE}\\)|${MOBILE})(?:${SEP}\\d){6,8}${NOT_AFTER}`,
        // Local landlines: 02-2xx-xxxx (PS), (06) 5xx xxxx (JO), 02-xxxx-xxxx (EG).
        `${NOT_BEFORE}(?:\\(0[2-9]\\)|0[2-9])(?:${SEP}\\d){7,8}${NOT_AFTER}`,
      ].join('|'),
      'gu',
    ),
  ],
  // Ids and bank/card numbers, also in groups (4012-3456-7, 4111 1111 1111 1111): classified by their digit count.
  ['NUMBER', new RegExp(`${NOT_BEFORE}\\d(?:(?:[-.]|${BLANK})?\\d){8,18}${NOT_AFTER}`, 'gu')],
];

/** Letters a name may be written with interchangeably (hamza seats, alef forms, ta marbuta, Persian ya and kaf). */
const ARABIC_VARIANTS: Readonly<Record<string, string>> = {
  ا: 'اأإآٱء',
  ي: 'يىئی',
  ی: 'يىئی',
  ه: 'هة',
  و: 'وؤ',
  ك: 'كک',
  ک: 'كک',
};
/** Tashkeel, the dagger alef, tatweel and invisible characters may sit between any two letters. */
const MARKS = `(?:[\\u064B-\\u065F\\u0670\\u0640]|${INVISIBLE})*`;
/** Up to two attached particles: وأحمد، لمحمد، ولأحمد، فبسارة. */
const ARABIC_PREFIX = '(?:[وف]?[بلك]?)';
/** Between the words of a name: any spacing, a line break, invisibles, or a hyphen (Sarah-Jane). */
const WORD_GAP = `(?:${BLANK}+|[\\s\\u00A0]*-[\\s\\u00A0]*)`;

/** Words that never become a target on their own: particles of names, prepositions, nouns of organisation names. */
const STOP_WORDS = new Set(
  [
    ...['بن', 'ابن', 'بنت', 'ابو', 'أبو', 'ام', 'أم', 'عبد', 'ال', 'آل'],
    ...[
      'على',
      'إلى',
      'الى',
      'في',
      'من',
      'عن',
      'مع',
      'بين',
      'حتى',
      'عند',
      'هذا',
      'هذه',
      'ذلك',
      'التي',
      'الذي',
    ],
    ...[
      'bin',
      'ibn',
      'bint',
      'abu',
      'abd',
      'al',
      'el',
      'mr',
      'mrs',
      'ms',
      'dr',
      'the',
      'and',
      'of',
      'for',
    ],
  ].map((word) => normalizeArabic(word)),
);

const PLACEHOLDER = /\[(PARTY|EMAIL|PHONE|IBAN|ACCOUNT|ID)_(\d+)\]/g;
/** A word joiner inside a placeholder-looking token of the source keeps restore from turning it into a value. */
const NEUTRALISED = '[$1\u2060_$2]';

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Arabic-Indic (U+0660…) and Persian (U+06F0…) digits as Western ones: one character each, so indexes stay. */
const westernDigits = (text: string): string =>
  text.replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) & 0x0f));

/** A comparable form of a name or word: compatibility forms folded (PDF presentation forms), Arabic-normalised. */
const canonical = (text: string): string => normalizeArabic(text.normalize('NFKC'));

/** Replaces what `pattern` finds in the Western-digit copy, keeping the original characters for the mapping. */
function replaceMatches(
  text: string,
  pattern: RegExp,
  replace: (western: string, original: string) => string,
): string {
  let out = '';
  let from = 0;
  for (const match of westernDigits(text).matchAll(pattern)) {
    const end = match.index + match[0].length;
    out += text.slice(from, match.index) + replace(match[0], text.slice(match.index, end));
    from = end;
  }
  return out + text.slice(from);
}

/** A pattern matching a name however it is written: Arabic letter variants, marks, any spacing, any case. */
function namePattern(name: string): RegExp {
  const word = (text: string) =>
    [...text]
      .map((char) => {
        const variants = ARABIC_VARIANTS[char];
        return (variants ? `[${variants}]` : escape(char)) + MARKS;
      })
      .join('');
  const words = canonical(name)
    .split(/[\s-]+/)
    .filter(Boolean);
  // Never inside a longer word, nor inside a placeholder ([PHONE_1] for a party called "Phone").
  return new RegExp(
    `(?<=(?:^|[^\\p{L}\\p{N}\\[])${ARABIC_PREFIX})${words.map(word).join(WORD_GAP)}(?![\\p{L}\\p{N}_])`,
    'giu',
  );
}

/**
 * Full names first (longest first), then the single words of person names that identify someone (3+ letters, no
 * punctuation, not a stop word). Organisation names are matched only whole: their words (شركة، النور، Trading) are
 * common words.
 */
function nameTargets({ names, organisations = [] }: RedactionContext): string[] {
  const clean = (list: readonly string[]) =>
    list
      .map((name) => name.normalize('NFKC').trim().replace(/\s+/g, ' '))
      .filter((name) => name.length >= 2);
  const persons = clean(names);
  const words = persons
    .flatMap((name) => name.split(/[\s-]+/))
    .map((word) => word.replace(/[^\p{L}\p{M}]/gu, ''))
    .filter((word) => canonical(word).length >= 3 && !STOP_WORDS.has(canonical(word)));
  return [...new Set([...persons, ...clean(organisations), ...words])].sort(
    (a, b) => b.length - a.length,
  );
}

/** Ids are 9–14 digits (PS 9, JO/SA 10, EG 14); 15–19 digits are card and bank account numbers. */
const numberKind = (digits: string): PiiKind => (digits.length >= 15 ? 'ACCOUNT' : 'ID');

/**
 * PII redaction before any provider call (D-057, D-131). Names from the case (`context.names`: the people of the
 * file — clients, parties, witnesses, lawyers — whole and by their identifying words; `context.organisations` whole) and
 * emails, phones (PS/IL/JO/EG/GCC formats), IBANs, card and bank numbers and national ids become stable placeholders:
 * the same value always gets the same `[KIND_n]` across every text of one call (system prompt and user text share it).
 * `restore` puts the originals back into the answer (names in the spelling the case uses). The mapping exists only in
 * the returned object, in the job's memory — never stored, cached or logged. Texts are NFKC-normalised first (PDF
 * presentation forms, decomposed accents), so what is sent and restored is the normalised form.
 */
@Injectable()
export class PiiRedactor implements AiRedactor {
  readonly redactsPii = true;

  redact(texts: readonly string[], context: RedactionContext): Redacted {
    const values = new Map<string, string>();
    const byKey = new Map<string, string>();
    const counters = new Map<PiiKind, number>();
    const stats: Partial<Record<PiiKind, number>> = {};
    const placeholder = (kind: PiiKind, key: string, original: string): string => {
      stats[kind] = (stats[kind] ?? 0) + 1;
      const found = byKey.get(`${kind}:${key}`);
      if (found) return found;
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      const token = `[${kind}_${next}]`;
      byKey.set(`${kind}:${key}`, token);
      values.set(token, original);
      return token;
    };
    const targets = nameTargets(context).map((name) => [name, namePattern(name)] as const);
    const redactOne = (input: string): string => {
      let text = input.normalize('NFKC').replace(PLACEHOLDER, NEUTRALISED);
      for (const [kind, pattern] of PATTERNS) {
        text = replaceMatches(text, pattern, (western, original) => {
          if (kind === 'IBAN') return iban(western, original, placeholder);
          const key = western.replace(/[^\p{L}\p{N}+]/gu, '').toUpperCase();
          return placeholder(kind === 'NUMBER' ? numberKind(key) : kind, key, original);
        });
      }
      for (const [name, pattern] of targets) {
        text = text.replace(pattern, () => placeholder('PARTY', canonical(name), name));
      }
      return text;
    };
    return {
      texts: texts.map(redactOne),
      stats,
      restore: (value) => value.replace(PLACEHOLDER, (token) => values.get(token) ?? token),
    };
  }
}

/** An IBAN match without the words that may follow it in capitals (PS92PALS… TO THE): those stay as text. */
function iban(
  western: string,
  original: string,
  placeholder: (kind: PiiKind, key: string, original: string) => string,
): string {
  const tail = /(?:[ \u00A0][A-Za-z]+)+$/.exec(western)?.[0] ?? '';
  const value = original.slice(0, original.length - tail.length);
  const key = western
    .slice(0, western.length - tail.length)
    .replace(/[ \u00A0]/g, '')
    .toUpperCase();
  return placeholder('IBAN', key, value) + original.slice(original.length - tail.length);
}
