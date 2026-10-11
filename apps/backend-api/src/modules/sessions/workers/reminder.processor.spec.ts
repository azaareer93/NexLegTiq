import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import {
  RECONCILE_REMINDERS_JOB,
  RECONCILE_SCHEDULE,
  ReminderProcessor,
} from './reminder.processor';
import type { RequestContext } from '../../../common/context/request-context';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import type { PrismaService } from '../../../database/prisma.service';
import type { ReminderDelivery } from '../reminder-delivery';
import type { ReminderScheduler } from '../reminder-scheduler';

const OFFICE_A = '01920000-0000-7000-8000-00000000000a';
const OFFICE_B = '01920000-0000-7000-8000-00000000000b';
const REMINDER = '01920000-0000-7000-8000-0000000000c1';

function setup() {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const offices: string[] = [];
  const rows = [
    { id: 'a1', officeId: OFFICE_A, scheduledFor: new Date() },
    { id: 'b1', officeId: OFFICE_B, scheduledFor: new Date() },
    { id: 'a2', officeId: OFFICE_A, scheduledFor: new Date() },
  ];
  const raw = { sessionReminder: { findMany: jest.fn().mockResolvedValue(rows) } };
  const prisma = {
    unscoped: () => raw,
    db: { office: { findFirst: jest.fn().mockResolvedValue({ isActive: true }) } },
  } as unknown as PrismaService;
  const deliver = jest.fn().mockResolvedValue({ sent: 'u1' });
  const markFailed = jest.fn(() => {
    offices.push(cls.get('officeId') as string);
    return Promise.resolve();
  });
  const enqueue = jest.fn((batch: unknown[]) => {
    offices.push(cls.get('officeId') as string);
    return Promise.resolve(batch.length);
  });
  const upsertJobScheduler = jest.fn().mockResolvedValue({});
  const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
  const processor = new ReminderProcessor(
    new TenantRunner(cls),
    prisma,
    logger,
    { deliver, markFailed } as unknown as ReminderDelivery,
    { enqueue } as unknown as ReminderScheduler,
    { get: () => ({ upsertJobScheduler }) } as never,
  );
  const job = (name: string, data: object, extra: object = {}) =>
    ({
      id: '1',
      name,
      queueName: 'reminder',
      attemptsMade: 0,
      opts: { attempts: 3 },
      data: { officeId: OFFICE_A, requestId: null, ...data },
      ...extra,
    }) as unknown as Job<never>;
  return { processor, raw, deliver, markFailed, enqueue, offices, upsertJobScheduler, job, logger };
}

describe('ReminderProcessor', () => {
  it('should register the daily reconciliation, and survive Redis being down at boot', async () => {
    const { processor, upsertJobScheduler, logger } = setup();
    await processor.onApplicationBootstrap();
    expect(upsertJobScheduler).toHaveBeenCalledWith(RECONCILE_REMINDERS_JOB, RECONCILE_SCHEDULE, {
      name: RECONCILE_REMINDERS_JOB,
      data: {},
    });
    upsertJobScheduler.mockRejectedValueOnce(new Error('redis down'));
    await expect(processor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("should deliver a reminder in the job's office", async () => {
    const { processor, deliver, job } = setup();
    await expect(
      processor.process(job('send-session-reminder', { reminderId: REMINDER })),
    ).resolves.toEqual({ sent: 'u1' });
    expect(deliver).toHaveBeenCalledWith(REMINDER);
  });

  it('should refuse an unknown job or a malformed payload without retries', async () => {
    const { processor, job } = setup();
    await expect(processor.process(job('other', { reminderId: REMINDER }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(
      processor.process(job('send-session-reminder', { reminderId: 'nope' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('should reconcile every PENDING reminder of active offices, each in its own office', async () => {
    const { processor, raw, enqueue, offices, job } = setup();
    await expect(
      processor.process(job(RECONCILE_REMINDERS_JOB, {}, { data: {} })),
    ).resolves.toEqual({ enqueued: 3, pending: 3 });
    expect(raw.sessionReminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'PENDING', office: { isActive: true } } }),
    );
    expect(
      enqueue.mock.calls.map(([batch]) => (batch as { id: string }[]).map((r) => r.id)),
    ).toEqual([['a1', 'a2'], ['b1']]);
    expect(offices).toEqual([OFFICE_A, OFFICE_B]);
  });

  it('should mark the reminder FAILED after its last attempt only', async () => {
    const { processor, markFailed, offices, job } = setup();
    const data = { reminderId: REMINDER };
    await processor.onFailed(
      job('send-session-reminder', data, { attemptsMade: 1 }),
      new Error('x'),
    );
    expect(markFailed).not.toHaveBeenCalled();
    await processor.onFailed(
      job('send-session-reminder', data, { attemptsMade: 3 }),
      new Error('x'),
    );
    expect(markFailed).toHaveBeenCalledWith(REMINDER);
    expect(offices).toEqual([OFFICE_A]);
    await processor.onFailed(
      job('send-session-reminder', data),
      new UnrecoverableError('Invalid job payload'),
    );
    expect(markFailed).toHaveBeenCalledTimes(2);
    await processor.onFailed(job(RECONCILE_REMINDERS_JOB, {}, { attemptsMade: 3 }), new Error('x'));
    await processor.onFailed(undefined, new Error('x'));
    expect(markFailed).toHaveBeenCalledTimes(2);
  });
});
