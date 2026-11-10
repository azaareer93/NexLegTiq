import type { ClsService } from 'nestjs-cls';

import { DocumentSummarizer } from './document-summarizer';
import type { RequestContext } from '../../common/context/request-context';
import type { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { AiAccess } from '../ai/ai-access';
import type { AiExecutor } from '../ai/ai-executor';
import { AiJobRegistry } from '../ai/ai-job-registry';
import { testTimeline } from '../timeline/timeline.test-helper';

const SUMMARY = {
  summary: 'x'.repeat(60),
  keyFacts: [],
  keyLegalIssues: [],
  parties: [],
  dates: [],
};
const CONTEXT = { aiJobId: 'j1', userId: 'u1', signal: new AbortController().signal };
const FIELDS = {
  documentId: '01920000-0000-7000-8000-000000000001',
  versionNumber: 2,
  language: 'AR',
};
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
    aiSummary: {
      create: jest.fn().mockResolvedValue({ id: 's1' }),
      aggregate: jest.fn().mockResolvedValue({ _max: { regeneration: 0 } }),
    },
    caseTimelineEvent: { create: jest.fn() },
  };
  const db = {
    document: { findFirst: jest.fn().mockResolvedValue(document) },
    aiSummary: { findFirst: jest.fn().mockResolvedValue(existing), findFirstOrThrow: jest.fn() },
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
    testTimeline({ get: () => 'o1' }),
  );
  service.onModuleInit();
  return { service, registry, executor, access, realtime, tx, db };
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

  it('should check the quota once and count a long document once, its first part', async () => {
    const { service, executor, access } = setup({ text: `${'a '.repeat(40_000)}\n\n`.repeat(3) });
    await service.run({ ...FIELDS, language: 'EN' }, CONTEXT);
    expect(access.assertQuota).toHaveBeenCalledTimes(1);
    const calls = executor.execute.mock.calls.map(
      ([options]) => options as { partial?: boolean; cacheKey?: string[] },
    );
    const parts = calls.length - 1;
    expect(calls.map((options) => options.partial)).toEqual([false, ...Array(parts).fill(true)]);
    // Each part is cached (a retry does not pay again); the merge is not.
    expect(calls[0]?.cacheKey).toEqual([FIELDS.documentId, 'v2', 'EN', `0/${parts}`]);
    expect(calls.at(-1)?.cacheKey).toBeUndefined();
  });

  it('should key a forced regeneration part notes by its job and still count once', async () => {
    const { service, executor, access } = setup({
      text: `${'a '.repeat(40_000)}

`.repeat(3),
    });
    await service.run({ ...FIELDS, language: 'EN', force: true }, CONTEXT);
    const calls = executor.execute.mock.calls.map(
      ([options]) => options as { partial?: boolean; cacheKey?: string[] },
    );
    expect(calls[0]?.cacheKey).toEqual([
      FIELDS.documentId,
      'v2',
      'EN',
      'job-j1',
      `0/${calls.length - 1}`,
    ]);
    expect(calls.filter((options) => !options.partial)).toHaveLength(1);
    expect(access.assertQuota).toHaveBeenCalledTimes(1);
  });

  it('should store a regeneration as the next number, and reuse only its own job row when forced', async () => {
    const first = setup();
    first.tx.aiSummary.aggregate.mockResolvedValue({ _max: { regeneration: 2 } });
    await first.service.run({ ...FIELDS, force: true }, CONTEXT);
    expect(first.tx.aiSummary.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ regeneration: 3 }) }),
    );
    const none = setup();
    none.tx.aiSummary.aggregate.mockResolvedValue({ _max: { regeneration: null } });
    await none.service.run({ ...FIELDS, force: true }, CONTEXT);
    expect(none.tx.aiSummary.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ regeneration: 0 }) }),
    );
    const retry = setup({ existing: { id: 's7' } });
    await expect(retry.service.run({ ...FIELDS, force: true }, CONTEXT)).resolves.toEqual({
      summaryId: 's7',
    });
    expect(retry.db.aiSummary.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ aiJobId: 'j1' }) }),
    );
  });

  it('should end as superseded when a newer version arrived, and keep a summary a racing job stored', async () => {
    const newer = setup({ document: { id: FIELDS.documentId, fileId: 'f1', currentVersion: 3 } });
    await expect(newer.service.run(FIELDS, CONTEXT)).resolves.toEqual({ superseded: 1 });
    expect(newer.executor.execute).not.toHaveBeenCalled();
    const raced = setup();
    raced.tx.aiSummary.create.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { name: 'PrismaClientKnownRequestError', code: 'P2002' }),
    );
    raced.db.aiSummary.findFirstOrThrow.mockResolvedValueOnce({ id: 's9' });
    await expect(raced.service.run(FIELDS, CONTEXT)).resolves.toEqual({ summaryId: 's9' });
    expect(raced.realtime.toUser).toHaveBeenCalledWith('u1', 'document.summary.ready', {
      documentId: FIELDS.documentId,
      fileId: 'f1',
    });
  });

  it('should reuse a stored summary, and refuse a missing document or one without text', async () => {
    const reused = setup({ existing: { id: 's0' } });
    await expect(reused.service.run(FIELDS, CONTEXT)).resolves.toEqual({ summaryId: 's0' });
    expect(reused.executor.execute).not.toHaveBeenCalled();
    expect(reused.realtime.toUser).toHaveBeenCalledWith('u1', 'document.summary.ready', {
      documentId: FIELDS.documentId,
      fileId: 'f1',
    });
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
