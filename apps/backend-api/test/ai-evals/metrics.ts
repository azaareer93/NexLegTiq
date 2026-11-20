import { normalizeArabic, toWesternDigits } from '@nexlegtiq/shared-utils';

/** Words of a text for ROUGE: Western digits, Arabic letter variants folded, lower case, punctuation dropped. */
export function tokenize(text: string): string[] {
  return normalizeArabic(toWesternDigits(text.normalize('NFKC'))).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function lcsLength(a: readonly string[], b: readonly string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const word of a) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      current[j] =
        word === b[j - 1]
          ? (previous[j - 1] ?? 0) + 1
          : Math.max(previous[j] ?? 0, current[j - 1] ?? 0);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** ROUGE-L F1 (β = 1) of a candidate against one reference, over `tokenize` words: 0 when either is empty. */
export function rougeL(candidate: string, reference: string): number {
  const c = tokenize(candidate);
  const r = tokenize(reference);
  const lcs = lcsLength(c, r);
  if (lcs === 0) return 0;
  const precision = lcs / c.length;
  const recall = lcs / r.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * Citation patterns, AR and EN, each giving a key such as `article:12`, `law:2/2001` or `case:145/2023` (digits
 * already Western). Arabic forms take the attached prefixes (و ب ل ف, ال, لل).
 */
const CITATIONS: readonly (readonly [string, RegExp])[] = [
  ['article', /\b(?:article|art\.|section)\s+(\d+)/giu],
  ['article', /(?:^|[^\p{L}])[وبلف]?(?:ال|لل)?مادة\s*(?:رقم\s*)?\(?(\d+)/gu],
  ['law', /\blaw\b[^\n.]{0,60}?no\.?\s*(\d+)\s+of\s+(\d{4})/giu],
  ['law', /قانون[^\n.]{0,60}?رقم\s*\(?(\d+)\)?\s*لسنة\s*(\d{4})/gu],
  ['case', /\b(?:case|appeal|claim)\s+no\.?\s*(\d+)\s*\/\s*(\d{4})/giu],
  ['case', /(?:دعوى|قضيه|قضية|استئناف)[^\n.]{0,30}?رقم\s*\(?(\d+)\)?\s*\/\s*(\d{4})/gu],
];

/** The distinct legal citations a text makes (articles, laws, case numbers), as normalised keys. */
export function extractCitations(text: string): Set<string> {
  const western = toWesternDigits(text.normalize('NFKC'));
  const keys = new Set<string>();
  for (const [kind, pattern] of CITATIONS) {
    for (const match of western.matchAll(pattern)) {
      keys.add(`${kind}:${match.slice(1).filter(Boolean).map(Number).join('/')}`);
    }
  }
  return keys;
}

/** Citations the output makes that the source never does — the hallucinated-citation check. */
export function unsupportedCitations(output: string, source: string): string[] {
  const known = extractCitations(source);
  return [...extractCitations(output)].filter((key) => !known.has(key)).sort();
}

/** The nearest-rank percentile of a list of numbers (`p` in 0–100); 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}
