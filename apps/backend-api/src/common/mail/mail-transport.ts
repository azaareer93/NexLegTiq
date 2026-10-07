import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import type { RenderedMail } from './templates';
import { AppConfig } from '../../config/app-config';
import { AppException } from '../errors/app.exception';

const RESEND_URL = 'https://api.resend.com/emails';

export interface SendOptions {
  readonly signal?: AbortSignal;
  /** Resend de-duplicates requests with the same key: a retried job whose first answer was lost sends once. */
  readonly idempotencyKey?: string;
}

/**
 * Sends a rendered email through `EMAIL_PROVIDER` (D-085): SMTP (Mailpit locally, any relay; TLS rules of D-078) or the
 * Resend HTTP API. Temporary failures (network, timeouts, 429, 5xx) are EXT-001 and retried by the email queue; a request
 * the provider will never accept (other 4xx) fails the job at once. Provider messages never reach the error — SMTP replies
 * quote the recipient's address — only its code. Used by the worker only.
 */
@Injectable()
export class MailTransport implements OnModuleDestroy {
  private smtp: Transporter | undefined;

  constructor(private readonly config: AppConfig) {}

  async send(to: string, mail: RenderedMail, options: SendOptions = {}): Promise<void> {
    const { provider, from } = this.config.mail;
    try {
      if (provider === 'resend') await this.sendWithResend(from, to, mail, options);
      else
        await this.smtpTransport().sendMail({
          from,
          to,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
        });
    } catch (error) {
      if (error instanceof AppException || error instanceof UnrecoverableError) throw error;
      throw new AppException('EXT-001', 'Email provider failed', undefined, {
        cause: providerFailure(error),
      });
    }
  }

  onModuleDestroy(): void {
    this.smtp?.close();
  }

  private smtpTransport(): Transporter {
    const { host, port, secure, requireTLS, auth } = this.config.mail;
    // Well inside the email queue's 30 s attempt timeout: a slow server fails this attempt instead of delivering late,
    // after the retry has already sent (nodemailer ignores abort signals).
    this.smtp ??= nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS,
      ...(auth ? { auth } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    return this.smtp;
  }

  private async sendWithResend(
    from: string,
    to: string,
    mail: RenderedMail,
    options: SendOptions,
  ): Promise<void> {
    const response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.mail.resendApiKey ?? ''}`,
        'Content-Type': 'application/json',
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.ok) return;
    // The response body may echo the address; only the status goes into the error.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new UnrecoverableError(`Email provider refused the message (${response.status})`);
    }
    throw new AppException('EXT-001', `Email provider answered ${response.status}`);
  }
}

/** What may be logged about a provider failure: its codes, never its message. */
function providerFailure(error: unknown): Record<string, unknown> {
  const { code, responseCode, name } = (error ?? {}) as {
    code?: unknown;
    responseCode?: unknown;
    name?: unknown;
  };
  return { name, code, responseCode };
}
