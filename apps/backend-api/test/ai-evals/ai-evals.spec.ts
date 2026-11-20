import { join } from 'node:path';

import { checks, loadFixtures, renderReport, runSummaryEvals, sourceText } from './harness';
import type { EvalFixture } from './harness';
import { extractCitations, percentile, rougeL, tokenize, unsupportedCitations } from './metrics';
import { FakeAiProvider } from '../../src/modules/ai/providers/fake.provider';
import type { FakeStep } from '../../src/modules/ai/providers/fake.provider';

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
    },
  );
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

  it('should record a provider error as a failed document and price the calls it made', async () => {
    const fake = new FakeAiProvider();
    fake.script({ error: new Error('down') }, answer(last.referenceSummary));

    const run = await runSummaryEvals(two, fake, { 'fake-1': { input: 1_000_000, output: 0 } });

    expect(run.results[0]).toMatchObject({ schemaValid: false, error: 'Error' });
    expect(run.results[0]?.costUsd.toNumber()).toBe(0);
    expect(run.results[1]?.costUsd.toNumber()).toBeGreaterThan(0);
  });
});

describe('renderReport', () => {
  it('should state the result, the checks and one row per document', async () => {
    const fake = new FakeAiProvider();
    const one = [first];
    fake.script(answer(first.referenceSummary));

    const report = renderReport(await runSummaryEvals(one, fake), '2026-11-21');

    expect(report).toContain('# AI evals — summary — document-summary.v1 — 2026-11-21');
    expect(report).toContain('Result: **PASS**');
    expect(report).toContain(`| ${first.id} | ok | 1.000 |`);
  });
});
