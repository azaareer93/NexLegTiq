/** One part a long document is summarised in (≈ 15k tokens): far inside every model's context with room for the answer. */
export const PART_CHARS = 60_000;
/**
 * At most this many parts (≈ 200 pages) are read: a longer document is summarised from its first ones, and the stored
 * `chunks` says so. shortcut: a cap rather than a per-plan input budget, until plans carry one (ai-ocr.md).
 */
export const MAX_PARTS = 8;

/**
 * Splits text into parts of at most `size` characters at paragraph or page breaks; a paragraph longer than a part is cut at
 * its last whitespace before the limit (or at the limit when it has none).
 */
export function splitText(text: string, size = PART_CHARS): string[] {
  const parts: string[] = [];
  let current = '';
  for (const paragraph of text.split(/(?<=\n\s*\n|\f)/)) {
    let rest = paragraph;
    while (rest.length > size) {
      if (current) parts.push(current);
      current = '';
      const cut = rest.lastIndexOf(' ', size);
      const at = cut > size / 2 ? cut + 1 : size;
      parts.push(rest.slice(0, at));
      rest = rest.slice(at);
    }
    if (current.length + rest.length > size) {
      parts.push(current);
      current = '';
    }
    current += rest;
  }
  if (current.trim()) parts.push(current);
  return parts.filter((part) => part.trim().length > 0);
}
