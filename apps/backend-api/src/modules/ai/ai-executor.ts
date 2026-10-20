import { Inject, Injectable } from '@nestjs/common';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { AiAccess } from './ai-access';
import { AiCache } from './ai-cache';
import { AiProviders } from './ai-providers';
import type { ProviderAnswer } from './ai-providers';
import { AiUsageRecorder } from './ai-usage';
import { AI_REDACTOR, restoreDeep } from './redaction';
import type { AiRedactor, RedactionContext } from './redaction';
import type { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';

/** A versioned prompt (ai-ocr.md): `version` is stored with the output and part of the cache key. */
export interface AiPrompt {
  readonly version: string;
  readonly system: string;
  readonly user: string;
}

export interface ExecuteOptions<T> {
  /** Feature name for usage and the fake provider, e.g. `document-summary`. */
  readonly feature: string;
  readonly prompt: AiPrompt;
  readonly schema: z.ZodType<T>;
  readonly redactionContext: RedactionContext;
  /** Office-scoped cache key parts (`[A-Za-z0-9._-]`); the prompt version is added. None → no cache. */
  readonly cacheKey?: readonly string[];
  readonly ttlSeconds?: number;
  /** Who asked; null for work the system started. */
  readonly userId?: string | null;
  readonly signal?: AbortSignal;
}

export interface AiResult<T> {
  readonly value: T;
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly cached: boolean;
}

/** Longest user text sent at once; longer documents are chunked by the feature (map-reduce), else AI-003. */
export const MAX_INPUT_CHARS = 400_000;

type Cached<T> = Omit<AiResult<T>, 'cached'>;

/**
 * The one way to call an LLM (ai-ocr.md, D-130): availability (AI-001/005, AUTH-102/103) → cache → PII redaction →
 * provider with fallback → JSON parse + Zod validation (one repair attempt, then AI-004) → re-hydration → usage row →
 * cache. Fails closed: a provider that sends text out runs only with a redactor that really redacts (D-057).
 */
@Injectable()
export class AiExecutor {
  constructor(
    private readonly access: AiAccess,
    private readonly providers: AiProviders,
    private readonly cache: AiCache,
    private readonly usage: AiUsageRecorder,
    private readonly config: AppConfig,
    private readonly cls: ClsService<RequestContext>,
    @Inject(AI_REDACTOR) private readonly redactor: AiRedactor,
  ) {}

  async execute<T>(options: ExecuteOptions<T>): Promise<AiResult<T>> {
    const officeId = this.officeId();
    await this.access.assertAvailable();
    const key = options.cacheKey && [...options.cacheKey, options.prompt.version];
    const hit = key ? await this.fromCache(officeId, key, options) : null;
    if (hit) return hit;
    const result = await this.call(options);
    if (key) {
      await this.cache.set(
        officeId,
        key,
        result,
        options.ttlSeconds ?? this.config.ai.cacheTtlSeconds,
      );
    }
    return { ...result, cached: false };
  }

  /** A cached answer still valid for the schema; recorded as a free (cached) use. */
  private async fromCache<T>(
    officeId: OfficeId,
    key: readonly string[],
    options: ExecuteOptions<T>,
  ): Promise<AiResult<T> | null> {
    const hit = await this.cache.get<Cached<T>>(officeId, key);
    const value = hit ? options.schema.safeParse(hit.value) : null;
    if (!hit || !value?.success) return null;
    await this.usage.record({
      feature: options.feature,
      provider: hit.provider,
      model: hit.model,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      cached: true,
      userId: options.userId ?? null,
    });
    return { ...hit, value: value.data, cached: true };
  }

  /** Redact → provider (with one repair) → re-hydrate → validate; the usage row is written even when it fails. */
  private async call<T>(options: ExecuteOptions<T>): Promise<Cached<T>> {
    if (this.providers.sendsOut && !this.redactor.redactsPii) {
      throw new AppException(
        'AI-001',
        'AI providers are blocked until the PII redactor is installed',
      );
    }
    if (options.prompt.user.length > MAX_INPUT_CHARS) {
      throw new AppException('AI-003', 'Input too large for the AI model');
    }
    const redacted = this.redactor.redact(options.prompt.user, options.redactionContext);
    const started = Date.now();
    const { value, answers } = await this.ask(options, redacted.text);
    const last = answers[answers.length - 1] as ProviderAnswer;
    await this.usage.record({
      feature: options.feature,
      provider: last.provider,
      model: last.model,
      inputTokens: answers.reduce((sum, answer) => sum + answer.inputTokens, 0),
      outputTokens: answers.reduce((sum, answer) => sum + answer.outputTokens, 0),
      durationMs: Date.now() - started,
      cached: false,
      userId: options.userId ?? null,
    });
    const restored = options.schema.safeParse(restoreDeep(value, redacted.restore));
    if (!restored.success) throw new AppException('AI-004', 'AI output did not match the schema');
    return {
      value: restored.data,
      provider: last.provider,
      model: last.model,
      promptVersion: options.prompt.version,
    };
  }

  /** One call, and one repair call when the answer is not valid JSON for the schema. */
  private async ask<T>(
    options: ExecuteOptions<T>,
    user: string,
  ): Promise<{ value: unknown; answers: ProviderAnswer[] }> {
    const jsonSchema = z.toJSONSchema(options.schema, { io: 'input', unrepresentable: 'any' });
    const request = {
      feature: options.feature,
      system: options.prompt.system,
      jsonSchema,
      maxOutputTokens: this.config.ai.maxOutputTokens,
      temperature: this.config.ai.temperature,
      signal: options.signal ?? new AbortController().signal,
    };
    const first = await this.providers.complete({ ...request, user });
    const checked = check(first.text, options.schema);
    if (checked.ok) return { value: checked.value, answers: [first] };
    const repair = await this.providers.complete({
      ...request,
      user: `${user}\n\nYour previous answer was not valid (${checked.problem}). Answer again with one JSON object only, matching the schema.`,
    });
    const repaired = check(repair.text, options.schema);
    if (repaired.ok) return { value: repaired.value, answers: [first, repair] };
    return { value: null, answers: [first, repair] };
  }

  private officeId(): OfficeId {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of an AI call');
    return officeId;
  }
}

/** Parses and validates an answer; `problem` names paths and issue codes only (never the text). */
function check<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const problem = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
    .join('; ');
  return { ok: false, problem };
}

/**
 * Base class of AI features (`.claude/skills/ai-feature`): a feature service extends it and calls `this.execute(…)`
 * with its prompt, schema and redaction context.
 */
export abstract class BaseAiService {
  constructor(private readonly executor: AiExecutor) {}

  protected execute<T>(options: ExecuteOptions<T>): Promise<AiResult<T>> {
    return this.executor.execute(options);
  }
}
