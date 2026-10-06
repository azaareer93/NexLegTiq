import { Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { SEND_EMAIL_JOB } from '../common/mail/mail.service';
import { MailTransport } from '../common/mail/mail-transport';
import { MAIL_TEMPLATE_SCHEMAS, renderMail } from '../common/mail/templates';
import type { MailLocale, MailTemplateName, MailTemplates } from '../common/mail/templates';
import { QUEUE, workerOptions } from '../common/queue/queues';
import type { TenantJobData } from '../common/queue/tenant-job';
import { TenantProcessor } from '../common/queue/tenant-processor';
import { TenantRunner } from '../common/tenancy/tenant-runner';
import { AppConfig } from '../config/app-config';
import { PrismaService } from '../database/prisma.service';
import {
  SEND_PASSWORD_RESET_JOB,
  SEND_VERIFICATION_EMAIL_JOB,
} from '../modules/auth/account-mailer';
import { PasswordResetLinks } from '../modules/auth/password-reset-links';
import { VerificationLinks } from '../modules/auth/verification-links';

const locale = z.enum(['AR', 'EN']);
/** One variant per template, so each email's variables are checked before rendering (D-085). */
const SendEmailSchema = z.discriminatedUnion('template', [
  z.object({
    to: z.email(),
    template: z.literal('verify-email'),
    locale,
    vars: MAIL_TEMPLATE_SCHEMAS['verify-email'],
  }),
  z.object({
    to: z.email(),
    template: z.literal('invite'),
    locale,
    vars: MAIL_TEMPLATE_SCHEMAS.invite,
  }),
  z.object({
    to: z.email(),
    template: z.literal('password-reset'),
    locale,
    vars: MAIL_TEMPLATE_SCHEMAS['password-reset'],
  }),
]);
/** `send-email` (any template, rendered here), or `send-verification-email` / `send-password-reset` (the link is created here). */
const EmailJobSchema = z.union([SendEmailSchema, z.object({ userId: z.uuid() })]);
type EmailJob = z.infer<typeof EmailJobSchema>;

export const SKIPPED_NOTHING_TO_SEND = { skipped: 'NOTHING_TO_SEND' } as const;

/**
 * The single consumer of the `email` queue (one processor per queue: BullMQ hands every job of a queue to its workers).
 * Lives in the worker's composition root because it joins common mail delivery with auth's verification links.
 * A delivery failure is EXT-001 and is retried per the email queue policy (3× fixed 5 s); anything that cannot succeed on a
 * retry — an unknown job, a link outside the office app, a refused message — fails at once.
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
    private readonly resetLinks: PasswordResetLinks,
    private readonly config: AppConfig,
  ) {
    super(tenant, prisma, logger);
  }

  protected async handle(
    job: Job<EmailJob & TenantJobData>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const data = job.data;
    if (job.name === SEND_VERIFICATION_EMAIL_JOB && 'userId' in data) {
      const email = await this.links.issue(data.userId, new Date(), {
        retry: job.attemptsMade > 0,
      });
      if (!email) return SKIPPED_NOTHING_TO_SEND;
      // Each attempt issues its own link, so each attempt is its own message for de-duplication.
      await this.deliver(email.to, 'verify-email', email.locale, email.vars, {
        signal,
        idempotencyKey: `${job.id}-${job.attemptsMade}`,
      });
      return { sent: 'verify-email' };
    }
    if (job.name === SEND_PASSWORD_RESET_JOB && 'userId' in data) {
      const email = await this.resetLinks.issue(data.userId, new Date(), {
        retry: job.attemptsMade > 0,
      });
      if (!email) return SKIPPED_NOTHING_TO_SEND;
      await this.deliver(email.to, 'password-reset', email.locale, email.vars, {
        signal,
        idempotencyKey: `${job.id}-${job.attemptsMade}`,
      });
      return { sent: 'password-reset' };
    }
    if (job.name === SEND_EMAIL_JOB && 'template' in data) {
      await this.deliver(
        data.to,
        data.template,
        data.locale,
        data.vars as MailTemplates[typeof data.template],
        {
          signal,
          idempotencyKey: `${job.id}`,
        },
      );
      return { sent: data.template };
    }
    throw new UnrecoverableError(`Unknown email job ${job.name}`);
  }

  private async deliver<T extends MailTemplateName>(
    to: string,
    template: T,
    locale: MailLocale,
    vars: MailTemplates[T],
    options: { signal: AbortSignal; idempotencyKey: string },
  ) {
    const { officeAppUrl } = this.config.mail;
    // Every button in our emails leads into the office app; anything else is a bug or an injected link.
    if (!vars.link.startsWith(`${officeAppUrl}/`))
      throw new UnrecoverableError('Email link does not point to the office app');
    await this.transport.send(to, renderMail(template, locale, vars, officeAppUrl), options);
  }
}
