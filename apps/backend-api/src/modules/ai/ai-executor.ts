import { Inject, Injectable } from '@nestjs/common';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { Decimal } from 'decimal.js';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { AiAccess } from './ai-access';
import { AiCache } from './ai-cache';
import { AiFinalException, AiProviders } from './ai-providers';
import type { ProviderAnswer } from './ai-providers';
import { AiUsageRecorder } from './ai-usage';
import { AI_REDACTOR, restoreDeep } from './redaction';
import type { AiRedactor, Redacted, RedactionContext } from './redaction';
import type { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';

/**
 * A versioned prompt (ai-ocr.md): `version` is stored with the output and part of the cache key. `system` comes from a
 * prompt file; case data belongs in `user` (both are redacted, but only `user` is meant to carry it).
 */
export interface AiPrompt {
  readonly version: string;
  readonly system: string;
  readonly user: string;
}

export interface ExecuteOptions<T> {
  /** Feature name for usage, the cache key and the fake provider, e.g. `document-summary`. */
  readonly feature: string;
  readonly prompt: AiPrompt;
  readonly schema: z.ZodType<T>;
  readonly redactionContext: RedactionContext;
  /**
   * Office-scoped cache key parts (`[A-Za-z0-9._-]`), e.g. the document id and version; the feature and prompt version
   * are added. None → no cache. The cache is per office: the caller has checked access to the source first.
   */
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

/**
 * Time for one `execute`, all attempts included (primary, fallback, repair): inside the `ai` queue's 120 s job timeout
 * (D-084), so the job is never cut off in the middle of a provider call.
 */
export const EXECUTE_DEADLINE_MS = 100_000;

type Cached<T> = Omit<AiResult<T>, 'cached'>;

/**
 * The one way to call an LLM (ai-ocr.md, D-130): enablement (AI-001/005, AUTH-102) → cache → quota (AUTH-103) → PII
 * redaction → provider with fallback → JSON parse + Zod validation (one repair, then AI-004) → re-hydration → usage row
 * → cache. Fails closed: a provider that sends text out runs only with a redactor that really redacts (D-057).
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
    await this.access.assertEnabled();
    const key = options.cacheKey && [options.feature, ...options.cacheKey, options.prompt.version];
    const hit = key ? await this.fromCache(officeId, key, options) : null;
    if (hit) return hit;
    await this.access.assertQuota();
    const result = await this.call(options);
    if (key) {
      const ttl = options.ttlSeconds ?? this.config.ai.cacheTtlSeconds;
      await this.cache.set(officeId, key, result, ttl);
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
      costUsd: '0',
      userId: options.userId ?? null,
    });
    return { ...hit, value: value.data, cached: true };
  }

  /**
   * Redact → provider (with one repair) → re-hydrate → validate. Every answer received is recorded, also when a later
   * call fails: the calls were paid for.
   */
  private async call<T>(options: ExecuteOptions<T>): Promise<Cached<T>> {
    if (this.providers.sendsOut && !this.redactor.redactsPii) {
      throw new AiFinalException(
        'AI-001',
        'AI providers are blocked until the PII redactor is installed',
      );
    }
    if (options.prompt.user.length > MAX_INPUT_CHARS) {
      throw new AiFinalException('AI-003', 'Input too large for the AI model');
    }
    const redacted = this.redactor.redact(options.prompt.user, options.redactionContext);
    const redactedSystem = this.redactor.redact(options.prompt.system, options.redactionContext);
    const system = redactedSystem.text;
    const stats = mergeStats(redacted.stats, redactedSystem.stats);
    const answers: ProviderAnswer[] = [];
    const started = Date.now();
    let value: unknown;
    try {
      value = await this.ask(options, system, redacted, answers);
    } finally {
      await this.record(options, answers, Date.now() - started, stats);
    }
    const restored = options.schema.safeParse(restoreDeep(value, redacted.restore));
    const last = answers[answers.length - 1];
    if (!restored.success || !last) {
      throw new AiFinalException('AI-004', 'AI output did not match the schema');
    }
    return {
      value: restored.data,
      provider: last.provider,
      model: last.model,
      promptVersion: options.prompt.version,
    };
  }

  /** One call, and one repair call (a separate message) when the answer is not valid JSON for the schema. */
  private async ask<T>(
    options: ExecuteOptions<T>,
    system: string,
    redacted: Redacted,
    answers: ProviderAnswer[],
  ): Promise<unknown> {
    const deadline = AbortSignal.timeout(EXECUTE_DEADLINE_MS);
    const request = {
      feature: options.feature,
      system,
      user: redacted.text,
      jsonSchema: z.toJSONSchema(options.schema, { io: 'input', unrepresentable: 'any' }),
      maxOutputTokens: this.config.ai.maxOutputTokens,
      temperature: this.config.ai.temperature,
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
    };
    try {
      const first = await this.providers.complete(request);
      answers.push(first);
      const checked = check(first.text, options.schema);
      if (checked.ok) return checked.value;
      const repair = await this.providers.complete({
        ...request,
        followUp: `Your previous answer was not valid (${checked.problem}). Answer again with one JSON object only, matching the schema.`,
      });
      answers.push(repair);
      const repaired = check(repair.text, options.schema);
      return repaired.ok ? repaired.value : null;
    } catch (error) {
      // Our own deadline, not the caller's signal: the providers were too slow this time.
      if (deadline.aborted && !options.signal?.aborted) {
        throw new AppException('AI-001', 'AI providers did not answer in time');
      }
      throw error;
    }
  }

  private async record<T>(
    options: ExecuteOptions<T>,
    answers: readonly ProviderAnswer[],
    durationMs: number,
    redactionStats: Readonly<Record<string, number>>,
  ): Promise<void> {
    const last = answers[answers.length - 1];
    if (!last) return;
    await this.usage.record({
      feature: options.feature,
      provider: last.provider,
      model: last.model,
      inputTokens: answers.reduce((sum, answer) => sum + answer.inputTokens, 0),
      outputTokens: answers.reduce((sum, answer) => sum + answer.outputTokens, 0),
      durationMs,
      cached: false,
      // Each call at its own provider's price (a repair may come from the fallback).
      costUsd: answers
        .reduce(
          (sum, answer) =>
            sum.plus(this.usage.cost(answer.priceModel, answer.inputTokens, answer.outputTokens)),
          new Decimal(0),
        )
        .toFixed(6),
      redactionStats,
      userId: options.userId ?? null,
    });
  }

  private officeId(): OfficeId {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of an AI call');
    return officeId;
  }
}

/** Adds up the redaction counts of the user text and the system prompt. */
function mergeStats(...all: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const stats of all) {
    for (const [kind, count] of Object.entries(stats)) merged[kind] = (merged[kind] ?? 0) + count;
  }
  return merged;
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
