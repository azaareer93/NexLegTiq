/** What the redactor knows about the case (D-057, D-131): the names to hide. */
export interface RedactionContext {
  /** People of the file: clients, parties, witnesses, lawyers — matched whole and by their identifying words. */
  readonly names: readonly string[];
  /** Companies and bodies of the file — matched whole only (their words are common words). */
  readonly organisations?: readonly string[];
}

export interface Redacted {
  /** The texts with PII replaced by placeholders (`[PARTY_1]`), numbered across all of them, in the order given. */
  readonly texts: readonly string[];
  /** Puts the original values back into a string of the answer. */
  restore(value: string): string;
  /** How many values of each kind were replaced (for the usage record; never the values). */
  readonly stats: Readonly<Record<string, number>>;
}

/**
 * PII redaction before any provider call (D-057): `PiiRedactor` is the `AI_REDACTOR` (D-131). `AiExecutor` refuses a
 * provider that sends text out while the redactor's `redactsPii` is false (AI-001) — `PassThroughRedactor` exists only
 * for tests of that rule.
 */
export interface AiRedactor {
  readonly redactsPii: boolean;
  /** Redacts several texts of one call together (system prompt and user text): one numbering, one `restore`. */
  redact(texts: readonly string[], context: RedactionContext): Redacted;
}

export const AI_REDACTOR = Symbol('AI_REDACTOR');

export class PassThroughRedactor implements AiRedactor {
  readonly redactsPii = false;

  redact(texts: readonly string[]): Redacted {
    return { texts, restore: (value) => value, stats: {} };
  }
}

/** Applies `restore` to every string of a parsed answer (keys stay as they are). */
export function restoreDeep(value: unknown, restore: (text: string) => string): unknown {
  if (typeof value === 'string') return restore(value);
  if (Array.isArray(value)) return value.map((item) => restoreDeep(item, restore));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, restoreDeep(item, restore)]),
    );
  }
  return value;
}
