import { randomUUID } from 'node:crypto';

import { Processor } from '@nestjs/bullmq';
import { Injectable, Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OfficeId } from '@nexlegtiq/shared-types';
import type { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { integrationEnv } from '../../config/env.fixture';
import { DatabaseModule } from '../../database/database.module';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { ReadinessRegistry } from '../../health/readiness.registry';
import type { RequestContext } from '../context/request-context';
import { CoreModule } from '../core/core.module';
import { TenantRunner } from '../tenancy/tenant-runner';
import { QueueModule } from './queue.module';
import { QueueProducer } from './queue-producer';
import { QUEUE, QUEUE_NAMES, workerOptions } from './queues';
import type { TenantJobData } from './tenant-job';
import { TenantProcessor } from './tenant-processor';
import { drainQueue, getQueue } from './testing';

interface ProbeJob {
  readonly failTimes?: number;
}

/** What the processor saw: the CLS office and request id while handling each attempt. */
const seen: { jobId: string | undefined; officeId: string | undefined; requestId: string | undefined; attempt: number }[] = [];

@Injectable()
@Processor(QUEUE.NOTIFICATION, workerOptions(QUEUE.NOTIFICATION))
class ProbeProcessor extends TenantProcessor<ProbeJob> {
  constructor(
    tenant: TenantRunner,
    logger: PinoLogger,
    private readonly cls: ClsService<RequestContext>,
  ) {
    super(tenant, logger);
  }

  protected async handle(job: Job<ProbeJob & TenantJobData>): Promise<string> {
    seen.push({ jobId: job.id, officeId: this.cls.get('officeId'), requestId: this.cls.getId(), attempt: job.attemptsMade + 1 });
    if (job.attemptsMade < (job.data.failTimes ?? 0)) throw new Error('transient failure');
    return 'ok';
  }
}

/** Like WorkerModule, plus a probe processor on the notification queue. */
@Module({ imports: [CoreModule, DatabaseModule, QueueModule], providers: [ProbeProcessor] })
class QueueTestModule {}

/** MVP-34 against real Redis and PostgreSQL (D-011, D-084): producer → worker in the job's office, retries, after-commit. */
describe('queues (Redis + PostgreSQL)', () => {
  let app: INestApplicationContext;
  let officeId: OfficeId;
  const savedEnv = { ...process.env };

  const inOffice = <T>(work: () => Promise<T>, requestId = `req-${randomUUID()}`) =>
    app.get(TenantRunner).run({ officeId, requestId }, work);
  const queue = () => getQueue(app, QUEUE.NOTIFICATION);

  beforeAll(async () => {
    Object.assign(
      process.env,
      // A prefix of its own: this run's jobs never mix with a dev worker or another test run on the same Redis.
      integrationEnv({ BULLMQ_PREFIX: `it-${randomUUID().slice(0, 8)}` }),
    );
    const moduleRef = await Test.createTestingModule({ imports: [QueueTestModule] }).compile();
    app = await moduleRef.init();
    // unscoped: test setup — an office for the jobs to run in.
    officeId = (await app.get(PrismaService).unscoped().office.create({ data: { name: 'Queue test office' } })).id as OfficeId;
  });

  afterEach(() => {
    seen.length = 0;
  });

  afterAll(async () => {
    if (app) {
      for (const name of QUEUE_NAMES) await getQueue(app, name).obliterate({ force: true });
      // unscoped: test cleanup.
      await app.get(PrismaService).unscoped().office.delete({ where: { id: officeId } });
      await app.close();
    }
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it('should run an enqueued job in the office and request that enqueued it', async () => {
    const job = await inOffice(() => app.get(QueueProducer).enqueue(QUEUE.NOTIFICATION, 'probe', {}), 'req-queue-0001');
    expect(job.data).toMatchObject({ officeId, requestId: 'req-queue-0001' });

    await drainQueue(queue());
    expect(seen).toEqual([{ jobId: job.id, officeId, requestId: 'req-queue-0001', attempt: 1 }]);
    await expect(queue().getJobState(job.id ?? '')).resolves.toBe('completed');
  });

  it('should retry a failing job per the queue options, then complete it', async () => {
    const job = await inOffice(() => app.get(QueueProducer).enqueue(QUEUE.NOTIFICATION, 'probe', { failTimes: 1 }));
    await drainQueue(queue(), 15_000);

    expect(seen.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(seen.every((attempt) => attempt.officeId === officeId)).toBe(true);
    const done = await queue().getJob(job.id ?? '');
    expect(done?.attemptsMade).toBe(2);
    await expect(done?.getState()).resolves.toBe('completed');
  });

  it('should fail a job without an officeId at once, without retries', async () => {
    const job = await queue().add('probe', { requestId: null });
    await drainQueue(queue());
    expect(seen).toEqual([]);
    const failed = await queue().getJob(job.id ?? '');
    expect(failed?.attemptsMade).toBe(1);
    await expect(failed?.getState()).resolves.toBe('failed');
  });

  it('should enqueue after-commit jobs only when the transaction commits', async () => {
    const uow = app.get(UnitOfWork);
    const producer = app.get(QueueProducer);
    await inOffice(() =>
      uow.run(async (tx, afterCommit) => {
        await tx.$queryRaw`SELECT 1`;
        afterCommit(() => producer.enqueue(QUEUE.NOTIFICATION, 'probe', {}));
      }),
    );
    await expect(
      inOffice(() =>
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
