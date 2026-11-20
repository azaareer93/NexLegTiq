import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Decimal } from 'decimal.js';
import { z } from 'zod';

import { percentile, rougeL, unsupportedCitations } from './metrics';
import { check, repairInstruction } from '../../src/modules/ai/ai-answer';
import { PiiRedactor } from '../../src/modules/ai/pii-redactor';
import {
  DOCUMENT_SUMMARY_V1,
  DocumentSummaryOutputSchema,
} from '../../src/modules/ai/prompts/document-summary.v1';
import {
  ProviderRequestError,
  ProviderUnavailableError,
} from '../../src/modules/ai/providers/ai-provider';
import type { AiCompletion, AiProvider } from '../../src/modules/ai/providers/ai-provider';
import { restoreDeep } from '../../src/modules/ai/redaction';

/** One synthetic document of the set and its owner-approved reference summary (README.md). */
export const EvalFixtureSchema = z.object({
  id: z.string().regex(/^(ar|en)-\d{2}-[a-z-]+$/),
  language: z.enum(['ar', 'en']),
  kind: z.enum(['PLEADING', 'JUDGMENT', 'CONTRACT', 'MINUTES']),
  /** The fictional people of the document, given to the redactor as production does with the file's parties. */
  names: z.array(z.string().min(1)).default([]),
  /** Paragraphs of the document. */
  text: z.array(z.string().min(1)).min(1),
  referenceSummary: z.string().min(50).max(1500),
});
export type EvalFixture = z.infer<typeof EvalFixtureSchema>;

/** The thresholds of D-195; a prompt or model change that fails one does not ship. */
export const THRESHOLDS = {
  rougeL: { en: 0.6, ar: 0.5 },
  schemaPassRate: 0.95,
  hallucinatedCitationRate: 0.05,
  p95LatencyMs: 10_000,
} as const;

export type Prices = Readonly<Record<string, { input: number; output: number }>>;

export interface DocumentResult {
  readonly id: string;
  readonly language: 'ar' | 'en';
  readonly schemaValid: boolean;
  /** The provider failed (unavailable, refused, timed out): counted apart from the schema pass rate. */
  readonly providerError: boolean;
  readonly rougeL: number;
  readonly unsupportedCitations: readonly string[];
  readonly latencyMs: number;
  readonly costUsd: Decimal;
  readonly error?: string;
}

export interface EvalRun {
  readonly feature: 'summary';
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly results: readonly DocumentResult[];
}

const FEATURE = 'document-summary';

/** Every `*.json` of a folder holds an array of fixtures (one file per language); ids must be unique. */
export function loadFixtures(dir: string): EvalFixture[] {
  const fixtures = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .flatMap((file) =>
      z.array(EvalFixtureSchema).parse(JSON.parse(readFileSync(join(dir, file), 'utf8'))),
    );
  const ids = new Set(fixtures.map((fixture) => fixture.id));
  if (ids.size !== fixtures.length) throw new Error(`Duplicate fixture ids in ${dir}`);
  return fixtures;
}

export const sourceText = (fixture: EvalFixture): string => fixture.text.join('\n\n');

const cost = (prices: Prices, model: string, answer: AiCompletion): Decimal => {
  const price = prices[model];
  if (!price) return new Decimal(0);
  return new Decimal(answer.inputTokens)
    .mul(price.input)
    .plus(new Decimal(answer.outputTokens).mul(price.output))
    .div(1_000_000);
};

export interface EvalOptions {
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

/**
 * Summarises one document the way `AiExecutor` does for a document that fits one call (D-148): the v1 prompt, PII
 * redaction, the same check and one repair call, names restored and checked again — then scores it against the reference.
 */
async function evaluate(
  fixture: EvalFixture,
  provider: AiProvider,
  prices: Prices,
  options: EvalOptions,
): Promise<DocumentResult> {
  const source = sourceText(fixture);
  const prompt = DOCUMENT_SUMMARY_V1.whole(fixture.language, source);
  const redacted = new PiiRedactor().redact([prompt.system, prompt.user], {
    names: fixture.names,
  });
  const [system = '', user = ''] = redacted.texts;
  const request = {
    feature: FEATURE,
    system,
    user,
    jsonSchema: z.toJSONSchema(DocumentSummaryOutputSchema, {
      io: 'input',
      unrepresentable: 'any',
    }),
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    // EXECUTE_DEADLINE_MS of ai-executor.ts (not imported: it carries Nest decorators tsx cannot compile).
    signal: AbortSignal.timeout(100_000),
  };
  const started = performance.now();
  let spent = new Decimal(0);
  const failed = (error: string, providerError = false): DocumentResult => ({
    id: fixture.id,
    language: fixture.language,
    schemaValid: false,
    providerError,
    rougeL: 0,
    unsupportedCitations: [],
    latencyMs: Math.round(performance.now() - started),
    costUsd: spent,
    error,
  });
  try {
    const first = await provider.complete(request);
    spent = spent.plus(cost(prices, provider.model, first));
    let answer = check(first.text, DocumentSummaryOutputSchema);
    if (!answer.ok) {
      const repair = await provider.complete({
        ...request,
        followUp: repairInstruction(answer.problem),
      });
      spent = spent.plus(cost(prices, provider.model, repair));
      answer = check(repair.text, DocumentSummaryOutputSchema);
    }
    if (!answer.ok) return failed(`schema: ${answer.problem}`);
    const restored = DocumentSummaryOutputSchema.safeParse(
      restoreDeep(answer.value, redacted.restore),
    );
    if (!restored.success) return failed('schema: after the names were restored');
    const output = restored.data;
    const everything = [
      output.summary,
      ...output.keyFacts,
      ...output.keyLegalIssues,
      ...output.dates.map((date) => date.event),
    ].join('\n');
    return {
      id: fixture.id,
      language: fixture.language,
      schemaValid: true,
      providerError: false,
      rougeL: rougeL(output.summary, fixture.referenceSummary),
      unsupportedCitations: unsupportedCitations(everything, source),
      latencyMs: Math.round(performance.now() - started),
      costUsd: spent,
    };
  } catch (error) {
    // Provider errors never quote the input (ai-provider.ts): their message is safe to report.
    if (error instanceof ProviderUnavailableError || error instanceof ProviderRequestError) {
      return failed(error.message, true);
    }
    return failed(error instanceof Error ? error.name : 'error', true);
  }
}

/** Runs the document summary over every fixture, one at a time (latency is measured per document). */
export async function runSummaryEvals(
  fixtures: readonly EvalFixture[],
  provider: AiProvider,
  prices: Prices = {},
  // The defaults of AI_MAX_OUTPUT_TOKENS and AI_TEMPERATURE (env.schema.ts); run.ts passes the shell's values.
  options: EvalOptions = { maxOutputTokens: 4096, temperature: 0.2 },
): Promise<EvalRun> {
  const results: DocumentResult[] = [];
  for (const fixture of fixtures) results.push(await evaluate(fixture, provider, prices, options));
  return {
    feature: 'summary',
    promptVersion: DOCUMENT_SUMMARY_V1.version,
    provider: provider.name,
    model: provider.model,
    results,
  };
}

export interface Check {
  readonly name: string;
  readonly value: string;
  readonly target: string;
  readonly pass: boolean;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** The run against the thresholds; every check must pass. */
export function checks(run: EvalRun): Check[] {
  const { results } = run;
  const rate = (count: number): number => (results.length === 0 ? 0 : count / results.length);
  const answered = results.filter((result) => !result.providerError);
  const providerErrors = results.length - answered.length;
  const schemaRate =
    answered.length === 0
      ? 0
      : answered.filter((result) => result.schemaValid).length / answered.length;
  const hallucinationRate = rate(
    results.filter((result) => result.unsupportedCitations.length > 0).length,
  );
  const p95 = percentile(
    results.map((result) => result.latencyMs),
    95,
  );
  const byLanguage = (['en', 'ar'] as const)
    .filter((language) => results.some((result) => result.language === language))
    .map((language): Check => {
      const value = mean(
        results.filter((result) => result.language === language).map((result) => result.rougeL),
      );
      return {
        name: `ROUGE-L (${language.toUpperCase()}, mean)`,
        value: value.toFixed(3),
        target: `≥ ${THRESHOLDS.rougeL[language]}`,
        pass: value >= THRESHOLDS.rougeL[language],
      };
    });
  return [
    ...byLanguage,
    {
      name: 'Schema pass rate',
      value: `${(schemaRate * 100).toFixed(1)}%`,
      target: `≥ ${THRESHOLDS.schemaPassRate * 100}%`,
      pass: answered.length > 0 && schemaRate >= THRESHOLDS.schemaPassRate,
    },
    {
      name: 'Provider errors',
      value: String(providerErrors),
      target: '0',
      pass: providerErrors === 0,
    },
    {
      name: 'Documents with a citation not in the source',
      value: `${(hallucinationRate * 100).toFixed(1)}%`,
      target: `< ${THRESHOLDS.hallucinatedCitationRate * 100}%`,
      pass: hallucinationRate < THRESHOLDS.hallucinatedCitationRate,
    },
    {
      name: 'Latency p95',
      value: `${(p95 / 1000).toFixed(1)} s`,
      target: `< ${THRESHOLDS.p95LatencyMs / 1000} s`,
      pass: p95 < THRESHOLDS.p95LatencyMs,
    },
  ];
}

/** The markdown report saved as `docs/ai-evals/<date>-<promptVersion>.md`. */
export function renderReport(run: EvalRun, date: string): string {
  const all = checks(run);
  const total = run.results.reduce((sum, result) => sum.plus(result.costUsd), new Decimal(0));
  const lines = [
    `# AI evals — ${run.feature} — ${run.promptVersion} — ${date}`,
    '',
    `Provider **${run.provider}**, model **${run.model}**, ${run.results.length} documents, total cost **$${total.toFixed(4)}**.`,
    run.provider === 'fake'
      ? 'Result: **HARNESS CHECK ONLY** — the fake provider answers with the references; never paste this as an eval.'
      : `Result: **${all.every((item) => item.pass) ? 'PASS' : 'FAIL'}** (thresholds: D-195).`,
    '',
    '| Check | Value | Target | |',
    '| --- | --- | --- | --- |',
    ...all.map(
      (check) =>
        `| ${check.name} | ${check.value} | ${check.target} | ${check.pass ? 'pass' : 'FAIL'} |`,
    ),
    '',
    '| Document | Schema | ROUGE-L | Citations not in source | Latency | Cost (USD) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...run.results.map(
      (result) =>
        `| ${result.id} | ${result.schemaValid ? 'ok' : `FAIL${result.error ? ` (${result.error})` : ''}`} | ${result.rougeL.toFixed(3)} | ${result.unsupportedCitations.join(', ') || '—'} | ${(result.latencyMs / 1000).toFixed(1)} s | ${result.costUsd.toFixed(6)} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
