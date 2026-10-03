import { EventEmitter } from 'node:events';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { UnrecoverableError } from 'bullmq';
import type { Job, Queue } from 'bullmq';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import type { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { RequestContext } from '../context/request-context';
import { TenantRunner } from '../tenancy/tenant-runner';
import { TenantContextMissingError } from '../tenancy/tenant.errors';
import { BULL_BOARD_PATH, mountBullBoard } from './bull-board';
import { ENQUEUE_TIMEOUT_MS, QueueProducer } from './queue-producer';
import { QUEUE, QUEUE_NAMES, QUEUE_POLICY, workerOptions } from './queues';
import { redisConnectionOptions } from './redis-connection';
import { parseTenantJob } from './tenant-job';
import type { TenantJobData } from './tenant-job';
import { SKIPPED_OFFICE_INACTIVE, TenantProcessor } from './tenant-processor';
import { drainQueue } from './testing';
import { withTimeout } from './with-timeout';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const cls = ClsServiceManager.getClsService<RequestContext>();
const logger = () =>
  ({ setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }) as unknown as PinoLogger & { warn: jest.Mock; error: jest.Mock };
const inOffice = <T>(work: () => Promise<T>, requestId = 'req-12345678') =>
  new TenantRunner(cls).run({ officeId: OFFICE as never, requestId }, work);

describe('queues (D-011, architecture.md)', () => {
  it('should define exactly the canonical queues, without a -queue suffix', () => {
    expect([...QUEUE_NAMES].sort()).toEqual(['ai', 'batch-ingest', 'email', 'notification', 'ocr', 'reminder', 'report']);
  });

  it.each([
    ['ocr', 3, { type: 'exponential', delay: 1000 }, 60_000, 10],
    ['ai', 2, { type: 'fixed', delay: 10_000 }, 120_000, 5],
    ['reminder', 3, { type: 'exponential', delay: 1000 }, 30_000, 10],
    ['email', 3, { type: 'fixed', delay: 5000 }, 30_000, 2],
    ['notification', 3, { type: 'exponential', delay: 1000 }, 30_000, 10],
    ['report', 2, { type: 'exponential', delay: 1000 }, 120_000, 2],
    ['batch-ingest', 1, undefined, 120_000, 5],
  ] as const)('should give %s its retry, timeout and concurrency', (name, attempts, backoff, timeoutMs, concurrency) => {
    expect(QUEUE_POLICY[name]).toMatchObject({ jobs: { attempts }, timeoutMs, concurrency });
    expect(QUEUE_POLICY[name].jobs.backoff).toEqual(backoff);
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
    expect(redisConnectionOptions('redis://[::1]:6379/0')).toMatchObject({ host: '::1', db: 0 });
  });

  it('should refuse a non-numeric database', () => {
    expect(() => redisConnectionOptions('redis://127.0.0.1/cache')).toThrow(/must be a number/);
  });
});

describe('parseTenantJob', () => {
  it('should accept a payload with an office uuid and a safe request id or null', () => {
    expect(parseTenantJob({ officeId: OFFICE, requestId: 'req-12345678', x: 1 })).toEqual({ officeId: OFFICE, requestId: 'req-12345678' });
    expect(parseTenantJob({ officeId: OFFICE, requestId: null })).toEqual({ officeId: OFFICE, requestId: null });
  });

  it('should drop a request id that is not D-076-safe instead of trusting it', () => {
    expect(parseTenantJob({ officeId: OFFICE, requestId: 'bad id\nINJECTED' })).toEqual({ officeId: OFFICE, requestId: null });
  });

  it.each([[{}], [{ officeId: 'nope', requestId: null }], [{ officeId: OFFICE }], [null]])('should reject %j', (data) => {
    expect(parseTenantJob(data)).toBeNull();
  });
});

describe('QueueProducer', () => {
  interface MailJob {
    readonly to: string;
  }

  function setup() {
    const add = jest.fn().mockResolvedValue({ id: '1' });
    const moduleRef = { get: jest.fn().mockReturnValue({ add }) };
    return { producer: new QueueProducer(moduleRef as never, cls), add };
  }

  it('should add officeId and requestId from the tenant context to an interface-typed payload', async () => {
    const { producer, add } = setup();
    const mail: MailJob = { to: 'a@b.test' };
    await inOffice(() => producer.enqueue(QUEUE.EMAIL, 'send-email', mail, { delay: 10 }));
    expect(add).toHaveBeenCalledWith('send-email', { to: 'a@b.test', officeId: OFFICE, requestId: 'req-12345678' }, { delay: 10 });
  });

  it('should overwrite an officeId or requestId smuggled into the payload', async () => {
    const { producer, add } = setup();
    // @ts-expect-error -- callers cannot name the tenant fields; this proves the runtime guard too.
    await inOffice(() => producer.enqueue(QUEUE.EMAIL, 'send-email', { officeId: 'other-office', requestId: 'forged' }));
    expect(add.mock.calls[0][1]).toEqual({ officeId: OFFICE, requestId: 'req-12345678' });
  });

  it('should prefix a custom jobId with the office', async () => {
    const { producer, add } = setup();
    await inOffice(() => producer.enqueue(QUEUE.REMINDER, 'send-session-reminder', {}, { jobId: 'reminder-1', delay: 5 }));
    expect(add.mock.calls[0][2]).toEqual({ jobId: `${OFFICE}_reminder-1`, delay: 5 });
  });

  it('should fail an enqueue after the timeout while Redis is unreachable instead of hanging', async () => {
    jest.useFakeTimers();
    try {
      const moduleRef = { get: () => ({ add: () => new Promise(() => undefined) }) };
      const producer = new QueueProducer(moduleRef as never, cls);
      const pending = inOffice(() => producer.enqueue(QUEUE.EMAIL, 'send-email', {}));
      const settled = expect(pending).rejects.toThrow(`Timed out after ${ENQUEUE_TIMEOUT_MS} ms`);
      await jest.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);
      await settled;
    } finally {
      jest.useRealTimers();
    }
  });

  it('should refuse to enqueue outside a tenant context', async () => {
    const { producer, add } = setup();
    await expect(producer.enqueue(QUEUE.EMAIL, 'send-email', {})).rejects.toThrow(TenantContextMissingError);
    expect(add).not.toHaveBeenCalled();
  });
});

describe('TenantProcessor', () => {
  const EchoSchema = z.object({ ms: z.number().optional(), fail: z.boolean().optional() });
  type Echo = z.infer<typeof EchoSchema>;

  class EchoProcessor extends TenantProcessor<Echo> {
    protected readonly schema = EchoSchema;
    seen: (string | undefined)[] = [];
    protected async handle(job: Job<Echo & TenantJobData>): Promise<string> {
      this.seen.push(cls.get('officeId'));
      if (job.data.fail) throw new Error('boom');
      if (job.data.ms) await new Promise((resolve) => setTimeout(resolve, job.data.ms));
      return 'done';
    }
  }
  const job = (data: object, queueName = 'notification') => ({ id: '7', name: 'test', queueName, attemptsMade: 0, data }) as Job<never>;

  function setup(officeActive = true) {
    const log = logger();
    const findFirst = jest.fn().mockResolvedValue({ isActive: officeActive });
    const prisma = { db: { office: { findFirst } } } as unknown as PrismaService;
    return { processor: new EchoProcessor(new TenantRunner(cls), prisma, log), log };
  }

  it('should run the job in its office and return the result', async () => {
    const { processor } = setup();
    await expect(processor.process(job({ officeId: OFFICE, requestId: 'req-12345678' }))).resolves.toBe('done');
    expect(processor.seen).toEqual([OFFICE]);
  });

  it.each([
    ['no valid officeId', { requestId: null }],
    ['a job-specific field of the wrong type', { officeId: OFFICE, requestId: null, ms: 'soon' }],
  ])('should fail without retries for %s', async (_label, data) => {
    const { processor, log } = setup();
    await expect(processor.process(job(data))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(processor.seen).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ jobId: '7', queue: 'notification' }), expect.any(String));
  });

  it('should fail without retries on a queue without a policy', async () => {
    await expect(setup().processor.process(job({ officeId: OFFICE, requestId: null }, 'mystery'))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('should skip the job when its office has been suspended', async () => {
    const { processor, log } = setup(false);
    await expect(processor.process(job({ officeId: OFFICE, requestId: null }))).resolves.toEqual(SKIPPED_OFFICE_INACTIVE);
    expect(processor.seen).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ jobId: '7' }), 'Office is inactive; job skipped');
  });

  it('should log a failed attempt with the request id and rethrow it for BullMQ to retry', async () => {
    const { processor, log } = setup();
    await expect(processor.process(job({ officeId: OFFICE, requestId: 'req-99999999', fail: true }))).rejects.toThrow('boom');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-99999999', attempt: 1 }), 'Job attempt failed');
  });

  it('should log worker connection errors instead of crashing', () => {
    const { processor, log } = setup();
    processor.onWorkerError(new Error('ECONNREFUSED'));
    expect(log.error).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Worker connection error');
  });
});

describe('withTimeout', () => {
  it('should reject at the deadline and abort the signal handed to the work', async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withTimeout((signal) => {
        seen = signal;
        return new Promise(() => undefined);
      }, 5),
    ).rejects.toThrow('Timed out after 5 ms');
    expect(seen?.aborted).toBe(true);
  });

  it('should resolve with the work and leave the signal alone when it finishes in time', async () => {
    let seen: AbortSignal | undefined;
    await expect(
      withTimeout(async (signal) => {
        seen = signal;
        return 'ok';
      }, 50),
    ).resolves.toBe('ok');
    expect(seen?.aborted).toBe(false);
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

  it('should run after-commit tasks in order once the transaction committed, logging failures by label', async () => {
    const { uow, tx, log } = setup();
    const order: string[] = [];
    const result = await uow.run(async (given, afterCommit) => {
      expect(given).toBe(tx);
      afterCommit(async () => void order.push('first'));
      afterCommit(() => Promise.reject(new Error('redis down')), 'enqueue ocr');
      afterCommit(async () => void order.push('third'));
      order.push('in-transaction');
      return 42;
    });
    expect(result).toBe(42);
    expect(order).toEqual(['in-transaction', 'first', 'third']);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ task: 'enqueue ocr' }), expect.any(String));
  });

  it('should never run after-commit tasks when the transaction rolls back', async () => {
    const { uow } = setup(true);
    const task = jest.fn();
    await expect(uow.run(async (_tx, afterCommit) => afterCommit(task))).rejects.toThrow('rollback');
    expect(task).not.toHaveBeenCalled();
  });

  it('should refuse tasks registered after the transaction ended', async () => {
    const { uow } = setup();
    let late: ((task: () => Promise<unknown>) => void) | undefined;
    await uow.run(async (_tx, afterCommit) => {
      late = afterCommit;
    });
    expect(() => late?.(async () => undefined)).toThrow(/after the transaction ended/);
  });
});

describe('drainQueue', () => {
  it('should resolve once nothing is pending and fail after the timeout otherwise', async () => {
    const idleAfter = jest.fn().mockResolvedValueOnce({ waiting: 1, active: 0 }).mockResolvedValue({ waiting: 0, active: 0 });
    await expect(drainQueue({ name: 'q', getJobCounts: idleAfter } as unknown as Queue, 1000, 1)).resolves.toBeUndefined();
    expect(idleAfter).toHaveBeenCalledTimes(2);

    const busy = jest.fn().mockResolvedValue({ active: 1 });
    await expect(drainQueue({ name: 'q', getJobCounts: busy } as unknown as Queue, 5, 1)).rejects.toThrow(/still has pending jobs/);
  });
});

describe('mountBullBoard', () => {
  it('should serve the dashboard for every queue at /admin/queues, behind helmet without CSP', () => {
    // Stand-ins the adapter accepts as BullMQ queues; real ones would open Redis connections.
    const fake = () => Object.assign(new EventEmitter(), { name: 'q', metaValues: { version: 'bullmq:5' } });
    const app = { get: jest.fn(fake), use: jest.fn() };
    mountBullBoard(app as unknown as NestExpressApplication);
    expect(app.get).toHaveBeenCalledTimes(QUEUE_NAMES.length);
    expect(app.use).toHaveBeenCalledWith(BULL_BOARD_PATH, expect.any(Function), expect.any(Function));
  });
});
