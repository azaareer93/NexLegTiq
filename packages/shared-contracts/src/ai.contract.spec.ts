import { AiSummaryQuerySchema, AiSummarySchema, CreateAiSummarySchema } from './ai.contract.js';
import { REALTIME_EVENTS, RealtimePayloadSchemas } from './realtime.contract.js';

const ID = '01920000-0000-7000-8000-000000000001';

describe('AI summary contracts (D-148)', () => {
  it('should accept a document summary request in Arabic or English only', () => {
    expect(
      CreateAiSummarySchema.parse({ sourceType: 'DOCUMENT', sourceId: ID, language: 'AR' }),
    ).toEqual({
      sourceType: 'DOCUMENT',
      sourceId: ID,
      language: 'AR',
    });
    expect(
      CreateAiSummarySchema.safeParse({ sourceType: 'DOCUMENT', sourceId: ID, language: 'FR' })
        .success,
    ).toBe(false);
    expect(
      CreateAiSummarySchema.safeParse({ sourceType: 'SESSION', sourceId: ID, language: 'EN' })
        .success,
    ).toBe(false);
  });

  it('should refuse a malformed source id in the query', () => {
    expect(AiSummaryQuerySchema.safeParse({ sourceType: 'DOCUMENT', sourceId: 'x' }).success).toBe(
      false,
    );
  });

  it('should read a stored summary and refuse zero chunks', () => {
    const summary = {
      id: ID,
      sourceType: 'DOCUMENT',
      sourceId: ID,
      fileId: ID,
      versionNumber: 2,
      language: 'EN',
      summary: 'A claim for unpaid rent.',
      keyFacts: ['Rent unpaid since March'],
      keyLegalIssues: ['Breach of lease'],
      parties: ['Plaintiff'],
      dates: [{ date: '1 March 2026', event: 'First missed payment' }],
      provider: 'fake',
      model: 'fake-1',
      promptVersion: 'document-summary.v1',
      chunks: 1,
      createdAt: '2026-11-08T10:00:00.000Z',
    };
    expect(AiSummarySchema.parse(summary)).toEqual(summary);
    expect(AiSummarySchema.safeParse({ ...summary, chunks: 0 }).success).toBe(false);
  });
});

describe('document.summary.ready (D-148, D-129)', () => {
  it('should carry ids only', () => {
    expect(REALTIME_EVENTS).toContain('document.summary.ready');
    const schema = RealtimePayloadSchemas['document.summary.ready'];
    expect(schema.parse({ documentId: ID, fileId: ID })).toEqual({ documentId: ID, fileId: ID });
    expect(schema.safeParse({ documentId: ID }).success).toBe(false);
  });
});
