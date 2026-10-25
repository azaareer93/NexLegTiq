import type { ModuleRef } from '@nestjs/core';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { AiAccess } from './ai-access';
import { AiCache } from './ai-cache';
import type { AiCostAlert } from './ai-cost-alert';
import { AiJobRegistry } from './ai-job-registry';
import { AiJobs } from './ai-jobs';
import type { AiProviders } from './ai-providers';
import { AiUsageRecorder } from './ai-usage';
import { AiProcessor, errorCodeOf } from './workers/ai.processor';
import type { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import type { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { EntitlementsService } from '../subscriptions/entitlements.service';

const OFFICE = '01900000-0000-7000-8000-0000000000aa';
const JOB = '01900000-0000-7000-8000-0000000000bb';

const redis = {
  status: 'ready',
  on: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
  disconnect: jest.fn(),
};
jest.mock('ioredis', () => ({ Redis: jest.fn(() => redis) }));

const logger = () =>
  ({ setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }) as unknown as PinoLogger & {
    warn: jest.Mock;
    error: jest.Mock;
  };
const config = (env: Record<string, string> = {}) => new AppConfig(parseEnv(testEnv(env)));
const cls = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as unknown as ClsService<RequestContext>;

describe('AiCache', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should read and write office-scoped keys, treating Redis failures as misses', async () => {
    const log = logger();
    const cache = new AiCache(config(), log);
    redis.get.mockResolvedValueOnce('{"a":1}').mockResolvedValueOnce(null);
    await expect(cache.get(OFFICE as never, ['s', 'd1'])).resolves.toEqual({ a: 1 });
    expect(redis.get).toHaveBeenCalledWith(`o:${OFFICE}:ai:s:d1`);
    await expect(cache.get(OFFICE as never, ['s'])).resolves.toBeNull();
    redis.get.mockRejectedValueOnce(new Error('down'));
    await expect(cache.get(OFFICE as never, ['s'])).resolves.toBeNull();
    await cache.set(OFFICE as never, ['s'], { a: 1 }, 60);
    expect(redis.set).toHaveBeenCalledWith(`o:${OFFICE}:ai:s`, '{"a":1}', 'EX', 60);
    await cache.set(OFFICE as never, ['s'], { a: 1 }, 0);
    expect(redis.set).toHaveBeenCalledTimes(1);
    redis.set.mockRejectedValueOnce(new Error('down'));
    await expect(cache.set(OFFICE as never, ['s'], 1, 60)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(2);
    await cache.onModuleDestroy();
    expect(redis.quit).toHaveBeenCalled();
  });
});

describe('AiAccess', () => {
  function access({ configured = true, enableAi = true as boolean | undefined } = {}) {
    const entitlements = { assertFeature: jest.fn(), assertAiQuota: jest.fn() };
    const prisma = {
      db: {
        officeSettings: {
          findFirst: jest.fn().mockResolvedValue(enableAi === undefined ? null : { enableAi }),
        },
      },
    };
    return {
      check: new AiAccess(
        { configured } as AiProviders,
        prisma as unknown as PrismaService,
        entitlements as unknown as EntitlementsService,
      ),
      entitlements,
    };
  }

  it('should check the deployment, the office switch, the plan feature and the quota, in that order', async () => {
    await expect(access({ configured: false }).check.assertAvailable()).rejects.toMatchObject({
      code: 'AI-001',
    });
    await expect(access({ enableAi: false }).check.assertAvailable()).rejects.toMatchObject({
      code: 'AI-005',
    });
    const { check, entitlements } = access({ enableAi: undefined });
    await expect(check.assertAvailable()).resolves.toBeUndefined();
    expect(entitlements.assertFeature).toHaveBeenCalledWith('ai');
    expect(entitlements.assertAiQuota).toHaveBeenCalled();
  });
});

describe('AiUsageRecorder', () => {
  it('should price provider calls from the configured table and record cache hits for free', async () => {
    const create = jest.fn();
    const recorder = new AiUsageRecorder(
      { db: { aiUsage: { create } } } as unknown as PrismaService,
      config({ AI_MODEL_PRICES: '{"m":{"input":0.15,"output":0.6}}' }),
      cls({ officeId: OFFICE }),
    );
    const entry = {
      feature: 'f',
      provider: 'openai',
      model: 'm',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      durationMs: 10,
      cached: false,
      userId: null,
      costUsd: '0.450000',
    };
    expect(recorder.cost('m', 1_000_000, 500_000).toFixed(6)).toBe('0.450000');
    expect(recorder.cost('unknown', 1_000_000, 500_000).toFixed(6)).toBe('0.000000');
    await recorder.record(entry);
    expect(create).toHaveBeenCalledWith({ data: { ...entry, officeId: OFFICE } });
    const orphan = new AiUsageRecorder(
      { db: { aiUsage: { create } } } as unknown as PrismaService,
      config(),
      cls({}),
    );
    await expect(orphan.record(entry)).rejects.toThrow('No office');
  });
});

describe('AiJobRegistry', () => {
  it('should hold one handler per job name', () => {
    const registry = new AiJobRegistry();
    const handler = jest.fn();
    registry.register('x', handler);
    expect(registry.get('x')).toBe(handler);
    expect(registry.get('y')).toBeUndefined();
    expect(() => registry.register('x', handler)).toThrow('already registered');
  });
});

function jobsSetup(context: Record<string, unknown> = { officeId: OFFICE, userId: 'u1' }) {
  const aiJob = {
    create: jest.fn().mockResolvedValue({ id: JOB, status: 'QUEUED' }),
    findFirst: jest.fn(),
    findFirstOrThrow: jest.fn().mockResolvedValue({ createdById: 'u1' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    update: jest.fn().mockResolvedValue({ createdById: 'u1' }),
  };
  const access = { assertAvailable: jest.fn() };
  const queues = { enqueue: jest.fn() };
  const realtime = { toUser: jest.fn() };
  const uow = {
    run: (work: (tx: unknown, after: (task: () => unknown) => void) => unknown) =>
      work({ aiJob }, (task) => void task()),
  };
  const jobs = new AiJobs(
    access as unknown as AiAccess,
    uow as unknown as UnitOfWork,
    queues as unknown as QueueProducer,
    { db: { aiJob } } as unknown as PrismaService,
    realtime as unknown as RealtimePublisher,
    cls(context),
  );
  return { jobs, aiJob, access, queues, realtime };
}

describe('AiJobs', () => {
  it('should check access, write the job and queue it after the commit', async () => {
    const { jobs, aiJob, queues } = jobsSetup();
    await expect(
      jobs.enqueue({
        type: 'summarize',
        sourceType: 'DOCUMENT',
        sourceId: JOB,
        fields: { lang: 'ar' },
      }),
    ).resolves.toEqual({ jobId: JOB, status: 'QUEUED' });
    expect(aiJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          officeId: OFFICE,
          type: 'summarize',
          sourceType: 'DOCUMENT',
          sourceId: JOB,
          createdById: 'u1',
        },
      }),
    );
    expect(queues.enqueue).toHaveBeenCalledWith(
      'ai',
      'summarize',
      { lang: 'ar', aiJobId: JOB },
      { jobId: JOB },
    );
  });

  it('should refuse without a caller, and write nothing when AI is not available', async () => {
    await expect(jobsSetup({}).jobs.enqueue({ type: 'x' })).rejects.toThrow('No caller');
    const { jobs, aiJob, access } = jobsSetup();
    access.assertAvailable.mockRejectedValueOnce(new AppException('AI-005', 'off'));
    await expect(jobs.enqueue({ type: 'x' })).rejects.toMatchObject({ code: 'AI-005' });
    expect(aiJob.create).not.toHaveBeenCalled();
  });

  it('should show a job to its creator only, with ISO times', async () => {
    const { jobs, aiJob } = jobsSetup();
    const at = new Date('2026-10-20T10:00:00Z');
    aiJob.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: JOB,
      type: 'x',
      status: 'QUEUED',
      sourceType: null,
      sourceId: null,
      errorCode: null,
      result: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    });
    await expect(jobs.get(JOB)).rejects.toMatchObject({ code: 'RES-001' });
    expect(aiJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: JOB, createdById: 'u1' } }),
    );
    await expect(jobs.get(JOB)).resolves.toMatchObject({
      createdAt: at.toISOString(),
      finishedAt: null,
      result: null,
    });
  });

  it('should move the job and tell its creator, never after it succeeded', async () => {
    const { jobs, aiJob, realtime } = jobsSetup();
    await expect(jobs.start(JOB)).resolves.toEqual({ createdById: 'u1' });
    aiJob.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(jobs.start(JOB)).resolves.toBeNull();
    await jobs.succeed(JOB, { summaryId: JOB, count: 2 });
    expect(aiJob.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: JOB, status: 'RUNNING' } }),
    );
    expect(realtime.toUser).toHaveBeenLastCalledWith('u1', 'ai.job.completed', { jobId: JOB });
    // A late success after the job failed or moved on changes nothing and tells nobody.
    aiJob.updateMany.mockResolvedValueOnce({ count: 0 });
    await jobs.succeed(JOB, { summaryId: JOB });
    expect(realtime.toUser).toHaveBeenCalledTimes(1);
    // AI text never lands in the job row.
    await expect(jobs.succeed(JOB, { summary: 'text' })).rejects.toThrow();
    await jobs.fail(JOB, 'AI-004');
    expect(realtime.toUser).toHaveBeenLastCalledWith('u1', 'ai.job.failed', { jobId: JOB });
    aiJob.updateMany.mockResolvedValueOnce({ count: 0 });
    await jobs.fail(JOB, 'AI-004');
    expect(realtime.toUser).toHaveBeenCalledTimes(2);
  });

  it('should require a caller to read a job', async () => {
    await expect(jobsSetup({ officeId: OFFICE }).jobs.get(JOB)).rejects.toThrow('No caller');
  });
});

describe('AiProcessor', () => {
  function processorSetup(handler?: jest.Mock) {
    const registry = new AiJobRegistry();
    if (handler) registry.register('run', handler);
    const jobs = {
      start: jest.fn().mockResolvedValue({ createdById: 'u1' }),
      succeed: jest.fn(),
      fail: jest.fn(),
    };
    const log = logger();
    const tenant = { run: jest.fn((_context: unknown, work: () => unknown) => work()) };
    const processor = new AiProcessor(
      tenant as unknown as TenantRunner,
      {} as PrismaService,
      log,
      registry,
      jobs as unknown as AiJobs,
      {} as AiCostAlert,
      {} as AppConfig,
      {} as ModuleRef,
    );
    const handle = (name = 'run') =>
      (processor as unknown as { handle(job: Job, signal: AbortSignal): Promise<unknown> }).handle(
        { name, data: { aiJobId: JOB, officeId: OFFICE, text: 't' } } as Job,
        new AbortController().signal,
      );
    return { processor, jobs, handle, log, tenant };
  }

  it('should run the platform cost check outside any office, and schedule it only when configured (D-144)', async () => {
    const run = jest.fn().mockResolvedValue({ day: '2026-10-25', costUsd: '1.00', alerted: false });
    const queue = { upsertJobScheduler: jest.fn(), removeJobScheduler: jest.fn() };
    const moduleRef = { get: jest.fn(() => queue) };
    const build = (aiCostAlert: object | null) =>
      new AiProcessor(
        { run: jest.fn() } as unknown as TenantRunner,
        {} as PrismaService,
        logger(),
        new AiJobRegistry(),
        {} as AiJobs,
        { run } as unknown as AiCostAlert,
        { aiCostAlert } as unknown as AppConfig,
        moduleRef as unknown as ModuleRef,
      );
    const processor = build({ thresholdUsd: 20, email: 'founder@example.com' });
    await expect(
      processor.process({ name: 'ai-cost-alert', data: {} } as Job),
    ).resolves.toMatchObject({
      alerted: false,
    });
    expect(run).toHaveBeenCalledTimes(1);
    await processor.onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'ai-cost-alert',
      { pattern: '0 6 * * *', tz: 'UTC' },
      { name: 'ai-cost-alert', data: {} },
    );
    await build(null).onApplicationBootstrap();
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('ai-cost-alert');
  });

  it('should name the error code of a failure', () => {
    expect(errorCodeOf(new AppException('AI-003', 'x'))).toBe('AI-003');
    expect(errorCodeOf(new UnrecoverableError('AI-004'))).toBe('AI-004');
    expect(errorCodeOf(new UnrecoverableError('Invalid job payload'))).toBe('SYS-001');
    expect(errorCodeOf(new Error('boom'))).toBe('SYS-001');
  });

  it('should run the registered handler and store what it produced', async () => {
    const handler = jest.fn().mockResolvedValue({ summaryId: 's1' });
    const { handle, jobs } = processorSetup(handler);
    await expect(handle()).resolves.toEqual({ summaryId: 's1' });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ aiJobId: JOB, text: 't' }),
      expect.objectContaining({ aiJobId: JOB, userId: 'u1' }),
    );
    expect(jobs.succeed).toHaveBeenCalledWith(JOB, { summaryId: 's1' });
  });

  it('should refuse an unknown job, skip one not runnable, and retry only availability errors', async () => {
    const handler = jest.fn();
    const { handle, jobs } = processorSetup(handler);
    await expect(handle('other')).rejects.toThrow(UnrecoverableError);
    jobs.start.mockResolvedValueOnce(null);
    await expect(handle()).resolves.toEqual({ skipped: 'not runnable' });
    handler.mockRejectedValueOnce(new AppException('AI-002', 'x'));
    await expect(handle()).rejects.toBeInstanceOf(AppException);
    handler.mockRejectedValueOnce(new AppException('AI-004', 'x'));
    await expect(handle()).rejects.toThrow(new UnrecoverableError('AI-004'));
  });

  it('should mark the job FAILED on its last attempt only, and log when it cannot', async () => {
    const { processor, jobs, log } = processorSetup();
    const job = (attemptsMade: number) =>
      ({
        data: { aiJobId: JOB, officeId: OFFICE, requestId: null },
        attemptsMade,
        opts: { attempts: 2 },
      }) as unknown as Job;
    await processor.onFailed(undefined, new Error('x'));
    await processor.onFailed(job(1), new AppException('AI-002', 'x'));
    expect(jobs.fail).not.toHaveBeenCalled();
    await processor.onFailed(job(2), new AppException('AI-002', 'x'));
    expect(jobs.fail).toHaveBeenCalledWith(JOB, 'AI-002');
    await processor.onFailed(job(1), new UnrecoverableError('AI-004'));
    expect(jobs.fail).toHaveBeenLastCalledWith(JOB, 'AI-004');
    jobs.fail.mockRejectedValueOnce(new Error('db down'));
    await processor.onFailed(job(2), new Error('x'));
    expect(log.error).toHaveBeenCalledWith(expect.anything(), 'AI job not marked FAILED');
  });
});
