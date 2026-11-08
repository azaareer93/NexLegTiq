import type { Response } from 'express';

import { AiSummariesController } from './ai-summaries.controller';
import { AiSummariesService } from './ai-summaries.service';
import type { PrismaService } from '../../database/prisma.service';
import type { AiAccess } from '../ai/ai-access';
import type { AiJobs } from '../ai/ai-jobs';
import type { DocumentAccessService } from '../documents/document-access.service';

const DOC = '01920000-0000-7000-8000-000000000001';
const row = (language: string, id: string) => ({
  id,
  sourceType: 'DOCUMENT',
  sourceId: DOC,
  fileId: '01920000-0000-7000-8000-000000000002',
  versionNumber: 1,
  language,
  summary: 'A summary.',
  keyFacts: [],
  keyLegalIssues: [],
  parties: [],
  dates: [],
  provider: 'fake',
  model: 'fake-1',
  promptVersion: 'document-summary.v1',
  chunks: 1,
  createdAt: new Date('2026-10-26T10:00:00Z'),
});

function setup({ status = 'READY', rows = [] as object[], withText = 1 } = {}) {
  const db = {
    document: { findFirstOrThrow: jest.fn().mockResolvedValue({ status, currentVersion: 1 }) },
    aiSummary: { findMany: jest.fn().mockResolvedValue(rows) },
    documentText: { count: jest.fn().mockResolvedValue(withText) },
  };
  const jobs = { enqueue: jest.fn().mockResolvedValue({ jobId: DOC, status: 'QUEUED' }) };
  const service = new AiSummariesService(
    { assertEnabled: jest.fn() } as unknown as AiAccess,
    { assertDocumentAccess: jest.fn() } as unknown as DocumentAccessService,
    jobs as unknown as AiJobs,
    { db } as unknown as PrismaService,
  );
  return { service, jobs };
}

const BODY = { sourceType: 'DOCUMENT', sourceId: DOC, language: 'AR' } as const;

describe('AiSummariesService (D-148)', () => {
  it('should answer 200 with a stored summary, else queue the job (202)', async () => {
    const stored = setup({ rows: [row('AR', DOC)] });
    await expect(stored.service.request(BODY)).resolves.toMatchObject({
      status: 200,
      summary: { id: DOC, createdAt: '2026-10-26T10:00:00.000Z' },
    });
    expect(stored.jobs.enqueue).not.toHaveBeenCalled();
    const queued = setup();
    await expect(queued.service.request(BODY)).resolves.toMatchObject({ status: 202 });
    expect(queued.jobs.enqueue).toHaveBeenCalledWith({
      type: 'summarize-document',
      sourceType: 'DOCUMENT',
      sourceId: DOC,
      fields: { documentId: DOC, versionNumber: 1, language: 'AR' },
      dedupeKey: `summary:${DOC}:v1:AR`,
    });
  });

  it('should refuse a document that is not ready, quarantined or without text', async () => {
    await expect(setup({ status: 'SCANNING' }).service.request(BODY)).rejects.toMatchObject({
      code: 'BIZ-015',
    });
    await expect(setup({ status: 'QUARANTINED' }).service.request(BODY)).rejects.toMatchObject({
      code: 'STO-004',
    });
    await expect(setup({ withText: 0 }).service.request(BODY)).rejects.toMatchObject({
      code: 'BIZ-020',
    });
  });

  it('should list the newest summary per language only', async () => {
    const other = '01920000-0000-7000-8000-000000000009';
    const { service } = setup({ rows: [row('EN', DOC), row('AR', other), row('EN', other)] });
    const list = await service.list({ sourceType: 'DOCUMENT', sourceId: DOC });
    expect(list.map((summary) => [summary.language, summary.id])).toEqual([
      ['EN', DOC],
      ['AR', other],
    ]);
  });

  it('should answer with the status the service chose', async () => {
    const { service } = setup();
    const controller = new AiSummariesController(service);
    const res = { status: jest.fn() };
    await expect(controller.create(BODY, res as unknown as Response)).resolves.toMatchObject({
      status: 'QUEUED',
    });
    expect(res.status).toHaveBeenCalledWith(202);
    await expect(controller.list({ sourceType: 'DOCUMENT', sourceId: DOC })).resolves.toEqual([]);
  });
});
