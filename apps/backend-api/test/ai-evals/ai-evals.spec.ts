import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Decimal } from 'decimal.js';

import { checks, loadFixtures, renderReport, runSummaryEvals, sourceText } from './harness';
import type { DocumentResult, EvalFixture, EvalRun } from './harness';
import { extractCitations, percentile, rougeL, tokenize, unsupportedCitations } from './metrics';
import { ProviderUnavailableError } from '../../src/modules/ai/providers/ai-provider';
import { FakeAiProvider } from '../../src/modules/ai/providers/fake.provider';
import type { FakeStep } from '../../src/modules/ai/providers/fake.provider';
import { splitText } from '../../src/modules/ai-summaries/split-text';

const fixtures = loadFixtures(join(__dirname, 'fixtures', 'summary'));
const pick = (index: number): EvalFixture => {
  const fixture = fixtures.at(index);
  if (!fixture) throw new Error('fixture set is empty');
  return fixture;
};
const first = pick(0);
const last = pick(-1);
const answer = (summary: string, keyFacts: string[] = []): FakeStep => ({
  json: { summary, keyFacts, keyLegalIssues: [] },
});

describe('ai-evals metrics', () => {
  describe('tokenize', () => {
    it('should fold Arabic letter variants, diacritics and Arabic-Indic digits', () => {
      expect(tokenize('أُجِّلت الدعوى إلى ٣/١٢/٢٠٢٥.')).toEqual(
        tokenize('اجلت الدعوى الى 3/12/2025'),
      );
    });

    it('should lower-case and drop punctuation', () => {
      expect(tokenize('The Court, held: "No."')).toEqual(['the', 'court', 'held', 'no']);
    });
  });

  describe('rougeL', () => {
    it('should be 1 for the same text and 0 for texts without a common word', () => {
      expect(rougeL('the court dismissed the appeal', 'The court dismissed the appeal.')).toBe(1);
      expect(rougeL('alpha beta', 'gamma delta')).toBe(0);
      expect(rougeL('', 'gamma delta')).toBe(0);
    });

    it('should be the F1 of the longest common subsequence', () => {
      // LCS "the court the appeal" = 4; precision 4/5, recall 4/6 → F1 = 8/11.
      expect(
        rougeL('the court rejected the appeal', 'the court dismissed and the appeal'),
      ).toBeCloseTo(8 / 11, 10);
    });

    it('should score Arabic text in the same way', () => {
      expect(rougeL('ردت المحكمة الاستئناف', 'ردّت المحكمةُ الاستئنافَ')).toBe(1);
    });
  });

  describe('extractCitations', () => {
    it('should find English articles, laws and case numbers', () => {
      expect(
        extractCitations(
          'Under Article 74 of the Civil Procedure Law No. 2 of 2001, in Claim No. 418/2025 and Appeal No. 9 / 2024',
        ),
      ).toEqual(new Set(['article:74', 'law:2/2001', 'case:418/2025', 'case:9/2024']));
    });

    it('should find Arabic articles, laws and case numbers in either digit style', () => {
      expect(
        extractCitations(
          'استناداً إلى المادة (٤٥) وللمادة 47 من قانون العمل رقم (7) لسنة 2000 في الدعوى الحقوقية رقم ٥٠١/٢٠٢٥',
        ),
      ).toEqual(new Set(['article:45', 'article:47', 'law:7/2000', 'case:501/2025']));
    });

    it('should find plurals, lists and other spellings', () => {
      expect(extractCitations('Articles 74 and 80, Art. 5 & 6, Law No. 2/2001')).toEqual(
        new Set(['article:74', 'article:80', 'article:5', 'article:6', 'law:2/2001']),
      );
      expect(extractCitations('المادتين 12 و13 والمواد (5)، (6) والمادّة 7 والماده 8')).toEqual(
        new Set(['article:12', 'article:13', 'article:5', 'article:6', 'article:7', 'article:8']),
      );
      expect(extractCitations('قانون التحكيم رقم 3/2000 في القضيه رقم 9/2024')).toEqual(
        new Set(['law:3/2000', 'case:9/2024']),
      );
    });

    it('should not read a contract section or a bare number as a citation', () => {
      expect(extractCitations('Under section 3 of this agreement, 12 units are due.').size).toBe(0);
    });

    it('should find nothing in a text without citations', () => {
      expect(extractCitations('The parties met on 3 March 2025 and agreed to settle.').size).toBe(
        0,
      );
    });
  });

  describe('unsupportedCitations', () => {
    it('should list only the citations the source does not make', () => {
      const source = 'The claim relies on Article 74 of Law No. 2 of 2001.';
      expect(
        unsupportedCitations('Article 74 and Article 80 of Law No. 2 of 2001 apply.', source),
      ).toEqual(['article:80']);
      expect(unsupportedCitations('وفق المادة (74)', source)).toEqual([]);
    });
  });

  describe('percentile', () => {
    it('should use the nearest rank', () => {
      expect(percentile([], 95)).toBe(0);
      expect(percentile([5], 95)).toBe(5);
      expect(
        percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 95),
      ).toBe(19);
    });
  });
});

describe('ai-evals fixture set', () => {
  it('should hold 10 Arabic and 10 English documents covering every kind in each language', () => {
    for (const language of ['ar', 'en'] as const) {
      const set = fixtures.filter((fixture) => fixture.language === language);
      expect(set).toHaveLength(10);
      expect(new Set(set.map((fixture) => fixture.kind))).toEqual(
        new Set(['PLEADING', 'JUDGMENT', 'CONTRACT', 'MINUTES']),
      );
      expect(set.every((fixture) => fixture.id.startsWith(`${language}-`))).toBe(true);
    }
  });

  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))(
    'should give %s a reference that cites only its source and names that appear in it',
    (_id: string, fixture: EvalFixture) => {
      const source = sourceText(fixture);
      expect(unsupportedCitations(fixture.referenceSummary, source)).toEqual([]);
      for (const name of fixture.names) expect(source).toContain(name);
      // The set holds one-call documents only (D-195), as production splits them.
      expect(splitText(source.trim())).toHaveLength(1);
    },
  );

  it('should refuse two fixtures with the same id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-evals-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify([first]));
    writeFileSync(join(dir, 'b.json'), JSON.stringify([first]));

    expect(() => loadFixtures(dir)).toThrow('Duplicate fixture ids');
  });

  it('should refuse a malformed fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-evals-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify([{ ...first, language: 'fr' }]));

    expect(() => loadFixtures(dir)).toThrow();
  });
});

describe('runSummaryEvals', () => {
  const two = [first, last];

  it('should pass every threshold when the model answers with the references', async () => {
    const fake = new FakeAiProvider();
    fake.script(...fixtures.map((fixture) => answer(fixture.referenceSummary)));

    const run = await runSummaryEvals(fixtures, fake);

    expect(run.results).toHaveLength(20);
    expect(run.results.every((result) => result.schemaValid && result.rougeL === 1)).toBe(true);
    expect(checks(run).every((check) => check.pass)).toBe(true);
    expect(run.promptVersion).toBe('document-summary.v1');
  });

  it('should send redacted text, never the fixture names', async () => {
    const fake = new FakeAiProvider();
    fake.script(...two.map((fixture) => answer(fixture.referenceSummary)));

    await runSummaryEvals(two, fake);

    two.forEach((fixture, index) => {
      for (const name of fixture.names) expect(fake.requests[index]?.user).not.toContain(name);
    });
  });

  it('should repair one invalid answer and fail a document whose repair is invalid too', async () => {
    const fake = new FakeAiProvider();
    fake.script(
      { text: 'not json' },
      answer(first.referenceSummary),
      { json: { summary: 'short' } },
      { text: '{}' },
    );

    const run = await runSummaryEvals(two, fake);

    expect(fake.requests).toHaveLength(4);
    expect(fake.requests[1]?.followUp).toContain('not JSON');
    expect(run.results[0]?.schemaValid).toBe(true);
    expect(run.results[1]).toMatchObject({ schemaValid: false, rougeL: 0 });
    expect(checks(run).find((check) => check.name === 'Schema pass rate')?.pass).toBe(false);
  });

  it('should flag a citation the document does not make and fail the threshold', async () => {
    const fake = new FakeAiProvider();
    fake.script(
      answer(first.referenceSummary, ['The court also applied Article 999 of the Civil Code.']),
      answer(last.referenceSummary),
    );

    const run = await runSummaryEvals(two, fake);

    expect(run.results[0]?.unsupportedCitations).toEqual(['article:999']);
    expect(
      checks(run).find((check) => check.name.startsWith('Documents with a citation'))?.pass,
    ).toBe(false);
    expect(renderReport(run, '2026-11-21')).toContain('article:999');
  });

  it('should count a provider error apart from the schema rate and price the calls it made', async () => {
    const fake = new FakeAiProvider();
    fake.script(
      { error: new ProviderUnavailableError('fake', 'rate-limited', 429) },
      answer(last.referenceSummary),
    );

    const run = await runSummaryEvals(two, fake, { 'fake-1': { input: 1_000_000, output: 0 } });

    expect(run.results[0]).toMatchObject({
      schemaValid: false,
      providerError: true,
      error: 'fake unavailable: rate-limited (429)',
    });
    expect(run.results[0]?.costUsd.toNumber()).toBe(0);
    expect(run.results[1]?.costUsd.toNumber()).toBeGreaterThan(0);
    const byName = new Map(checks(run).map((check) => [check.name, check]));
    expect(byName.get('Schema pass rate')?.pass).toBe(true);
    expect(byName.get('Provider errors')).toMatchObject({ value: '1', pass: false });
  });

  it('should record any other error by its name only', async () => {
    const fake = new FakeAiProvider();
    fake.script({ error: new TypeError('may quote the input') });

    const run = await runSummaryEvals([first], fake);

    expect(run.results[0]).toMatchObject({ providerError: true, error: 'TypeError' });
  });

  it('should fail a document whose answer breaks the schema once the names are restored', async () => {
    const fake = new FakeAiProvider();
    // A placeholder at the 200-character limit of a party grows past it when the long name comes back.
    const name = 'Abcdefghijklmnopqrstuvwxyz Testlongname';
    const long = { ...first, names: [name], text: [...first.text, `Party: ${name}.`] };
    fake.script({
      json: {
        summary: first.referenceSummary,
        keyFacts: [],
        keyLegalIssues: [],
        parties: [`[PARTY_1] ${'x'.repeat(190)}`],
      },
    });

    const run = await runSummaryEvals([long], fake);

    expect(run.results[0]).toMatchObject({
      schemaValid: false,
      error: 'schema: after the names were restored',
    });
  });
});

describe('renderReport', () => {
  it('should state the result, the checks and one row per document', async () => {
    const fake = new FakeAiProvider();
    const one = [first];
    fake.script(answer(first.referenceSummary));

    const report = renderReport(await runSummaryEvals(one, fake), '2026-11-21');

    expect(report).toContain('# AI evals — summary — document-summary.v1 — 2026-11-21');
    expect(report).toContain('Result: **HARNESS CHECK ONLY**');
    expect(report).toContain(`| ${first.id} | ok | 1.000 |`);
  });

  it('should say PASS or FAIL for a real provider', () => {
    const run: EvalRun = { ...base, results: [result()] };

    expect(renderReport(run, '2026-11-21')).toContain('Result: **PASS**');
    expect(renderReport({ ...run, results: [result({ rougeL: 0.1 })] }, '2026-11-21')).toContain(
      'Result: **FAIL**',
    );
  });
});

const base = { feature: 'summary', promptVersion: 'v', provider: 'openai', model: 'm' } as const;
const result = (overrides: Partial<DocumentResult> = {}): DocumentResult => ({
  id: 'en-01-x',
  language: 'en',
  schemaValid: true,
  providerError: false,
  rougeL: 1,
  unsupportedCitations: [],
  latencyMs: 1000,
  costUsd: new Decimal(0),
  ...overrides,
});
const verdicts = (results: DocumentResult[]): Record<string, boolean> =>
  Object.fromEntries(checks({ ...base, results }).map((check) => [check.name, check.pass]));

describe('checks', () => {
  it('should hold each language to its own ROUGE-L threshold', () => {
    expect(
      verdicts([result({ rougeL: 0.59 }), result({ id: 'ar-01-x', language: 'ar', rougeL: 0.5 })]),
    ).toMatchObject({ 'ROUGE-L (EN, mean)': false, 'ROUGE-L (AR, mean)': true });
  });

  it('should fail a p95 latency of exactly 10 s', () => {
    expect(verdicts([result({ latencyMs: 9_999 })])['Latency p95']).toBe(true);
    expect(verdicts([result({ latencyMs: 10_000 })])['Latency p95']).toBe(false);
  });

  it('should fail an empty run', () => {
    expect(verdicts([])['Schema pass rate']).toBe(false);
  });
});
