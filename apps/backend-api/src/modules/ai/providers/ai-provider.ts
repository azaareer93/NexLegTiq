/** What every provider is asked (D-130): a system prompt, the (redacted) user text and the JSON shape of the answer. */
export interface AiRequest {
  /** The feature asking, e.g. `document-summary` (the fake provider answers per feature). */
  readonly feature: string;
  readonly system: string;
  readonly user: string;
  /** JSON Schema of the expected answer (Zod's `toJSONSchema`). */
  readonly jsonSchema: Record<string, unknown>;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  readonly signal: AbortSignal;
}

export interface AiCompletion {
  /** The raw answer, expected to be JSON. */
  readonly text: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type ProviderName = 'openai' | 'gemini' | 'fake';

export interface AiProvider {
  readonly name: ProviderName;
  readonly model: string;
  complete(request: AiRequest): Promise<AiCompletion>;
}

/** Why a provider could not answer now; only these are worth the fallback (ai-ocr.md: timeout, 5xx, 429). */
export type UnavailableReason = 'timeout' | 'rate-limited' | 'server-error' | 'network';

/** The provider could not answer now: try the fallback, count it in the circuit breaker. */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly reason: UnavailableReason,
    readonly status?: number,
  ) {
    super(`${provider} unavailable: ${reason}${status ? ` (${status})` : ''}`);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * The provider refused the request itself (bad key, bad request, input too long): another provider would refuse it
 * too or answer differently, so no fallback. `tooLarge` maps to AI-003, anything else to AI-001. Never carries the
 * provider's message (it may quote the input).
 */
export class ProviderRequestError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly status: number,
    readonly tooLarge: boolean,
  ) {
    super(`${provider} refused the request (${status})`);
    this.name = 'ProviderRequestError';
  }
}
