import { z } from 'zod';

/** Control characters plus the bidi overrides/isolates (U+202A–202E, U+2066–2069) that could reverse how text displays. */
const SAFE_LINE = /^[^\p{Cc}\u{202A}-\u{202E}\u{2066}-\u{2069}]*$/u;

/**
 * Single-line plain text (names, titles): trimmed, required, no control characters and no bidi overrides or isolates
 * (D-054). ZWJ/ZWNJ stay allowed: Arabic text uses them.
 */
export const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(max, 'validation.tooLong')
    .regex(SAFE_LINE, 'validation.invalidCharacters');

/** Multi-line plain text: like `plainText`, but line breaks and tabs are kept; may be empty. */
export const longText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'validation.tooLong')
    .refine(
      (value) => SAFE_LINE.test(value.replace(/[\n\r\t]/g, '')),
      'validation.invalidCharacters',
    );

/** A money amount as a decimal string (D-017): up to 12 integer digits and 2 decimals, never negative. */
export const MoneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'validation.amount');

/** A search term: trimmed, may be empty, same character rules as `plainText`. */
export const searchText = (max: number) =>
  z.string().trim().max(max, 'validation.tooLong').regex(SAFE_LINE, 'validation.invalidCharacters');

/** An email address, trimmed and lower-cased. */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('validation.email'));

/** A phone number: digits with an optional leading `+`, spaces, brackets and dashes (Western digits). */
export const PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'validation.phone');

/** `sort=field:dir,…` (api-conventions.md): known fields only, each once, `asc` when no direction is given. */
export const sortParam = <F extends string>(fields: readonly F[]) =>
  z
    .string()
    .trim()
    .max(200, 'validation.tooLong')
    .transform((value, ctx) => {
      const parts = value.split(',').map((part) => part.trim().split(':'));
      const sort: { field: F; direction: 'asc' | 'desc' }[] = [];
      for (const [field, direction = 'asc', ...rest] of parts) {
        const known = (fields as readonly string[]).includes(field ?? '');
        const repeated = sort.some((key) => key.field === field);
        if (
          !known ||
          repeated ||
          rest.length > 0 ||
          (direction !== 'asc' && direction !== 'desc')
        ) {
          ctx.addIssue({ code: 'custom', message: 'validation.sort' });
          return z.NEVER;
        }
        sort.push({ field: field as F, direction });
      }
      return sort;
    });
