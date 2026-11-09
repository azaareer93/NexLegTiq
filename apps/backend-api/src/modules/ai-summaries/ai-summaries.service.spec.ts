import type { Response } from 'express';
import type { ClsService } from 'nestjs-cls';

import { AiSummariesController } from './ai-summaries.controller';
import { AiSummariesService } from './ai-summaries.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { AiAccess } from '../ai/ai-access';
import type { AiJobs } from '../ai/ai-jobs';
import type { DocumentAccessService } from '../documents/document-access.service';
import type { CaseAccessService } from '../legal-files/case-access.service';

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

function setup({
  status = 'READY',
  rows = [] as object[],
  withText = 1,
  docs = [] as object[],
} = {}) {
  const db = {
    document: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ status, currentVersion: 1 }),
      findMany: jest.fn().mockResolvedValue(docs),
    },
    aiSummary: {
      findMany: jest.fn().mockResolvedValue(rows),
      findFirst: jest.fn().mockResolvedValue(rows[0] ? { sourceId: DOC } : null),
    },
    documentText: { count: jest.fn().mockResolvedValue(withText) },
  };
  const tx = { aiFeedback: { create: jest.fn().mockResolvedValue({ id: 'f1' }) } };
  const audit = { log: jest.fn() };
  const assertDocumentAccess = jest.fn();
  const assertFileAccess = jest.fn();
  const jobs = { enqueue: jest.fn().mockResolvedValue({ jobId: DOC, status: 'QUEUED' }) };
  const service = new AiSummariesService(
    { assertEnabled: jest.fn() } as unknown as AiAccess,
    { assertDocumentAccess, visibleWhere: jest.fn() } as unknown as DocumentAccessService,
    jobs as unknown as AiJobs,
    { db } as unknown as PrismaService,
    { assertFileAccess } as unknown as CaseAccessService,
    audit as unknown as AuditService,
    { run: (work: (tx: unknown) => unknown) => work(tx) } as unknown as UnitOfWork,
    {
      get: (key: string) => (key === 'userId' ? 'u1' : 'o1'),
    } as unknown as ClsService<RequestContext>,
  );
  return { service, jobs, audit, tx, db, assertDocumentAccess, assertFileAccess };
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

  it('should queue a new job for a forced regeneration even when a summary is stored', async () => {
    const { service, jobs } = setup({ rows: [row('AR', DOC)] });
    await expect(service.request({ ...BODY, force: true })).resolves.toMatchObject({ status: 202 });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: { documentId: DOC, versionNumber: 1, language: 'AR', force: true },
      }),
    );
  });

  it('should store feedback without the comment in the audit row, and 404 an unknown summary', async () => {
    const { service, audit, tx } = setup({ rows: [row('AR', DOC)] });
    await expect(
      service.feedback(DOC, { reason: 'INACCURATE', comment: 'secret' }),
    ).resolves.toEqual({ id: 'f1' });
    expect(tx.aiFeedback.create).toHaveBeenCalled();
    const entry = JSON.stringify(audit.log.mock.calls);
    expect(entry).toContain('hasComment');
    expect(entry).not.toContain('secret');
    await expect(setup().service.feedback(DOC, { reason: 'OTHER' })).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should list the summaries of a file newest per document and language, with the document name', async () => {
    const other = '01920000-0000-7000-8000-000000000009';
    const { service, assertFileAccess } = setup({
      docs: [
        { id: DOC, name: 'Claim', currentVersion: 1 },
        { id: other, name: 'Reply', currentVersion: 1 },
      ],
      rows: [
        row('EN', DOC),
        { ...row('EN', 'x1'), id: 'dup' },
        { ...row('AR', other), sourceId: other },
      ],
    });
    const items = await service.list({ fileId: '01920000-0000-7000-8000-000000000002' });
    expect(assertFileAccess).toHaveBeenCalledWith('01920000-0000-7000-8000-000000000002', 'read');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ source: { type: 'DOCUMENT', id: DOC, name: 'Claim' } });
    expect(items[1]).toMatchObject({ source: { id: other, name: 'Reply' } });
  });

  it('should answer an empty list for a file without visible documents and refuse a hidden file', async () => {
    const empty = setup();
    await expect(empty.service.list({ fileId: DOC })).resolves.toEqual([]);
    expect(empty.db.aiSummary.findMany).not.toHaveBeenCalled();
    const hidden = setup();
    hidden.assertFileAccess.mockRejectedValue(new Error('404'));
    await expect(hidden.service.list({ fileId: DOC })).rejects.toThrow('404');
  });

  it('should audit feedback without a comment as hasComment false and refuse a hidden document', async () => {
    const { service, audit, tx, assertDocumentAccess } = setup({ rows: [row('AR', DOC)] });
    await service.feedback(DOC, { reason: 'OTHER' });
    expect(tx.aiFeedback.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ comment: null }) }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ newValues: expect.objectContaining({ hasComment: false }) }),
    );
    assertDocumentAccess.mockRejectedValue(new Error('404'));
    await expect(service.feedback(DOC, { reason: 'OTHER' })).rejects.toThrow('404');
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
