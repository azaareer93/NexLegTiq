import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { reminderRows } from './session-rules';
import type { RequestContext } from '../../common/context/request-context';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { PrismaService } from '../../database/prisma.service';
import type { AfterCommit, ScopedTransaction } from '../../database/unit-of-work';

export const SEND_SESSION_REMINDER_JOB = 'send-session-reminder';

/** BullMQ forbids ':' in custom ids, so the ticket's `reminder:{id}` is `reminder-{id}` (stored `{officeId}_reminder-{id}`). */
export const reminderJobId = (reminderId: string): string => `reminder-${reminderId}`;

export interface SessionReminderJob {
  readonly reminderId: string;
}

/** What scheduling needs of a session. */
export interface ReminderTarget {
  readonly id: string;
  readonly fileId: string;
  readonly startsAt: Date;
  readonly attendingLawyerId: string;
}

/** A PENDING reminder row to (re-)enqueue. */
export interface DueReminder {
  readonly id: string;
  readonly scheduledFor: Date;
}

/**
 * Producer side of hearing reminders (MVP-68, D-117): writes `SessionReminder` rows inside the session's transaction (one
 * per reminder day × recipient) and, after the commit, adds a delayed `reminder` job per row or removes the jobs of rows it
 * cancelled. The worker re-checks each row before sending, so a job that could not be removed does nothing.
 */
@Injectable()
export class ReminderScheduler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueProducer,
    private readonly logger: PinoLogger,
    private readonly cls: ClsService<RequestContext>,
  ) {
    this.logger.setContext(ReminderScheduler.name);
  }

  /**
   * Rows for each day of `days` and each recipient — the attending lawyer and the file's responsible lawyer, if active —
   * due at 09:00 office time (`reminderRows`); jobs are enqueued after the commit.
   */
  async schedule(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    session: ReminderTarget,
    days: readonly number[],
  ): Promise<void> {
    const { timezone } = await tx.office.findFirstOrThrow({ select: { timezone: true } });
    const rows = reminderRows(session.startsAt, days, new Date(), timezone);
    if (rows.length === 0) return;
    const { responsibleLawyerId } = await tx.legalFile.findFirstOrThrow({
      where: { id: session.fileId },
      select: { responsibleLawyerId: true },
    });
    const wanted = [...new Set([session.attendingLawyerId, responsibleLawyerId])];
    const active = await tx.user.findMany({
      where: { id: { in: wanted }, isActive: true },
      select: { id: true },
    });
    const recipients = wanted.filter((id) => active.some((user) => user.id === id));
    const officeId = this.officeId();
    const created = await tx.sessionReminder.createManyAndReturn({
      data: recipients.flatMap((recipientId) =>
        rows.map((row) => ({ ...row, officeId, sessionId: session.id, recipientId })),
      ),
      select: { id: true, scheduledFor: true },
    });
    afterCommit(() => this.enqueue(created), 'enqueue session reminders');
  }

  /** PENDING reminders of a session end (CANCELLED) and their jobs are removed after the commit; sent ones stay. */
  async cancel(tx: ScopedTransaction, afterCommit: AfterCommit, sessionId: string): Promise<void> {
    await this.cancelWhere(tx, afterCommit, { sessionId });
  }

  /** For the file lifecycle (closing or archiving a file): every PENDING reminder of its sessions ends. */
  async cancelForFile(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    fileId: string,
  ): Promise<void> {
    await this.cancelWhere(tx, afterCommit, { session: { is: { fileId } } });
  }

  /** After a reschedule, a new attending lawyer or new offsets: the pending reminders are replaced. */
  async reset(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    session: ReminderTarget,
    days: readonly number[],
  ): Promise<void> {
    await this.cancel(tx, afterCommit, session.id);
    await this.schedule(tx, afterCommit, session, days);
  }

  /**
   * Adds the delayed job of each reminder (current office context) and records its `jobId`. A job id already in the
   * queue is left as it is (BullMQ de-duplicates), so the reconciliation can call this for every PENDING row. Failures
   * are logged per row: the daily reconciliation retries them. Returns how many were handed to the queue.
   */
  async enqueue(reminders: readonly DueReminder[]): Promise<number> {
    let enqueued = 0;
    for (const reminder of reminders) {
      const jobId = reminderJobId(reminder.id);
      try {
        await this.queues.enqueue<SessionReminderJob>(
          QUEUE.REMINDER,
          SEND_SESSION_REMINDER_JOB,
          { reminderId: reminder.id },
          { jobId, delay: Math.max(0, reminder.scheduledFor.getTime() - Date.now()) },
        );
        await this.prisma.db.sessionReminder.updateMany({
          where: { id: reminder.id, jobId: null },
          data: { jobId },
        });
        enqueued += 1;
      } catch (error) {
        this.logger.error({ err: error, reminderId: reminder.id }, 'Reminder not enqueued');
      }
    }
    return enqueued;
  }

  private async cancelWhere(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    where: { sessionId: string } | { session: { is: { fileId: string } } },
  ): Promise<void> {
    const cancelled = await tx.sessionReminder.updateManyAndReturn({
      where: { ...where, status: 'PENDING' },
      data: { status: 'CANCELLED' },
      select: { id: true },
    });
    if (cancelled.length === 0) return;
    afterCommit(async () => {
      for (const { id } of cancelled) await this.queues.remove(QUEUE.REMINDER, reminderJobId(id));
    }, 'remove session reminder jobs');
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context');
    return officeId;
  }
}
