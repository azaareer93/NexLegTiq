import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { tenantContextFor } from './client-info';
import type { ClientInfo } from './client-info';

export const SEND_VERIFICATION_EMAIL_JOB = 'send-verification-email';

/**
 * Asks the worker to send a signup verification email (D-083, D-085). The job carries only the user id: the worker creates
 * the link itself (VerificationLinks), so no token ever sits in Redis or on Bull Board. Called after signup has committed
 * and by resend; a failure is logged, never shown to the user — resend is the way back.
 */
@Injectable()
export class VerificationMailer {
  constructor(
    private readonly tenant: TenantRunner,
    private readonly queues: QueueProducer,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(VerificationMailer.name);
  }

  async send(user: { userId: string; officeId: string }, client: ClientInfo): Promise<void> {
    try {
      await this.tenant.run(tenantContextFor(user.officeId, user.userId, client), () =>
        this.queues.enqueue(QUEUE.EMAIL, SEND_VERIFICATION_EMAIL_JOB, { userId: user.userId }),
      );
    } catch (error) {
      this.logger.error({ err: error, userId: user.userId }, 'Could not enqueue the verification email');
    }
  }
}
