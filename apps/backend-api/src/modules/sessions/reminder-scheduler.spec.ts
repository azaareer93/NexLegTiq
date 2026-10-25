import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { ReminderScheduler, SEND_SESSION_REMINDER_JOB } from './reminder-scheduler';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';

const OFFICE = '01920000-0000-7000-8000-0000000000aa';
const LAWYER = '01920000-0000-7000-8000-000000000002';
const RESPONSIBLE = '01920000-0000-7000-8000-000000000003';
const SESSION = '01920000-0000-7000-8000-0000000000a1';
const FILE = '01920000-0000-7000-8000-0000000000f1';
const DAY_MS = 86_400_000;

function setup({ responsible = RESPONSIBLE, active = [LAWYER, RESPONSIBLE] } = {}) {
  const tx = {
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
    legalFile: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ responsibleLawyerId: responsible }),
    },
    user: {
      findMany: jest.fn().mockResolvedValue(active.map((id) => ({ id }))),
    },
    sessionReminder: {
      createManyAndReturn: jest.fn(({ data }: { data: object[] }) =>
        data.map((row, index) => ({ ...row, id: `r${index}` })),
      ),
      updateManyAndReturn: jest.fn().mockResolvedValue([{ id: 'old1' }, { id: 'old2' }]),
      findMany: jest.fn().mockResolvedValue([{ recipientId: LAWYER, daysBefore: 3 }]),
    },
  };
  const db = { sessionReminder: { updateMany: jest.fn() } };
  const queues = { enqueue: jest.fn().mockResolvedValue({}), remove: jest.fn() };
  const logger = { setContext: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
  const cls = { get: () => OFFICE } as unknown as ClsService<RequestContext>;
  const scheduler = new ReminderScheduler(
    { db } as unknown as PrismaService,
    queues as unknown as QueueProducer,
    logger,
    cls,
  );
  const tasks: (() => Promise<unknown>)[] = [];
  const afterCommit = (task: () => Promise<unknown>) => void tasks.push(task);
  const runAfterCommit = async () => {
    for (const task of tasks) await task();
  };
  return {
    scheduler,
    tx,
    t: tx as unknown as ScopedTransaction,
    db,
    queues,
    logger,
    afterCommit,
    runAfterCommit,
  };
}

const session = (startsAt = new Date(Date.now() + 30 * DAY_MS)) => ({
  id: SESSION,
  fileId: FILE,
  startsAt,
  attendingLawyerId: LAWYER,
});

describe('ReminderScheduler', () => {
  it('should write a row per day and recipient, and enqueue delayed jobs only after the commit', async () => {
    const { scheduler, tx, t, queues, db, afterCommit, runAfterCommit } = setup();
    await scheduler.schedule(t, afterCommit, session(), [7, 1]);

    const { data } = tx.sessionReminder.createManyAndReturn.mock.calls[0]?.[0] as {
      data: { recipientId: string; daysBefore: number; officeId: string; sessionId: string }[];
    };
    expect(data.map((row) => [row.recipientId, row.daysBefore])).toEqual([
      [LAWYER, 7],
      [LAWYER, 1],
      [RESPONSIBLE, 7],
      [RESPONSIBLE, 1],
    ]);
    expect(data.every((row) => row.officeId === OFFICE && row.sessionId === SESSION)).toBe(true);
    expect(queues.enqueue).not.toHaveBeenCalled();

    await runAfterCommit();
    expect(queues.enqueue).toHaveBeenCalledTimes(4);
    const [queue, name, fields, options] = queues.enqueue.mock.calls[0] as [
      string,
      string,
      object,
      { jobId: string; delay: number },
    ];
    expect([queue, name, fields, options.jobId]).toEqual([
      'reminder',
      SEND_SESSION_REMINDER_JOB,
      { reminderId: 'r0' },
      'reminder-r0',
    ]);
    expect(options.delay).toBeGreaterThan(20 * DAY_MS);
    expect(db.sessionReminder.updateMany).toHaveBeenCalledWith({
      where: { id: 'r0', jobId: null },
      data: { jobId: 'reminder-r0' },
    });
  });

  it('should remind a lawyer who is both attending and responsible once, and skip inactive users', async () => {
    const same = setup({ responsible: LAWYER });
    await same.scheduler.schedule(same.t, same.afterCommit, session(), [1]);
    expect(same.tx.sessionReminder.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ recipientId: LAWYER })] }),
    );

    const inactive = setup({ active: [RESPONSIBLE] });
    await inactive.scheduler.schedule(inactive.t, inactive.afterCommit, session(), [1]);
    expect(inactive.tx.sessionReminder.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ recipientId: RESPONSIBLE })] }),
    );
  });

  it('should write nothing for a session that has started', async () => {
    const { scheduler, tx, t, afterCommit } = setup();
    await scheduler.schedule(t, afterCommit, session(new Date(Date.now() - 1000)), [1]);
    expect(tx.sessionReminder.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('should cancel PENDING rows and remove their jobs after the commit', async () => {
    const { scheduler, tx, t, queues, afterCommit, runAfterCommit } = setup();
    await scheduler.cancel(t, afterCommit, SESSION);
    expect(tx.sessionReminder.updateManyAndReturn).toHaveBeenCalledWith({
      where: { sessionId: SESSION, status: 'PENDING' },
      data: { status: 'CANCELLED' },
      select: { id: true },
    });
    expect(queues.remove).not.toHaveBeenCalled();
    await runAfterCommit();
    expect(queues.remove.mock.calls).toEqual([
      ['reminder', 'reminder-old1'],
      ['reminder', 'reminder-old2'],
    ]);

    await scheduler.cancelForFile(t, afterCommit, FILE);
    expect(tx.sessionReminder.updateManyAndReturn).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { session: { is: { fileId: FILE } }, status: 'PENDING' } }),
    );
  });

  it('should replace pending reminders on reset, never repeating one already sent for the same time', async () => {
    const days = (call: unknown) =>
      (call as [{ data: { recipientId: string; daysBefore: number }[] }])[0].data.map((row) => [
        row.recipientId,
        row.daysBefore,
      ]);
    // Same time (new offsets or lawyer): the lawyer already had the 3-day reminder, so only the 1-day one is new.
    const kept = setup();
    await kept.scheduler.reset(kept.t, kept.afterCommit, session(), [7, 3, 1], false);
    expect(kept.tx.sessionReminder.updateManyAndReturn).toHaveBeenCalled();
    expect(kept.tx.sessionReminder.findMany).toHaveBeenCalledWith({
      where: { sessionId: SESSION, status: 'SENT' },
      select: { recipientId: true, daysBefore: true },
    });
    expect(days(kept.tx.sessionReminder.createManyAndReturn.mock.calls[0])).toEqual([
      [LAWYER, 1],
      [RESPONSIBLE, 7],
      [RESPONSIBLE, 3],
      [RESPONSIBLE, 1],
    ]);
    // A new time: everyone is reminded again.
    const moved = setup();
    await moved.scheduler.reset(moved.t, moved.afterCommit, session(), [7, 3, 1], true);
    expect(moved.tx.sessionReminder.findMany).not.toHaveBeenCalled();
    expect(days(moved.tx.sessionReminder.createManyAndReturn.mock.calls[0])).toHaveLength(6);
  });

  it('should reset the reminders of every upcoming hearing of a file for its new lawyer (D-140)', async () => {
    const { scheduler, tx, t, afterCommit } = setup();
    const findMany = jest.fn().mockResolvedValue([{ ...session(), reminderDays: [3] }]);
    Object.assign(tx, { session: { findMany } });
    await scheduler.resetForFile(t, afterCommit, FILE);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fileId: FILE,
          isCancelled: false,
          outcome: null,
        }) as object,
      }),
    );
    // Same hearing time: the sent reminders are looked up so none is repeated.
    expect(tx.sessionReminder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sessionId: SESSION, status: 'SENT' } }),
    );
    expect(tx.sessionReminder.createManyAndReturn).toHaveBeenCalledTimes(1);
  });

  it('should refuse to schedule without an office in the context', async () => {
    const { tx, t, afterCommit } = setup();
    const scheduler = new ReminderScheduler(
      { db: tx } as unknown as PrismaService,
      { enqueue: jest.fn() } as unknown as QueueProducer,
      { setContext: jest.fn() } as unknown as PinoLogger,
      { get: () => undefined } as unknown as ClsService<RequestContext>,
    );
    await expect(scheduler.schedule(t, afterCommit, session(), [3])).rejects.toThrow('No office');
  });

  it('should write and remove nothing when no reminder was pending and every one was already sent', async () => {
    const { scheduler, tx, t, afterCommit, runAfterCommit, queues } = setup();
    tx.sessionReminder.updateManyAndReturn.mockResolvedValueOnce([]);
    tx.sessionReminder.findMany.mockResolvedValueOnce([
      { recipientId: LAWYER, daysBefore: 3 },
      { recipientId: RESPONSIBLE, daysBefore: 3 },
    ]);
    await scheduler.reset(t, afterCommit, session(), [3], false);
    await runAfterCommit();
    expect(tx.sessionReminder.createManyAndReturn).not.toHaveBeenCalled();
    expect(queues.remove).not.toHaveBeenCalled();
  });

  it('should keep enqueueing after one failure and report how many were handed over', async () => {
    const { scheduler, queues, logger } = setup();
    queues.enqueue.mockRejectedValueOnce(new Error('redis down'));
    const due = new Date(Date.now() - 1000);
    await expect(
      scheduler.enqueue([
        { id: 'a', scheduledFor: due },
        { id: 'b', scheduledFor: due },
      ]),
    ).resolves.toBe(1);
    expect(queues.enqueue).toHaveBeenLastCalledWith(
      'reminder',
      SEND_SESSION_REMINDER_JOB,
      { reminderId: 'b' },
      { jobId: 'reminder-b', delay: 0 },
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
