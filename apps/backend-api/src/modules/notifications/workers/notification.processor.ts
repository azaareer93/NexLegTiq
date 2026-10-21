import { Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';

import { QUEUE, workerOptions } from '../../../common/queue/queues';
import type { TenantJobData } from '../../../common/queue/tenant-job';
import { TenantProcessor } from '../../../common/queue/tenant-processor';
import { RealtimePublisher } from '../../../common/realtime/realtime.publisher';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import { PrismaService } from '../../../database/prisma.service';
import { CREATE_NOTIFICATION_JOB, NotificationJobSchema } from '../notification-job';
import type { NotificationJob } from '../notification-job';

/**
 * The single consumer of the `notification` queue: writes in-app notifications (MVP-68). The user's composite foreign
 * key keeps them in the job's office. Producers de-duplicate with a job id; a retry after the row was written can
 * duplicate it (rare, harmless). Real-time push joins with the WebSocket gateway.
 */
@Injectable()
@Processor(QUEUE.NOTIFICATION, workerOptions(QUEUE.NOTIFICATION))
export class NotificationProcessor extends TenantProcessor<NotificationJob> {
  protected readonly schema = NotificationJobSchema;

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly realtime: RealtimePublisher,
  ) {
    super(tenant, prisma, logger);
  }

  protected async handle(job: Job<NotificationJob & TenantJobData>): Promise<unknown> {
    if (job.name !== CREATE_NOTIFICATION_JOB) {
      throw new UnrecoverableError(`Unknown notification job ${job.name}`);
    }
    const { officeId, userId, type, titleKey, params, link } = job.data;
    const { id } = await this.prisma.db.notification.create({
      data: { officeId, userId, type, titleKey, params, link, channel: 'IN_APP' },
      select: { id: true },
    });
    this.realtime.toUser(userId, 'notification', { notificationId: id });
    return { notificationId: id };
  }
}
