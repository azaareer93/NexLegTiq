import { Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { getQueue, QUEUE, workerOptions } from '../../../common/queue/queues';
import type { TenantJobData } from '../../../common/queue/tenant-job';
import { TenantProcessor } from '../../../common/queue/tenant-processor';
import { RealtimePublisher } from '../../../common/realtime/realtime.publisher';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import { PrismaService } from '../../../database/prisma.service';
import {
  FAN_OUT_NOTIFICATION_JOB,
  FanOutNotificationJobSchema,
  NOTIFICATION_RETENTION_DAYS,
  PURGE_NOTIFICATIONS_JOB,
} from '../notification-job';
import type { FanOutNotificationJob } from '../notification-job';
import { recipientsWanting } from '../notification-preferences';
import { upgradeLegacyJob } from './legacy-notification-job';

/** Daily at 03:30 UTC, after the audit purge. */
const PURGE_SCHEDULE = { pattern: '30 3 * * *', tz: 'UTC' } as const;
const DAY_MS = 86_400_000;

/**
 * The single consumer of the `notification` queue (D-149). `fan-out-notification` keeps the recipients who want the type
 * (D-146), writes their rows in one statement (the users' composite foreign key keeps them in the job's office) and
 * pushes `notification` to each; a retry after the rows were written can duplicate them (rare, harmless — producers
 * de-duplicate with a job id). `purge-notifications` (daily scheduler, no office) removes rows older than 90 days.
 */
@Injectable()
@Processor(QUEUE.NOTIFICATION, workerOptions(QUEUE.NOTIFICATION))
export class NotificationProcessor
  extends TenantProcessor<FanOutNotificationJob>
  implements OnApplicationBootstrap
{
  protected readonly schema = FanOutNotificationJobSchema;

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly realtime: RealtimePublisher,
    private readonly moduleRef: ModuleRef,
  ) {
    super(tenant, prisma, logger);
  }

  /** Registers (or updates) the daily purge; a Redis outage at boot is logged, not fatal. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await getQueue(this.moduleRef, QUEUE.NOTIFICATION).upsertJobScheduler(
        PURGE_NOTIFICATIONS_JOB,
        PURGE_SCHEDULE,
        { name: PURGE_NOTIFICATIONS_JOB, data: {} },
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'Notification retention purge not scheduled');
    }
  }

  /** The purge spans every office, so it runs before the tenant checks — only as the scheduler queues it (no office). */
  override async process(job: Job<FanOutNotificationJob & TenantJobData>): Promise<unknown> {
    const data: unknown = job.data;
    const platform = typeof data === 'object' && data !== null && !('officeId' in data);
    if (job.name === PURGE_NOTIFICATIONS_JOB && platform) return this.purge();
    return super.process(upgradeLegacyJob(job));
  }

  protected async handle(job: Job<FanOutNotificationJob & TenantJobData>): Promise<unknown> {
    if (job.name !== FAN_OUT_NOTIFICATION_JOB) {
      throw new UnrecoverableError(`Unknown notification job ${job.name}`);
    }
    const { officeId, userIds, type, titleKey, params, link } = job.data;
    // Turned off for this category in the recipients' preferences (D-146): nothing is written or pushed to them.
    const wanted = [...(await recipientsWanting(this.prisma.db, userIds, type, 'inApp'))];
    if (wanted.length === 0) return { created: 0 };
    const rows = await this.prisma.db.notification.createManyAndReturn({
      data: wanted.map((userId) => ({
        officeId,
        userId,
        type,
        titleKey,
        params,
        link,
        channel: 'IN_APP',
      })),
      select: { id: true, userId: true },
    });
    for (const row of rows)
      this.realtime.toUser(row.userId, 'notification', { notificationId: row.id });
    return { created: rows.length };
  }

  /** Every office, one statement each (a first run never holds one huge DELETE): rows older than 90 days go (D-149). */
  async purge(): Promise<{ readonly removed: number }> {
    // unscoped: the daily retention purge covers every office.
    const raw = this.prisma.unscoped();
    const before = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
    const offices = await raw.office.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    let removed = 0;
    for (const { id } of offices) {
      const { count } = await raw.notification.deleteMany({
        where: { officeId: id, createdAt: { lt: before } },
      });
      removed += count;
    }
    this.logger.info({ removed }, 'Notification retention applied');
    return { removed };
  }
}
