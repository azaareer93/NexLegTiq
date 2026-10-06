import { Injectable } from '@nestjs/common';

import { QueueProducer } from '../queue/queue-producer';
import { QUEUE } from '../queue/queues';
import type { MailLocale, MailTemplateName, MailTemplates } from './templates';

export const SEND_EMAIL_JOB = 'send-email';

/**
 * Producer side of email (D-085): enqueues `email/send-email`; the worker renders and delivers it. Call it after the
 * transaction commits (`UnitOfWork` afterCommit). Never put secrets (tokens, passwords) in `vars`: job payloads stay in Redis
 * and on Bull Board — flows with secret links enqueue their own job that creates the link in the worker.
 */
@Injectable()
export class MailService {
  constructor(private readonly queues: QueueProducer) {}

  async send<T extends MailTemplateName>(
    to: string,
    template: T,
    locale: MailLocale,
    vars: MailTemplates[T],
  ): Promise<void> {
    await this.queues.enqueue(QUEUE.EMAIL, SEND_EMAIL_JOB, { to, template, locale, vars });
  }
}
