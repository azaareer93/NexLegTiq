import type { NestExpressApplication } from '@nestjs/platform-express';
import { UnrecoverableError } from 'bullmq';
import type { Job, Queue } from 'bullmq';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import type { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { RequestContext } from '../context/request-context';
import { TenantRunner } from '../tenancy/tenant-runner';
import { TenantContextMissingError } from '../tenancy/tenant.errors';
import { BULL_BOARD_PATH, mountBullBoard } from './bull-board';
import { QueueProducer } from './queue-producer';
import { QUEUE, QUEUE_NAMES, QUEUE_POLICY, workerOptions } from './queues';
import { redisConnectionOptions } from './redis-connection';
import { parseTenantJob } from './tenant-job';
import type { TenantJobData } from './tenant-job';
import { TenantProcessor, withTimeout } from './tenant-processor';
import { drainQueue } from './testing';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const cls = ClsServiceManager.getClsService<RequestContext>();
const logger = () => ({ setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }) as unknown as PinoLogger & { warn: jest.Mock; error: jest.Mock };

describe('queues (D-011, architecture.md)', () => {
  it('should define exactly the canonical queues, without a -queue suffix', () => {
    expect([...QUEUE_NAMES].sort()).toEqual(['ai', 'batch-ingest', 'email', 'notification', 'ocr', 'reminder', 'report']);
  });

  it.each([
    ['ocr', 3, { type: 'exponential', delay: 1000 }, 60_000, 10],
    ['ai', 2, { type: 'fixed', delay: 10_000 }, 120_000, 5],
    ['email', 3, { type: 'fixed', delay: 5000 }, 30_000, 2],
    ['report', 2, { type: 'exponential', delay: 1000 }, 120_000, 2],
  ] as const)('should give %s its retry, timeout and concurrency', (name, attempts, backoff, timeoutMs, concurrency) => {
    expect(QUEUE_POLICY[name]).toMatchObject({ jobs: { attempts, backoff }, timeoutMs, concurrency });
    expect(workerOptions(name)).toEqual({ concurrency });
  });

  it('should keep completed jobs 7 days (max 1000) and failed jobs 30 days everywhere', () => {
    for (const name of QUEUE_NAMES) {
      expect(QUEUE_POLICY[name].jobs).toMatchObject({
        removeOnComplete: { age: 7 * 86_400, count: 1000 },
        removeOnFail: { age: 30 * 86_400 },
      });
    }
  });
});

describe('redisConnectionOptions', () => {
  it('should read host, port, credentials, db and TLS from the URL', () => {
    expect(redisConnectionOptions('rediss://app:p%40ss@cache.example:6380/2')).toEqual({
      host: 'cache.example',
      port: 6380,
      username: 'app',
      password: 'p@ss',
      db: 2,
      tls: { servername: 'cache.example' },
    });
    expect(redisConnectionOptions('redis://127.0.0.1')).toEqual({ host: '127.0.0.1', port: 6379, db: 0 });
  });
});

describe('parseTenantJob', () => {
  it('should accept a payload with an office uuid and a request id or null', () => {
    expect(parseTenantJob({ officeId: OFFICE, requestId: 'req-1', x: 1 })).toEqual({ officeId: OFFICE, requestId: 'req-1' });
    expect(parseTenantJob({ officeId: OFFICE, requestId: null })).toEqual({ officeId: OFFICE, requestId: null });
  });

  it.each([[{}], [{ officeId: 'nope', requestId: null }], [{ officeId: OFFICE }], [null]])('should reject %j', (data) => {
    expect(parseTenantJob(data)).toBeNull();
  });
});

describe('QueueProducer', () => {
  function setup() {
    const add = jest.fn().mockResolvedValue({ id: '1' });
    const moduleRef = { get: jest.fn().mockReturnValue({ add }) };
    return { producer: new QueueProducer(moduleRef as never, cls), add, moduleRef };
  }

  it('should add officeId and requestId from the tenant context', async () => {
    const { producer, add } = setup();
    await new TenantRunner(cls).run({ officeId: OFFICE as never, requestId: 'req-12345678' }, () =>
      producer.enqueue(QUEUE.EMAIL, 'send-email', { to: 'a@b.test' }, { delay: 10 }),
    );
    expect(add).toHaveBeenCalledWith('send-email', { to: 'a@b.test', officeId: OFFICE, requestId: 'req-12345678' }, { delay: 10 });
  });

  it('should refuse to enqueue outside a tenant context', async () => {
    const { producer, add } = setup();
    await expect(producer.enqueue(QUEUE.EMAIL, 'send-email', {})).rejects.toThrow(TenantContextMissingError);
    expect(add).not.toHaveBeenCalled();
  });
});

describe('TenantProcessor', () => {
  class EchoProcessor extends TenantProcessor<{ ms?: number; fail?: boolean }> {
    seen: (string | undefined)[] = [];
    protected async handle(job: Job<{ ms?: number; fail?: boolean } & TenantJobData>): Promise<string> {
      this.seen.push(cls.get('officeId'));
      if (job.data.fail) throw new Error('boom');
      if (job.data.ms) await new Promise((resolve) => setTimeout(resolve, job.data.ms));
      return 'done';
    }
  }
  const job = (data: object, queueName = 'notification') => ({ id: '7', name: 'test', queueName, attemptsMade: 0, data }) as Job<never>;

  it('should run the job in its office and return the result', async () => {
    const processor = new EchoProcessor(new TenantRunner(cls), logger());
    await expect(processor.process(job({ officeId: OFFICE, requestId: 'req-1' }))).resolves.toBe('done');
    expect(processor.seen).toEqual([OFFICE]);
  });

  it('should fail without retries when the payload has no valid officeId', async () => {
    const log = logger();
    const processor = new EchoProcessor(new TenantRunner(cls), log);
    await expect(processor.process(job({ requestId: null }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(processor.seen).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ jobId: '7', queue: 'notification' }), expect.any(String));
  });

  it('should log a failed attempt with the request id and rethrow it for BullMQ to retry', async () => {
    const log = logger();
    const processor = new EchoProcessor(new TenantRunner(cls), log);
    await expect(processor.process(job({ officeId: OFFICE, requestId: 'req-9', fail: true }))).rejects.toThrow('boom');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-9', attempt: 1 }), 'Job attempt failed');
  });

  it('should time out per queue policy', async () => {
    await expect(withTimeout(new Promise(() => undefined), 5)).rejects.toThrow('timed out after 5 ms');
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok');
  });
});

describe('UnitOfWork', () => {
  function setup(fail = false) {
    const tx = { marker: 'tx' };
    const prisma = {
      db: {
        $transaction: jest.fn(async (work: (t: object) => unknown) => {
          const result = await work(tx);
          if (fail) throw new Error('rollback');
          return result;
        }),
      },
    } as unknown as PrismaService;
    const log = logger();
    return { uow: new UnitOfWork(prisma, log), tx, log };
  }

  it('should run after-commit tasks in order once the transaction committed, logging failures', async () => {
    const { uow, tx, log } = setup();
    const order: string[] = [];
    const result = await uow.run(async (given, afterCommit) => {
      expect(given).toBe(tx);
      afterCommit(async () => void order.push('first'));
      afterCommit(() => Promise.reject(new Error('redis down')));
      afterCommit(async () => void order.push('third'));
      order.push('in-transaction');
      return 42;
    });
    expect(result).toBe(42);
    expect(order).toEqual(['in-transaction', 'first', 'third']);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('should never run after-commit tasks when the transaction rolls back', async () => {
    const { uow } = setup(true);
    const task = jest.fn();
    await expect(uow.run(async (_tx, afterCommit) => afterCommit(task))).rejects.toThrow('rollback');
    expect(task).not.toHaveBeenCalled();
  });
});

describe('drainQueue', () => {
  it('should resolve once nothing is pending and fail after the timeout otherwise', async () => {
    const idleAfter = jest
      .fn()
      .mockResolvedValueOnce({ waiting: 1, active: 0 })
      .mockResolvedValue({ waiting: 0, active: 0 });
    await expect(drainQueue({ name: 'q', getJobCounts: idleAfter } as unknown as Queue, 1000, 1)).resolves.toBeUndefined();
    expect(idleAfter).toHaveBeenCalledTimes(2);

    const busy = jest.fn().mockResolvedValue({ active: 1 });
    await expect(drainQueue({ name: 'q', getJobCounts: busy } as unknown as Queue, 5, 1)).rejects.toThrow(/still has pending jobs/);
  });
});

describe('mountBullBoard', () => {
  it('should serve the dashboard for every queue at /admin/queues', () => {
    // Stand-ins the adapter accepts as BullMQ queues; real ones would open Redis connections.
    const app = { get: jest.fn(() => ({ name: 'q', metaValues: { version: 'bullmq:5' } })), use: jest.fn() };
    mountBullBoard(app as unknown as NestExpressApplication);
    expect(app.get).toHaveBeenCalledTimes(QUEUE_NAMES.length);
    expect(app.use).toHaveBeenCalledWith(BULL_BOARD_PATH, expect.any(Function));
  });
});
