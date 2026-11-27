import { z } from 'zod';

const AI_PROVIDERS = ['openai', 'gemini', 'fake', 'none'] as const;
const RESEARCH_PROVIDERS = ['perplexity', 'fake', 'none'] as const;
const required = z.string().trim().min(1);

/** AI providers and legal research (ai-ocr.md, D-130, D-256), part of the backend env contract (`env.schema.ts`). */
export const AI_ENV = {
  // AI providers (ai-ocr.md, D-130). `none` = AI off for the whole deployment (AI-001); `fake` = deterministic answers
  // for tests and local work, refused in production. Model names are configuration, never code.
  AI_PRIMARY_PROVIDER: z.enum(AI_PROVIDERS).default('none'),
  AI_FALLBACK_PROVIDER: z.enum(AI_PROVIDERS).default('none'),
  OPENAI_API_KEY: required.optional(),
  OPENAI_MODEL: required.optional(),
  GEMINI_API_KEY: required.optional(),
  GEMINI_MODEL: required.optional(),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_768).default(4096),
  AI_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.2),
  // One provider attempt; a slower answer counts as unavailable (fallback). Inside the ai queue's 120 s job timeout.
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(90_000).default(45_000),
  AI_CACHE_TTL: z.coerce
    .number()
    .int()
    .min(0)
    .max(30 * 86_400)
    .default(86_400),
  // USD per million tokens by model, for AiUsage.costUsd: {"model":{"input":0.15,"output":0.6}}. A model not listed costs 0.
  AI_MODEL_PRICES: z
    .string()
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'must be JSON' });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) })))
    .default({}),
  // Legal research (D-256): the platform switch, off by default. `perplexity` only once its zero-retention terms and the
  // DPA/FAQ entry are in place; `fake` for tests and local work, refused in production.
  AI_RESEARCH_PROVIDER: z.enum(RESEARCH_PROVIDERS).default('none'),
  PERPLEXITY_API_KEY: required.optional(),
  PERPLEXITY_MODEL: required.optional(),
};

/** The key and model each provider needs when it is configured. */
export const AI_PROVIDER_ENV: Partial<Record<string, readonly (keyof typeof AI_ENV)[]>> = {
  openai: ['OPENAI_API_KEY', 'OPENAI_MODEL'],
  gemini: ['GEMINI_API_KEY', 'GEMINI_MODEL'],
  perplexity: ['PERPLEXITY_API_KEY', 'PERPLEXITY_MODEL'],
};
