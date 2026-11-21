/**
 * AI evals (D-195): `pnpm nx run backend-api:ai-evals --feature summary [--provider openai|gemini|fake]`.
 * Manual and local only — a real provider needs its key and model exported in the shell (OPENAI_API_KEY + OPENAI_MODEL
 * or GEMINI_API_KEY + GEMINI_MODEL; optional AI_MODEL_PRICES, AI_TIMEOUT_MS). Never run in CI. A real run writes
 * `docs/ai-evals/<date>-<promptVersion>.md`; `--provider fake` (answers with the references) only checks the harness.
 * Exits 1 when a threshold fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { checks, loadFixtures, renderReport, runSummaryEvals } from './harness';
import type { EvalFixture } from './harness';
import type { AiProvider } from '../../src/modules/ai/providers/ai-provider';
import { FakeAiProvider } from '../../src/modules/ai/providers/fake.provider';
import { GeminiProvider } from '../../src/modules/ai/providers/gemini.provider';
import { OpenAiProvider } from '../../src/modules/ai/providers/openai.provider';

const { values } = parseArgs({
  options: {
    feature: { type: 'string', default: 'summary' },
    provider: { type: 'string', default: 'openai' },
  },
});

const Env = z.object({
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(90_000).default(45_000),
  // Same bounds and defaults as env.schema.ts, so a tuned production setting is what gets evaluated.
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_768).default(4096),
  AI_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.2),
  AI_MODEL_PRICES: z
    .string()
    .default('{}')
    .transform((value) => JSON.parse(value) as unknown)
    .pipe(z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) }))),
});

type Env = z.infer<typeof Env>;

/** The provider to evaluate; an unknown name or a missing key throws (exit 2). */
function buildProvider(
  name: string | undefined,
  env: Env,
  fixtures: readonly EvalFixture[],
): AiProvider {
  switch (name) {
    case 'openai':
      if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL)
        throw new Error('Export OPENAI_API_KEY and OPENAI_MODEL');
      return new OpenAiProvider(env.OPENAI_API_KEY, env.OPENAI_MODEL, env.AI_TIMEOUT_MS);
    case 'gemini':
      if (!env.GEMINI_API_KEY || !env.GEMINI_MODEL)
        throw new Error('Export GEMINI_API_KEY and GEMINI_MODEL');
      return new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, env.AI_TIMEOUT_MS);
    case 'fake': {
      const fake = new FakeAiProvider();
      fake.script(
        ...fixtures.map((fixture) => ({
          json: { summary: fixture.referenceSummary, keyFacts: [], keyLegalIssues: [] },
        })),
      );
      return fake;
    }
    default:
      throw new Error(`Unknown provider "${name}" (openai, gemini or fake)`);
  }
}

async function main(): Promise<number> {
  if (values.feature !== 'summary') {
    throw new Error(`Unknown feature "${values.feature}" (available: summary)`);
  }
  const env = Env.parse(process.env);
  const fixtures = loadFixtures(join(__dirname, 'fixtures', 'summary'));
  const provider = buildProvider(values.provider, env, fixtures);

  const run = await runSummaryEvals(fixtures, provider, env.AI_MODEL_PRICES, {
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    temperature: env.AI_TEMPERATURE,
  });
  const date = new Date().toISOString().slice(0, 10);
  const report = renderReport(run, date);
  console.log(report);
  if (provider.name !== 'fake') {
    const dir = join(__dirname, '..', '..', '..', '..', 'docs', 'ai-evals');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${date}-${run.promptVersion}.md`);
    writeFileSync(file, report, { flag: 'wx' });
    console.log(`Saved ${file}`);
  }
  return checks(run).every((check) => check.pass) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
