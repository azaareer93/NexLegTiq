/** What the redactor knows about the case: the names to hide (the file's clients, parties, witnesses — D-057). */
export interface RedactionContext {
  readonly names: readonly string[];
}

export interface Redacted {
  /** The text with PII replaced by stable placeholders (`[PARTY_1]`). */
  readonly text: string;
  /** Puts the original values back into a string of the answer. */
  restore(value: string): string;
}

/**
 * PII redaction before any provider call (D-057). The real redactor is its own story; until it is registered as
 * `AI_REDACTOR`, `PassThroughRedactor` stands in — and it may only ever serve the fake provider, which sends nothing
 * outside: `AiExecutor` refuses a real provider while `redactsPii` is false (AI-001), so nothing leaves unredacted.
 */
export interface AiRedactor {
  readonly redactsPii: boolean;
  redact(text: string, context: RedactionContext): Redacted;
}

export const AI_REDACTOR = Symbol('AI_REDACTOR');

export class PassThroughRedactor implements AiRedactor {
  readonly redactsPii = false;

  redact(text: string): Redacted {
    return { text, restore: (value) => value };
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
