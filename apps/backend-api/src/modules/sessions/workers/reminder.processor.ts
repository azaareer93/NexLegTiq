import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { getQueue, QUEUE, workerOptions } from '../../../common/queue/queues';
import { parseTenantJob } from '../../../common/queue/tenant-job';
import type { TenantJobData } from '../../../common/queue/tenant-job';
import { TenantProcessor } from '../../../common/queue/tenant-processor';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import { PrismaService } from '../../../database/prisma.service';
import { ReminderDelivery } from '../reminder-delivery';
import { ReminderScheduler, SEND_SESSION_REMINDER_JOB } from '../reminder-scheduler';
import type { SessionReminderJob } from '../reminder-scheduler';

export const RECONCILE_REMINDERS_JOB = 'reconcile-reminders';
/** Daily at 02:00 UTC (night in the launch market), a time nobody is reminded at (09:00 office time). */
export const RECONCILE_SCHEDULE = { pattern: '0 2 * * *', tz: 'UTC' } as const;

const SessionReminderJobSchema = z.object({ reminderId: z.uuid() });

/**
 * The single consumer of the `reminder` queue (MVP-68, D-117):
 * - `send-session-reminder` (delayed, per reminder row): `ReminderDelivery` in the reminder's office; after the last
 *   failed attempt the row becomes FAILED;
 * - `reconcile-reminders` (daily job scheduler, no office): re-adds the job of every PENDING reminder of an active office,
 *   so reminders survive a Redis loss or an enqueue that failed after its commit. Jobs still in Redis are left alone
 *   (BullMQ ignores a job id it already has).
 */
@Injectable()
@Processor(QUEUE.REMINDER, workerOptions(QUEUE.REMINDER))
export class ReminderProcessor
  extends TenantProcessor<SessionReminderJob>
  implements OnApplicationBootstrap
{
  protected readonly schema = SessionReminderJobSchema;

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly delivery: ReminderDelivery,
    private readonly scheduler: ReminderScheduler,
    private readonly moduleRef: ModuleRef,
  ) {
    super(tenant, prisma, logger);
  }

  /** Registers (or updates) the daily reconciliation; a Redis outage at boot is logged, not fatal. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await getQueue(this.moduleRef, QUEUE.REMINDER).upsertJobScheduler(
        RECONCILE_REMINDERS_JOB,
        RECONCILE_SCHEDULE,
        { name: RECONCILE_REMINDERS_JOB, data: {} },
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'Reminder reconciliation not scheduled');
    }
  }

  /** The reconciliation spans every office, so it runs before the tenant checks of `TenantProcessor.process`. */
  override async process(job: Job<SessionReminderJob & TenantJobData>): Promise<unknown> {
    if (job.name === RECONCILE_REMINDERS_JOB) return this.reconcile();
    return super.process(job);
  }

  protected async handle(job: Job<SessionReminderJob & TenantJobData>): Promise<unknown> {
    if (job.name !== SEND_SESSION_REMINDER_JOB) {
      throw new UnrecoverableError(`Unknown reminder job ${job.name}`);
    }
    return this.delivery.deliver(job.data.reminderId);
  }

  /** Re-adds the job of every PENDING reminder, office by office in that office's context. */
  async reconcile(): Promise<{ readonly enqueued: number; readonly pending: number }> {
    // ponytail: one read of every PENDING row (a few per upcoming hearing); page by id if offices grow to many thousands.
    // unscoped: the daily sweep covers every office; each office's rows are then enqueued in that office's context.
    const rows = await this.prisma.unscoped().sessionReminder.findMany({
      where: { status: 'PENDING', office: { isActive: true } },
      select: { id: true, officeId: true, scheduledFor: true },
      orderBy: [{ officeId: 'asc' }, { scheduledFor: 'asc' }],
    });
    const byOffice = new Map<string, typeof rows>();
    for (const row of rows) {
      const batch = byOffice.get(row.officeId);
      if (batch) batch.push(row);
      else byOffice.set(row.officeId, [row]);
    }
    let enqueued = 0;
    for (const [officeId, reminders] of byOffice) {
      enqueued += await this.tenant.run({ officeId: officeId as OfficeId }, () =>
        this.scheduler.enqueue(reminders),
      );
    }
    this.logger.info({ pending: rows.length, enqueued }, 'Reminders reconciled');
    return { enqueued, pending: rows.length };
  }

  /** The last attempt of a reminder failed (or it cannot succeed): the row becomes FAILED. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (job?.name !== SEND_SESSION_REMINDER_JOB) return;
    const final =
      error.name === 'UnrecoverableError' || job.attemptsMade >= (job.opts.attempts ?? 1);
    const tenant = parseTenantJob(job.data);
    const fields = SessionReminderJobSchema.safeParse(job.data);
    if (!final || !tenant || !fields.success) return;
    try {
      await this.tenant.run({ officeId: tenant.officeId }, () =>
        this.delivery.markFailed(fields.data.reminderId),
      );
    } catch (markError) {
      this.logger.error(
        { err: markError, reminderId: fields.data.reminderId },
        'Reminder not marked FAILED',
      );
    }
  }
}
