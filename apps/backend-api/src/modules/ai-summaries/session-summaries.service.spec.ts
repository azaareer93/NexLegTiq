import type { ClsService } from 'nestjs-cls';

import { addDays, SessionSummariesService } from './session-summaries.service';
import { SessionSummarizer } from './session-summarizer';
import type { RequestContext } from '../../common/context/request-context';
import type { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { AiExecutor } from '../ai/ai-executor';
import type { AiJobRegistry } from '../ai/ai-job-registry';
import type { AiJobs } from '../ai/ai-jobs';
import type { ClientInfo } from '../auth/client-info';
import type { CaseAccessService } from '../legal-files/case-access.service';
import type { TasksService } from '../tasks/tasks.service';
import type { TimelineService } from '../timeline/timeline.service';

const SESSION = '01920000-0000-7000-8000-000000000051';
const SUMMARY = '01920000-0000-7000-8000-000000000052';
const FILE = '01920000-0000-7000-8000-000000000053';
const NOW = new Date('2026-11-14T10:00:00.000Z');
const CLIENT = {} as ClientInfo;
const row = {
  id: SUMMARY,
  sourceType: 'SESSION',
  sourceId: SESSION,
  fileId: FILE,
  versionNumber: null,
  language: 'AR',
  summary: 'Adjourned for the expert report.',
  keyFacts: ['Expert appointed'],
  keyLegalIssues: [],
  parties: [],
  dates: [],
  nextSteps: [
    { action: 'File the expert fee', dueInDays: 7 },
    { action: 'Call the client', dueInDays: null },
  ],
  riskAssessment: 'MEDIUM',
  provider: 'fake',
  model: 'fake-1',
  promptVersion: 'session-summary.v1',
  chunks: 1,
  createdAt: NOW,
};

function setup({ minutes = 'The court appointed an expert.', stored = [] as unknown[] } = {}) {
  const db = {
    session: {
      findFirst: jest.fn().mockResolvedValue({ id: SESSION, minutes, updatedAt: NOW }),
    },
    aiSummary: {
      findMany: jest.fn().mockResolvedValue(stored),
      findFirst: jest
        .fn()
        .mockResolvedValue({ sourceId: SESSION, fileId: FILE, nextSteps: row.nextSteps }),
    },
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
  };
  const jobs = { enqueue: jest.fn().mockResolvedValue({ jobId: 'j1', status: 'QUEUED' }) };
  const tasks = {
    createAll: jest.fn().mockResolvedValue(['t1', 't2']),
    get: jest.fn().mockImplementation((id: string) => Promise.resolve({ id })),
  };
  const service = new SessionSummariesService(
    { db } as unknown as PrismaService,
    { visibleWhere: () => ({}) } as unknown as CaseAccessService,
    jobs as unknown as AiJobs,
    tasks as unknown as TasksService,
  );
  return { service, db, jobs, tasks };
}

describe('SessionSummariesService (D-179)', () => {
  it('should queue a summary of the minutes, or answer with a current one', async () => {
    const { service, jobs } = setup();
    await expect(service.request(SESSION, 'AR', false)).resolves.toMatchObject({ status: 202 });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'summarize-session',
        fields: { sessionId: SESSION, language: 'AR' },
      }),
    );
    const cached = setup({ stored: [row] });
    await expect(cached.service.request(SESSION, 'AR', false)).resolves.toMatchObject({
      status: 200,
      summary: { riskAssessment: 'MEDIUM', nextSteps: row.nextSteps },
    });
    await expect(cached.service.request(SESSION, 'AR', true)).resolves.toMatchObject({
      status: 202,
    });
    await expect(cached.service.list(SESSION)).resolves.toHaveLength(1);
  });

  it('should refuse a session without minutes (BIZ-020) and an invisible one (404)', async () => {
    await expect(
      setup({ minutes: '  ' }).service.request(SESSION, 'EN', false),
    ).rejects.toMatchObject({
      code: 'BIZ-020',
    });
    const hidden = setup();
    hidden.db.session.findFirst.mockResolvedValue(null);
    await expect(hidden.service.list(SESSION)).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should create tasks only from the picked steps, dated from dueInDays in the office zone', async () => {
    const { service, tasks } = setup();
    const created = await service.createTasks(
      SUMMARY,
      { selected: [{ index: 0 }, { index: 1, title: 'Call Omar', dueDate: '2026-11-20' }] },
      CLIENT,
    );
    expect(created).toEqual([{ id: 't1' }, { id: 't2' }]);
    const [inputs, , source] = tasks.createAll.mock.calls[0] as [
      { dueDate?: string }[],
      unknown,
      unknown,
    ];
    expect(inputs[0]).toMatchObject({ title: 'File the expert fee', fileId: FILE });
    expect(inputs[0]?.dueDate).toMatch(/^2026-11-2\d$/);
    expect(inputs[1]).toMatchObject({ title: 'Call Omar', dueDate: '2026-11-20' });
    expect(source).toEqual({ type: 'AI_NEXT_STEP', id: SUMMARY });
  });

  it('should refuse a step that does not exist and a summary that is not a session one', async () => {
    const { service, db, tasks } = setup();
    await expect(
      service.createTasks(SUMMARY, { selected: [{ index: 5 }] }, CLIENT),
    ).rejects.toMatchObject({
      code: 'VAL-001',
    });
    db.aiSummary.findFirst.mockResolvedValue(null);
    await expect(
      service.createTasks(SUMMARY, { selected: [{ index: 0 }] }, CLIENT),
    ).rejects.toMatchObject({
      code: 'RES-001',
    });
    expect(tasks.createAll).not.toHaveBeenCalled();
  });

  it('should add days to a calendar date across a month end', () => {
    expect(addDays('2026-11-28', 7)).toBe('2026-12-05');
  });
});

describe('SessionSummarizer (D-179)', () => {
  function worker(existing: unknown = null, minutes: string | null = 'Minutes of the hearing.') {
    const tx = {
      aiSummary: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: SUMMARY }),
      },
    };
    const db = {
      session: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: SESSION, fileId: FILE, minutes, updatedAt: NOW }),
      },
      aiSummary: { findFirst: jest.fn().mockResolvedValue(existing) },
      legalFile: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          responsibleLawyer: { fullName: 'Lawyer' },
          clients: [],
          parties: [],
          teamMembers: [],
        }),
      },
    };
    const executor = {
      execute: jest.fn().mockResolvedValue({
        value: { summary: 'S', keyFacts: [], nextSteps: [], riskAssessment: 'LOW' },
        provider: 'fake',
        model: 'fake-1',
        promptVersion: 'session-summary.v1',
      }),
    };
    const realtime = { toUser: jest.fn() };
    const timeline = { record: jest.fn() };
    const after: (() => Promise<void>)[] = [];
    const summarizer = new SessionSummarizer(
      executor as unknown as AiExecutor,
      { db } as unknown as PrismaService,
      {
        run: async (work: (t: unknown, a: (fn: () => Promise<void>) => void) => unknown) => {
          const out = await work(tx, (fn) => after.push(fn));
          for (const fn of after) await fn();
          return out;
        },
      } as unknown as UnitOfWork,
      realtime as unknown as RealtimePublisher,
      { register: jest.fn() } as unknown as AiJobRegistry,
      { get: () => 'o1' } as unknown as ClsService<RequestContext>,
      timeline as unknown as TimelineService,
    );
    return { summarizer, tx, executor, realtime, timeline, db };
  }
  const context = { userId: 'u1', aiJobId: 'job1', signal: new AbortController().signal };

  it('should store the summary with its steps and risk, then tell the creator', async () => {
    const { summarizer, tx, realtime, timeline, executor } = worker();
    executor.execute.mockResolvedValue({
      value: {
        summary: 'S',
        keyFacts: [],
        nextSteps: [{ action: 'A', dueInDays: 3 }],
        riskAssessment: 'HIGH',
      },
      provider: 'fake',
      model: 'fake-1',
      promptVersion: 'session-summary.v1',
    });
    await expect(
      summarizer.run({ sessionId: SESSION, language: 'EN' }, context as never),
    ).resolves.toEqual({
      summaryId: SUMMARY,
    });
    expect(tx.aiSummary.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceType: 'SESSION',
          riskAssessment: 'HIGH',
          versionNumber: null,
        }),
      }),
    );
    expect(timeline.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ sourceType: 'Session' }),
    );
    expect(realtime.toUser).toHaveBeenCalledWith('u1', 'session.summary.ready', {
      sessionId: SESSION,
      fileId: FILE,
    });
  });

  it('should reuse a current summary and refuse empty minutes', async () => {
    const reused = worker({ id: SUMMARY });
    await expect(
      reused.summarizer.run({ sessionId: SESSION, language: 'AR' }, context as never),
    ).resolves.toEqual({
      summaryId: SUMMARY,
    });
    expect(reused.tx.aiSummary.create).not.toHaveBeenCalled();
    const empty = worker(null, null);
    await expect(
      empty.summarizer.run({ sessionId: SESSION, language: 'AR' }, context as never),
    ).rejects.toMatchObject({
      code: 'BIZ-020',
    });
    const gone = worker();
    gone.db.session.findFirst.mockResolvedValue(null);
    await expect(
      gone.summarizer.run({ sessionId: SESSION, language: 'AR' }, context as never),
    ).rejects.toMatchObject({
      code: 'RES-001',
    });
  });
});
