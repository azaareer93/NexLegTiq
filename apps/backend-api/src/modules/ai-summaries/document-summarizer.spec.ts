import type { ClsService } from 'nestjs-cls';

import { DocumentSummarizer } from './document-summarizer';
import type { RequestContext } from '../../common/context/request-context';
import type { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { AiAccess } from '../ai/ai-access';
import type { AiExecutor } from '../ai/ai-executor';
import { AiJobRegistry } from '../ai/ai-job-registry';

const SUMMARY = {
  summary: 'x'.repeat(60),
  keyFacts: [],
  keyLegalIssues: [],
  parties: [],
  dates: [],
};
const CONTEXT = { aiJobId: 'j1', userId: 'u1', signal: new AbortController().signal };
const FIELDS = { documentId: '01920000-0000-7000-8000-000000000001', language: 'AR' };
const FILE = {
  responsibleLawyer: { fullName: 'Lawyer' },
  clients: [],
  parties: [],
  teamMembers: [],
};

function setup({
  document = { id: FIELDS.documentId, fileId: 'f1', currentVersion: 2 } as object | null,
  existing = null as object | null,
  text = 'Some text.' as string | null,
} = {}) {
  const tx = {
    aiSummary: { create: jest.fn().mockResolvedValue({ id: 's1' }) },
    caseTimelineEvent: { create: jest.fn() },
  };
  const db = {
    document: { findFirst: jest.fn().mockResolvedValue(document) },
    aiSummary: { findFirst: jest.fn().mockResolvedValue(existing) },
    documentText: { findFirst: jest.fn().mockResolvedValue(text === null ? null : { text }) },
    legalFile: { findFirstOrThrow: jest.fn().mockResolvedValue(FILE) },
  };
  const executor = {
    execute: jest.fn().mockResolvedValue({
      value: SUMMARY,
      provider: 'fake',
      model: 'fake-1',
      promptVersion: 'document-summary.v1',
      cached: false,
    }),
  };
  const access = { assertQuota: jest.fn() };
  const realtime = { toUser: jest.fn() };
  const registry = new AiJobRegistry();
  const service = new DocumentSummarizer(
    executor as unknown as AiExecutor,
    access as unknown as AiAccess,
    { db } as unknown as PrismaService,
    {
      run: (work: (t: unknown, after: (task: () => unknown) => void) => unknown) =>
        work(tx, (task) => void task()),
    } as unknown as UnitOfWork,
    realtime as unknown as RealtimePublisher,
    registry,
    { get: () => 'o1' } as unknown as ClsService<RequestContext>,
  );
  service.onModuleInit();
  return { service, registry, executor, access, realtime, tx };
}

describe('DocumentSummarizer (D-148)', () => {
  it('should register its job and summarise a short document in one counted call', async () => {
    const { registry, executor, access, realtime, tx } = setup();
    const handler = registry.get('summarize-document');
    await expect(handler?.(FIELDS, CONTEXT)).resolves.toEqual({ summaryId: 's1' });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute.mock.calls[0]?.[0]).not.toHaveProperty('partial');
    expect(access.assertQuota).not.toHaveBeenCalled();
    expect(tx.aiSummary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ versionNumber: 2, language: 'AR', chunks: 1, aiJobId: 'j1' }),
      select: { id: true },
    });
    expect(realtime.toUser).toHaveBeenCalledWith('u1', 'document.summary.ready', {
      documentId: FIELDS.documentId,
      fileId: 'f1',
    });
  });

  it('should check the quota once and not count the parts of a long document', async () => {
    const { service, executor, access } = setup({ text: `${'a '.repeat(40_000)}\n\n`.repeat(3) });
    await service.run({ ...FIELDS, language: 'EN' }, CONTEXT);
    expect(access.assertQuota).toHaveBeenCalledTimes(1);
    const calls = executor.execute.mock.calls.map(([options]) => options as { partial?: boolean });
    expect(calls.filter((options) => options.partial)).toHaveLength(calls.length - 1);
  });

  it('should reuse a stored summary, and refuse a missing document or one without text', async () => {
    const reused = setup({ existing: { id: 's0' } });
    await expect(reused.service.run(FIELDS, CONTEXT)).resolves.toEqual({ summaryId: 's0' });
    expect(reused.executor.execute).not.toHaveBeenCalled();
    await expect(setup({ document: null }).service.run(FIELDS, CONTEXT)).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(setup({ text: '  ' }).service.run(FIELDS, CONTEXT)).rejects.toMatchObject({
      code: 'BIZ-020',
    });
    await expect(setup({ text: null }).service.run(FIELDS, CONTEXT)).rejects.toMatchObject({
      code: 'BIZ-020',
    });
    await expect(setup().service.run({ documentId: 'x' }, CONTEXT)).rejects.toThrow();
  });
});
