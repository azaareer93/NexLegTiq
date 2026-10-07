import { randomUUID } from 'node:crypto';

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { OfficeId } from '@nexlegtiq/shared-types';
import type { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { z } from 'zod';

import { BULL_BOARD_PATH } from './bull-board';
import { QueueProducer } from './queue-producer';
import { QueueModule } from './queue.module';
import { QUEUE, QUEUE_NAMES, QUEUE_POLICY, workerOptions } from './queues';
import type { TenantJobData } from './tenant-job';
import { TenantProcessor } from './tenant-processor';
import { drainQueue, getQueue } from './testing';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { DatabaseModule } from '../../database/database.module';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { ReadinessRegistry } from '../../health/readiness.registry';
import type { RequestContext } from '../context/request-context';
import { CoreModule } from '../core/core.module';
import { TenantRunner } from '../tenancy/tenant-runner';

const ProbeJobSchema = z.object({ failTimes: z.number().int().optional() });
type ProbeJob = z.infer<typeof ProbeJobSchema>;

/** What the processor saw on each attempt: CLS office and request id, and the offices the scoped client can read. */
const seen: {
  jobId?: string;
  officeId?: string;
  requestId?: string;
  attempt: number;
  visibleOffices: string[];
}[] = [];

@Injectable()
@Processor(QUEUE.NOTIFICATION, workerOptions(QUEUE.NOTIFICATION))
class ProbeProcessor extends TenantProcessor<ProbeJob> {
  protected readonly schema = ProbeJobSchema;

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly cls: ClsService<RequestContext>,
  ) {
    super(tenant, prisma, logger);
  }

  protected async handle(job: Job<ProbeJob & TenantJobData>): Promise<string> {
    const visibleOffices = (await this.prisma.db.office.findMany({ select: { id: true } })).map(
      (office) => office.id,
    );
    seen.push({
      jobId: job.id,
      officeId: this.cls.get('officeId'),
      requestId: this.cls.getId(),
      attempt: job.attemptsMade + 1,
      visibleOffices,
    });
    if (job.attemptsMade < (job.data.failTimes ?? 0)) throw new Error('transient failure');
    return 'ok';
  }
}

/** Like WorkerModule, plus a probe processor on the notification queue. */
@Module({ imports: [CoreModule, DatabaseModule, QueueModule], providers: [ProbeProcessor] })
class QueueTestModule {}

const savedEnv = { ...process.env };
function restoreEnv(): void {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}

/** MVP-34 against real Redis and PostgreSQL (D-011, D-084): producer → worker in the job's office, retries, after-commit. */
describe('queues (Redis + PostgreSQL)', () => {
  let app: INestApplicationContext;
  let officeA: OfficeId;
  let officeB: OfficeId;
  let suspended: OfficeId;

  const inOffice = <T>(
    officeId: OfficeId,
    work: () => Promise<T>,
    requestId = `req-${randomUUID()}`,
  ) => app.get(TenantRunner).run({ officeId, requestId }, work);
  const queue = () => getQueue(app, QUEUE.NOTIFICATION);
  const enqueue = (officeId: OfficeId, data: ProbeJob = {}, requestId?: string) =>
    inOffice(
      officeId,
      () => app.get(QueueProducer).enqueue(QUEUE.NOTIFICATION, 'probe', data),
      requestId,
    );

  beforeAll(async () => {
    // A prefix of its own: this run's jobs never mix with a dev worker or another test run on the same Redis.
    Object.assign(process.env, integrationEnv({ BULLMQ_PREFIX: `it-${randomUUID().slice(0, 8)}` }));
    app = await (await Test.createTestingModule({ imports: [QueueTestModule] }).compile()).init();
    // unscoped: test setup — two offices (D-018 isolation) and a suspended one.
    const raw = app.get(PrismaService).unscoped();
    officeA = (await raw.office.create({ data: { name: 'Queue test office A' } })).id as OfficeId;
    officeB = (await raw.office.create({ data: { name: 'Queue test office B' } })).id as OfficeId;
    suspended = (
      await raw.office.create({ data: { name: 'Queue test office C', isActive: false } })
    ).id as OfficeId;
  });

  beforeEach(async () => {
    await queue().drain(true);
    seen.length = 0;
  });

  afterAll(async () => {
    if (app) {
      for (const name of QUEUE_NAMES) await getQueue(app, name).obliterate({ force: true });
      // unscoped: test cleanup.
      await app
        .get(PrismaService)
        .unscoped()
        .office.deleteMany({ where: { id: { in: [officeA, officeB, suspended] } } });
      await app.close();
    }
    restoreEnv();
  });

  it('should run each job in the office and request that enqueued it, seeing only that office', async () => {
    const jobA = await enqueue(officeA, {}, 'req-queue-000A');
    const jobB = await enqueue(officeB, {}, 'req-queue-000B');
    expect(jobA.data).toMatchObject({ officeId: officeA, requestId: 'req-queue-000A' });
    expect(jobA.opts).toMatchObject({
      attempts: QUEUE_POLICY.notification.jobs.attempts,
      backoff: QUEUE_POLICY.notification.jobs.backoff,
    });

    await drainQueue(queue());
    expect(seen).toEqual(
      expect.arrayContaining([
        {
          jobId: jobA.id,
          officeId: officeA,
          requestId: 'req-queue-000A',
          attempt: 1,
          visibleOffices: [officeA],
        },
        {
          jobId: jobB.id,
          officeId: officeB,
          requestId: 'req-queue-000B',
          attempt: 1,
          visibleOffices: [officeB],
        },
      ]),
    );
    await expect(queue().getJobState(jobA.id ?? '')).resolves.toBe('completed');
  });

  it('should retry a failing job per the queue options, then complete it', async () => {
    const job = await enqueue(officeA, { failTimes: 1 });
    await drainQueue(queue(), 15_000);

    expect(seen.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    const done = await queue().getJob(job.id ?? '');
    expect(done?.attemptsMade).toBe(2);
    await expect(done?.getState()).resolves.toBe('completed');
  });

  it('should mark a job failed once its attempts are used up', async () => {
    // Added directly with a 10 ms backoff so the test does not wait for the queue's real backoff.
    const job = await queue().add(
      'probe',
      { officeId: officeA, requestId: null, failTimes: 99 },
      { attempts: 3, backoff: { type: 'fixed', delay: 10 } },
    );
    await drainQueue(queue());
    expect(seen.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    const failed = await queue().getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(3);
    await expect(failed?.getState()).resolves.toBe('failed');
  });

  it.each([
    ['without an officeId', { requestId: null }],
    ['with a malformed job field', { requestId: null, failTimes: 'many' }],
  ])('should fail a job %s at once, without retries', async (_label, data) => {
    const job = await queue().add('probe', {
      ...data,
      ...('failTimes' in data ? { officeId: officeA } : {}),
    });
    await drainQueue(queue());
    expect(seen).toEqual([]);
    const failed = await queue().getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(1);
    await expect(failed?.getState()).resolves.toBe('failed');
  });

  it('should skip a job whose office has been suspended', async () => {
    const job = await queue().add('probe', { officeId: suspended, requestId: null });
    await drainQueue(queue());
    expect(seen).toEqual([]);
    await expect(queue().getJobState(job.id ?? '')).resolves.toBe('completed');
  });

  it('should enqueue after-commit jobs only when the transaction commits', async () => {
    const uow = app.get(UnitOfWork);
    const producer = app.get(QueueProducer);
    await inOffice(officeA, () =>
      uow.run(async (tx, afterCommit) => {
        await tx.$queryRaw`SELECT 1`;
        afterCommit(() => producer.enqueue(QUEUE.NOTIFICATION, 'probe', {}), 'enqueue probe');
      }),
    );
    await expect(
      inOffice(officeA, () =>
        uow.run(async (_tx, afterCommit) => {
          afterCommit(() => producer.enqueue(QUEUE.NOTIFICATION, 'probe', {}));
          throw new Error('rolled back');
        }),
      ),
    ).rejects.toThrow('rolled back');

    await drainQueue(queue());
    expect(seen).toHaveLength(1);
  });

  it('should report Redis as ready', async () => {
    const report = await app.get(ReadinessRegistry).run();
    expect(report.checks['redis']).toMatchObject({ status: 'up' });
  });
});

describe('HTTP app and queues', () => {
  async function createHttpApp(env: Record<string, string>): Promise<NestExpressApplication> {
    Object.assign(process.env, integrationEnv(env));
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, DiscoveryModule],
    }).compile();
    const created = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      bufferLogs: true,
    });
    configureApp(created);
    await created.init();
    return created;
  }

  afterAll(restoreEnv);

  it('should register no processors in the HTTP app (producers only) and hide Bull Board by default', async () => {
    const http = await createHttpApp({});
    try {
      const processors = http
        .get(DiscoveryService)
        .getProviders()
        .filter((wrapper) => wrapper.instance instanceof WorkerHost);
      expect(processors).toEqual([]);
      expect(http.get(QueueProducer)).toBeInstanceOf(QueueProducer);
      await request(http.getHttpServer()).get(BULL_BOARD_PATH).expect(404);
    } finally {
      await http.close();
    }
  });

  it('should serve Bull Board when enabled, without weakening the API CSP', async () => {
    const http = await createHttpApp({ BULL_BOARD_ENABLED: 'true' });
    try {
      const board = await request(http.getHttpServer()).get(`${BULL_BOARD_PATH}/`).expect(200);
      expect(board.headers['x-content-type-options']).toBe('nosniff');
      expect(board.headers['content-security-policy']).toBeUndefined();
      const api = await request(http.getHttpServer()).get('/health');
      expect(api.headers['content-security-policy']).toBeDefined();
    } finally {
      await http.close();
    }
  });

  it('should fail an enqueue fast while Redis is unreachable instead of hanging the request', async () => {
    const http = await createHttpApp({ REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      // unscoped: test setup — an office for the tenant context.
      const office = await http
        .get(PrismaService)
        .unscoped()
        .office.create({ data: { name: 'Queue test office D' } });
      const started = Date.now();
      await expect(
        http
          .get(TenantRunner)
          .run({ officeId: office.id as OfficeId }, () =>
            http.get(QueueProducer).enqueue(QUEUE.EMAIL, 'send-email', {}),
          ),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(4000);
      // unscoped: test cleanup.
      await http
        .get(PrismaService)
        .unscoped()
        .office.delete({ where: { id: office.id } });
    } finally {
      await http.close();
    }
  }, 20_000);
});
