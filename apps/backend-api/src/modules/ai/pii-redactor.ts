import { Injectable } from '@nestjs/common';
import { normalizeArabic } from '@nexlegtiq/shared-utils';

import type { AiRedactor, Redacted, RedactionContext } from './redaction';

export type PiiKind = 'PARTY' | 'EMAIL' | 'PHONE' | 'IBAN' | 'ACCOUNT' | 'ID';

/** Patterns see Western digits: they run on a copy where Arabic-Indic and Persian digits are converted. */
const D = '\\d';
const SEP = '[\\s\\-.]?';
const NOT_BEFORE = '(?<![\\p{L}\\p{N}@])';
const NOT_AFTER = '(?![\\p{L}\\p{N}])';

/** Country codes of the markets we serve (PS, IL numbers used in PS, JO, EG, GCC, LB, IQ, MA) plus US/UK. */
const COUNTRY = '(?:970|972|962|966|971|965|974|968|973|961|964|212|20|44|1)';

/**
 * Patterns in the order they run: each one's placeholders contain no digits run long enough for the next. Phones run
 * before IDs (a 10-digit mobile would otherwise be an ID), IBANs before bank numbers.
 */
const PATTERNS: readonly (readonly [PiiKind, RegExp])[] = [
  ['EMAIL', /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu],
  [
    'IBAN',
    new RegExp(`(?<![A-Za-z0-9])[A-Z]{2}${D}{2}(?:[ ]?[A-Z0-9]){11,30}(?![A-Za-z0-9])`, 'gu'),
  ],
  [
    'PHONE',
    new RegExp(
      [
        // International: +970 59 123 4567, 00962-7-9123-4567, +1 (555) 123-4567.
        `${NOT_BEFORE}(?:\\+|00)${COUNTRY}${SEP}\\(?${D}{1,4}\\)?(?:${SEP}${D}){5,10}${NOT_AFTER}`,
        // Local mobiles: 059x / 056x (PS), 05x (IL, SA, AE), 07[789] (JO), 01[0125] (EG).
        `${NOT_BEFORE}0(?:5${D}|7[789]|1[0125])${SEP}${D}{3,4}${SEP}${D}{3,4}${NOT_AFTER}`,
        // Local landlines: 02-2xx-xxxx (PS), 06-5xx-xxxx (JO), 02-xxxx-xxxx (EG).
        `${NOT_BEFORE}0[2-9]${SEP}${D}{3,4}${SEP}${D}{4}${NOT_AFTER}`,
      ].join('|'),
      'gu',
    ),
  ],
  // Card and bank account numbers.
  ['ACCOUNT', new RegExp(`${NOT_BEFORE}${D}{15,19}${NOT_AFTER}`, 'gu')],
  // National ids: PS 9 digits, JO/SA 10, EG 14 — any run of 9 to 14 digits.
  ['ID', new RegExp(`${NOT_BEFORE}${D}{9,14}${NOT_AFTER}`, 'gu')],
];

/** Letters a name may be written with interchangeably (hamza seats, alef forms, ta marbuta, alef maqsura). */
const ARABIC_VARIANTS: Readonly<Record<string, string>> = {
  ا: 'اأإآٱء',
  ي: 'يىئ',
  ه: 'هة',
  و: 'وؤ',
};
/** Tashkeel, the dagger alef and tatweel may sit between any two letters. */
const MARKS = '[\\u064B-\\u065F\\u0670\\u0640]*';
/** Attached conjunctions and prepositions: وأحمد، لمحمد، بسارة. */
const ARABIC_PREFIX = '[وفبلك]?';
const WORD_GAP = '[\\s\\u200C\\u200F\\u200E]+';

/** Name words never redacted on their own (kinship and common particles). */
const PARTICLES = new Set(
  [
    'بن',
    'ابن',
    'بنت',
    'ابو',
    'ام',
    'عبد',
    'ال',
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
  ].map((word) => normalizeArabic(word)),
);

/** Arabic-Indic (U+0660…) and Persian (U+06F0…) digits as Western ones: one character each, so indexes stay. */
const westernDigits = (text: string): string =>
  text.replace(/[٠-٩۰-۹]/g, (digit) => String((digit.charCodeAt(0) & 0x0f) % 10));

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

const PLACEHOLDER = /\[(PARTY|EMAIL|PHONE|IBAN|ACCOUNT|ID)_(\d+)\]/g;

const escape = (char: string): string => char.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** A pattern matching a name however it is written: Arabic letter variants, marks, any spacing, any case. */
function namePattern(name: string): RegExp {
  const words = normalizeArabic(name).split(/\s+/).filter(Boolean);
  const word = (text: string) =>
    [...text]
      .map((char) => {
        const variants = ARABIC_VARIANTS[char];
        return (variants ? `[${variants}]` : escape(char)) + MARKS;
      })
      .join('');
  return new RegExp(
    `(?<=(?:^|[^\\p{L}\\p{N}])${ARABIC_PREFIX})${words.map(word).join(WORD_GAP)}(?![\\p{L}\\p{N}])`,
    'giu',
  );
}

/** Full names first (longest first), then their single words that identify someone. */
function nameTargets(names: readonly string[]): string[] {
  const full = [
    ...new Set(
      names.map((name) => name.trim().replace(/\s+/g, ' ')).filter((name) => name.length >= 2),
    ),
  ];
  const words = full
    .flatMap((name) => name.split(' '))
    .filter((part) => {
      const normalized = normalizeArabic(part);
      return normalized.length >= 3 && !PARTICLES.has(normalized);
    });
  return [...new Set([...full, ...words])].sort((a, b) => b.length - a.length);
}

/**
 * PII redaction before any provider call (D-057, D-131). Names from the case (`context.names`: the file's clients,
 * parties, witnesses and lawyers — full names and their identifying words) and emails, phones (PS/IL/JO/EG/GCC
 * formats), IBANs, bank and card numbers and national ids become stable placeholders: the same value always gets the
 * same `[KIND_n]` within one call. `restore` puts the originals back into the answer (names in the spelling the case
 * uses). The mapping exists only in the returned object, in the job's memory — never stored, cached or logged.
 */
@Injectable()
export class PiiRedactor implements AiRedactor {
  readonly redactsPii = true;

  redact(text: string, context: RedactionContext): Redacted {
    const values = new Map<string, string>();
    const byKey = new Map<string, string>();
    const counters = new Map<PiiKind, number>();
    const stats: Partial<Record<PiiKind, number>> = {};
    const placeholder = (kind: PiiKind, key: string, original: string): string => {
      const found = byKey.get(`${kind}:${key}`);
      stats[kind] = (stats[kind] ?? 0) + 1;
      if (found) return found;
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      const token = `[${kind}_${next}]`;
      byKey.set(`${kind}:${key}`, token);
      values.set(token, original);
      return token;
    };
    let redacted = text;
    for (const [kind, pattern] of PATTERNS) {
      redacted = replaceMatches(redacted, pattern, (western, original) =>
        placeholder(kind, western.replace(/[\s\-.()]/g, ''), original),
      );
    }
    for (const name of nameTargets(context.names)) {
      redacted = redacted.replace(namePattern(name), () =>
        placeholder('PARTY', normalizeArabic(name), name),
      );
    }
    return {
      text: redacted,
      stats,
      restore: (value) => value.replace(PLACEHOLDER, (token) => values.get(token) ?? token),
    };
  }
}
