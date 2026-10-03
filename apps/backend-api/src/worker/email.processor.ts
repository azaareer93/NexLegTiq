import { Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { SEND_EMAIL_JOB } from '../common/mail/mail.service';
import { MailTransport } from '../common/mail/mail-transport';
import { MAIL_TEMPLATE_NAMES, renderMail } from '../common/mail/templates';
import type { MailLocale, MailTemplateName, MailTemplates } from '../common/mail/templates';
import { QUEUE, workerOptions } from '../common/queue/queues';
import type { TenantJobData } from '../common/queue/tenant-job';
import { TenantProcessor } from '../common/queue/tenant-processor';
import { TenantRunner } from '../common/tenancy/tenant-runner';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../database/prisma.service';
import { VerificationLinks } from '../modules/auth/verification-links';
import { SEND_VERIFICATION_EMAIL_JOB } from '../modules/auth/verification-mailer';

/** `send-email` (any template, rendered here) or `send-verification-email` (the link is created here, D-085). */
const EmailJobSchema = z.union([
  z.object({
    to: z.email(),
    template: z.enum(MAIL_TEMPLATE_NAMES),
    locale: z.enum(['AR', 'EN']),
    vars: z.record(z.string(), z.union([z.string(), z.number()])),
  }),
  z.object({ userId: z.uuid() }),
]);
type EmailJob = z.infer<typeof EmailJobSchema>;

export const SKIPPED_NOTHING_TO_SEND = { skipped: 'NOTHING_TO_SEND' } as const;

/**
 * The single consumer of the `email` queue (one processor per queue: BullMQ hands every job of a queue to its workers).
 * Lives in the worker's composition root because it joins common mail delivery with auth's verification links.
 * A delivery failure is EXT-001 and is retried per the email queue policy (3× fixed 5 s).
 */
@Injectable()
@Processor(QUEUE.EMAIL, workerOptions(QUEUE.EMAIL))
export class EmailProcessor extends TenantProcessor<EmailJob> {
  protected readonly schema = EmailJobSchema;

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly transport: MailTransport,
    private readonly links: VerificationLinks,
    private readonly config: AppConfig,
  ) {
    super(tenant, prisma, logger);
  }

  protected async handle(job: Job<EmailJob & TenantJobData>, signal: AbortSignal): Promise<unknown> {
    const data = job.data;
    if (job.name === SEND_VERIFICATION_EMAIL_JOB && 'userId' in data) {
      const email = await this.links.issue(data.userId, new Date());
      if (!email) return SKIPPED_NOTHING_TO_SEND;
      await this.deliver(email.to, 'verify-email', email.locale, email.vars, signal);
      return { sent: 'verify-email' };
    }
    if (job.name === SEND_EMAIL_JOB && 'template' in data) {
      await this.deliver(data.to, data.template, data.locale, data.vars as MailTemplates[typeof data.template], signal);
      return { sent: data.template };
    }
    throw new Error(`Unknown email job ${job.name}`);
  }

  private async deliver<T extends MailTemplateName>(to: string, template: T, locale: MailLocale, vars: MailTemplates[T], signal: AbortSignal) {
    await this.transport.send(to, renderMail(template, locale, vars, this.config.mail.officeAppUrl), signal);
  }
}
