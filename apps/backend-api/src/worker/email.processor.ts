import { Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { MailTransport } from '../common/mail/mail-transport';
import { SEND_EMAIL_JOB } from '../common/mail/mail.service';
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
import { InvitationLinks, SEND_INVITATION_JOB } from '../modules/auth/invitation-links';
import type { InvitationEmail } from '../modules/auth/invitation-links';
import { PasswordResetLinks } from '../modules/auth/password-reset-links';
import type { PasswordResetEmail } from '../modules/auth/password-reset-links';
import { VerificationLinks } from '../modules/auth/verification-links';
import type { VerificationEmail } from '../modules/auth/verification-links';

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
  z.object({
    to: z.email(),
    template: z.literal('hearing-reminder'),
    locale,
    vars: MAIL_TEMPLATE_SCHEMAS['hearing-reminder'],
  }),
]);
/**
 * `send-email` (any template, rendered here), or `send-verification-email` / `send-password-reset` / `send-invitation`
 * (the link is created here).
 */
const EmailJobSchema = z.union([
  SendEmailSchema,
  z.object({ userId: z.uuid() }),
  z.object({ invitationId: z.uuid() }),
]);
type EmailJob = z.infer<typeof EmailJobSchema>;

export const SKIPPED_NOTHING_TO_SEND = { skipped: 'NOTHING_TO_SEND' } as const;

type LinkedEmail =
  | { template: 'verify-email'; email: VerificationEmail }
  | { template: 'password-reset'; email: PasswordResetEmail }
  | { template: 'invite'; email: InvitationEmail };

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
    private readonly invitationLinks: InvitationLinks,
    private readonly config: AppConfig,
  ) {
    super(tenant, prisma, logger);
  }

  protected async handle(
    job: Job<EmailJob & TenantJobData>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const data = job.data;
    const linked = await this.issueLink(job.name, data, job.attemptsMade > 0);
    if (linked === null) return SKIPPED_NOTHING_TO_SEND;
    if (linked) {
      // Each attempt issues its own link, so each attempt is its own message for de-duplication.
      await this.deliver(linked.email.to, linked.template, linked.email.locale, linked.email.vars, {
        signal,
        idempotencyKey: `${job.id}-${job.attemptsMade}`,
      });
      return { sent: linked.template };
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

  /**
   * The emails whose link the worker creates (verification, reset, invitation): the template and what to send, null when
   * there is nothing to send, undefined for any other job.
   */
  private async issueLink(
    name: string,
    data: EmailJob,
    retry: boolean,
  ): Promise<LinkedEmail | null | undefined> {
    const now = new Date();
    if (name === SEND_VERIFICATION_EMAIL_JOB && 'userId' in data) {
      const email = await this.links.issue(data.userId, now, { retry });
      return email && { template: 'verify-email', email };
    }
    if (name === SEND_PASSWORD_RESET_JOB && 'userId' in data) {
      const email = await this.resetLinks.issue(data.userId, now, { retry });
      return email && { template: 'password-reset', email };
    }
    if (name === SEND_INVITATION_JOB && 'invitationId' in data) {
      const email = await this.invitationLinks.issue(data.invitationId, now);
      return email && { template: 'invite', email };
    }
    return undefined;
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
