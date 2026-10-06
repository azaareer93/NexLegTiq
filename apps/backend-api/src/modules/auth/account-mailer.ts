import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { tenantContextFor } from './client-info';
import type { ClientInfo } from './client-info';

export const SEND_VERIFICATION_EMAIL_JOB = 'send-verification-email';
export const SEND_PASSWORD_RESET_JOB = 'send-password-reset';

/**
 * Asks the worker for account emails whose link is secret: signup verification (D-085) and password reset (D-086). The job
 * carries only the user id; the worker creates the link itself (VerificationLinks, PasswordResetLinks), so no token ever sits
 * in Redis or on Bull Board. A failure is logged, never shown to the caller — the user can always ask again.
 */
@Injectable()
export class AccountMailer {
  constructor(
    private readonly tenant: TenantRunner,
    private readonly queues: QueueProducer,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AccountMailer.name);
  }

  sendVerification(user: AccountRef, client: ClientInfo): Promise<void> {
    return this.enqueue(SEND_VERIFICATION_EMAIL_JOB, user, client);
  }

  sendPasswordReset(user: AccountRef, client: ClientInfo): Promise<void> {
    return this.enqueue(SEND_PASSWORD_RESET_JOB, user, client);
  }

  private async enqueue(job: string, user: AccountRef, client: ClientInfo): Promise<void> {
    try {
      await this.tenant.run(tenantContextFor(user.officeId, user.userId, client), () =>
        this.queues.enqueue(QUEUE.EMAIL, job, { userId: user.userId }),
      );
    } catch (error) {
      this.logger.error(
        { err: error, userId: user.userId, job },
        'Could not enqueue an account email',
      );
    }
  }
}

export interface AccountRef {
  readonly userId: string;
  readonly officeId: string;
}
