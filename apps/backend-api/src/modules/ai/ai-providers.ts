import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CircuitBreaker } from './circuit-breaker';
import { ProviderRequestError, ProviderUnavailableError } from './providers/ai-provider';
import type { AiCompletion, AiProvider, AiRequest, AiSource } from './providers/ai-provider';
import { FakeAiProvider } from './providers/fake.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { OpenAiProvider } from './providers/openai.provider';
import { PerplexityProvider } from './providers/perplexity.provider';
import { AppException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';
import type { AiConfig, AiProviderName } from '../../config/app-config';

interface Link {
  readonly provider: AiProvider;
  readonly breaker: CircuitBreaker;
}

export interface ProviderAnswer extends AiCompletion {
  readonly provider: AiProvider['name'];
  /** The configured model name, the key of `AI_MODEL_PRICES` (the answer's `model` may be a dated snapshot). */
  readonly priceModel: string;
  readonly sources: readonly AiSource[];
}

/**
 * An AI error that another attempt would not fix (no provider, a refused request, no redactor): the worker fails the
 * job at once instead of retrying it (D-130).
 */
export class AiFinalException extends AppException {}

/**
 * The configured providers in order — primary, then fallback (`AI_PRIMARY_PROVIDER` / `AI_FALLBACK_PROVIDER`) — each
 * behind its circuit breaker. Falls back only when a provider is unavailable (timeout, network, 429, 5xx); a refused
 * request is final (D-130). Nothing configured → AI-001; all unavailable → AI-002 if the last was rate-limited, else
 * AI-001; a request too large → AI-003.
 */
@Injectable()
export class AiProviders {
  readonly fake = new FakeAiProvider();
  private readonly chain: Link[];
  /** Legal research (D-256): its own provider, no fallback; a web-search request never goes to the summary chain. */
  private readonly research: Link[];

  constructor(
    config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AiProviders.name);
    const ai = config.ai;
    this.chain = [ai.primary, ai.fallback]
      .map((name) => this.build(name, config))
      .filter((provider): provider is AiProvider => provider !== null)
      .map((provider) => ({ provider, breaker: new CircuitBreaker() }));
    const research = this.build(ai.research, config);
    this.research = research ? [{ provider: research, breaker: new CircuitBreaker() }] : [];
  }

  /** True when a provider that sends text outside the platform is configured (the PII redactor is then required). */
  get sendsOut(): boolean {
    return [...this.chain, ...this.research].some(({ provider }) => provider.name !== 'fake');
  }

  get configured(): boolean {
    return this.chain.length > 0;
  }

  /** The platform switched legal research on (`AI_RESEARCH_PROVIDER`, D-256). */
  get researchConfigured(): boolean {
    return this.research.length > 0;
  }

  async complete(request: AiRequest): Promise<ProviderAnswer> {
    const chain = request.webSearch ? this.research : this.chain;
    if (chain.length === 0) throw new AiFinalException('AI-001', 'No AI provider is configured');
    let last: ProviderUnavailableError | null = null;
    for (const link of chain) {
      if (!link.breaker.allow()) continue;
      const outcome = await this.attempt(link, request);
      if ('answer' in outcome) return outcome.answer;
      last = outcome.unavailable;
    }
    throw last?.reason === 'rate-limited'
      ? new AppException('AI-002', 'AI provider rate limited')
      : new AppException('AI-001', 'AI provider unavailable');
  }

  /** One provider call: its answer, or why it was unavailable (fallback); a refused request ends the chain. */
  private async attempt(
    { provider, breaker }: Link,
    request: AiRequest,
  ): Promise<{ answer: ProviderAnswer } | { unavailable: ProviderUnavailableError }> {
    try {
      const answer = await provider.complete(request);
      breaker.succeeded();
      return {
        answer: {
          ...answer,
          provider: provider.name,
          priceModel: provider.model,
          sources: answer.sources ?? [],
        },
      };
    } catch (error) {
      if (error instanceof ProviderUnavailableError) {
        breaker.failed();
        this.logger.warn(
          { provider: provider.name, reason: error.reason, status: error.status },
          'AI provider unavailable',
        );
        return { unavailable: error };
      }
      // A refused request, or the caller giving up, says nothing about the provider's health: the trial is released.
      breaker.release();
      if (!(error instanceof ProviderRequestError)) throw error;
      this.logger.warn(
        { provider: provider.name, status: error.status },
        'AI provider refused the request',
      );
      throw error.tooLarge
        ? new AiFinalException('AI-003', 'Input too large for the AI model')
        : new AiFinalException('AI-001', 'AI provider refused the request');
    }
  }

  private build(name: AiProviderName | AiConfig['research'], config: AppConfig): AiProvider | null {
    const { openai, gemini, perplexity, timeoutMs } = config.ai;
    switch (name) {
      case 'openai':
        return openai ? new OpenAiProvider(openai.apiKey, openai.model, timeoutMs) : null;
      case 'gemini':
        return gemini ? new GeminiProvider(gemini.apiKey, gemini.model, timeoutMs) : null;
      case 'perplexity':
        return perplexity
          ? new PerplexityProvider(perplexity.apiKey, perplexity.model, timeoutMs)
          : null;
      case 'fake':
        return this.fake;
      default:
        return null;
    }
  }
}
