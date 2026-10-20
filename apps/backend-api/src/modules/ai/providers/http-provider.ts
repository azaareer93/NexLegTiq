import { ProviderRequestError, ProviderUnavailableError } from './ai-provider';
import type { ProviderName } from './ai-provider';

/** Error bodies that mean "the input is longer than the model takes" (OpenAI and Gemini wordings). */
const TOO_LARGE = /context_length|maximum context|too (many|long)|exceeds the maximum|token count/i;

/**
 * POSTs JSON to a provider (no SDK: a few fields each, D-130) and sorts failures: timeout, network, 429 and 5xx are
 * "unavailable" (fallback); other 4xx are request errors (no fallback). `timeoutMs` bounds one attempt; the caller's
 * signal (the job timeout, D-084) aborts it too.
 */
export async function postJson(
  provider: ProviderName,
  url: string,
  init: { headers: Record<string, string>; body: unknown; signal: AbortSignal; timeoutMs: number },
): Promise<unknown> {
  const timeout = AbortSignal.timeout(init.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(init.body),
      signal: AbortSignal.any([init.signal, timeout]),
    });
  } catch (error) {
    if (init.signal.aborted) throw error;
    throw new ProviderUnavailableError(provider, timeout.aborted ? 'timeout' : 'network');
  }
  if (response.status === 429) throw new ProviderUnavailableError(provider, 'rate-limited', 429);
  if (response.status >= 500) {
    throw new ProviderUnavailableError(provider, 'server-error', response.status);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderRequestError(provider, response.status, TOO_LARGE.test(body));
  }
  try {
    return await response.json();
  } catch {
    // A 200 that is not JSON is a broken gateway in between, not our request.
    throw new ProviderUnavailableError(provider, 'server-error', response.status);
  }
}
