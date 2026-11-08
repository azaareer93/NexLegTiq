import { Injectable } from '@nestjs/common';

import { FAN_OUT_NOTIFICATION_JOB } from './notification-job';
import type { FanOutNotificationJob, NotificationContent } from './notification-job';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';

/**
 * Sends an in-app notification to users of the current office (D-149): one `notification/fan-out-notification` job, whose
 * worker keeps the recipients who want this type (D-146), writes the rows and pushes `notification` to each. Code that
 * writes a notification in its own transaction (an assignment, an accepted invitation) keeps writing the row itself.
 * `jobId` de-duplicates a retried producer. Email stays with the features that send one (hearing reminders).
 */
@Injectable()
export class NotificationService {
  constructor(private readonly queues: QueueProducer) {}

  async notify(
    userIds: readonly string[],
    content: NotificationContent,
    options: { readonly jobId?: string } = {},
  ): Promise<void> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return;
    await this.queues.enqueue<FanOutNotificationJob>(
      QUEUE.NOTIFICATION,
      FAN_OUT_NOTIFICATION_JOB,
      { ...content, userIds: unique },
      options,
    );
  }
}
