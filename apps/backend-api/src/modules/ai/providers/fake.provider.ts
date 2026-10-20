import { createHash } from 'node:crypto';

import type { AiCompletion, AiProvider, AiRequest } from './ai-provider';

/** A scripted answer: a value to send as JSON, raw text (invalid JSON), or an error to throw. */
export type FakeStep = { json: unknown } | { text: string } | { error: Error };

type Fixture = (request: AiRequest) => unknown;

const tokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Deterministic provider for tests, CI and local work (D-130): no network. Each feature registers a fixture that builds
 * a valid answer from the request; tests can script the next answers (`script`) to drive fallback and repair paths.
 * Without either it answers `{"echo": <sha256 of the user text>}`, the same for the same input.
 */
export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  /** Every request seen, for assertions (what the provider would have received — redacted text included). */
  readonly requests: AiRequest[] = [];
  private readonly fixtures = new Map<string, Fixture>();
  private readonly steps: FakeStep[] = [];

  define(feature: string, fixture: Fixture): void {
    this.fixtures.set(feature, fixture);
  }

  script(...steps: FakeStep[]): void {
    this.steps.push(...steps);
  }

  reset(): void {
    this.requests.length = 0;
    this.steps.length = 0;
  }

  complete(request: AiRequest): Promise<AiCompletion> {
    this.requests.push(request);
    // Local work keeps the provider for hours: remember only the latest requests.
    if (this.requests.length > 100) this.requests.shift();
    const step = this.steps.shift();
    if (step && 'error' in step) return Promise.reject(step.error);
    const text =
      step && 'text' in step
        ? step.text
        : JSON.stringify(
            step
              ? step.json
              : (this.fixtures.get(request.feature)?.(request) ?? {
                  echo: createHash('sha256').update(request.user).digest('hex'),
                }),
          );
    return Promise.resolve({
      text,
      model: this.model,
      inputTokens: tokens(request.system) + tokens(request.user),
      outputTokens: tokens(text),
    });
  }
}
