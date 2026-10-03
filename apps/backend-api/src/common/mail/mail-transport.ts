import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { AppConfig } from '../../config/app-config';
import { AppException } from '../errors/app.exception';
import type { RenderedMail } from './templates';

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * Sends a rendered email through `EMAIL_PROVIDER` (D-085): SMTP (Mailpit locally, any relay; TLS rules of D-078) or the
 * Resend HTTP API. Any failure is EXT-001, so the email job is retried per the queue policy. Used by the worker only.
 */
@Injectable()
export class MailTransport implements OnModuleDestroy {
  private smtp: Transporter | undefined;

  constructor(private readonly config: AppConfig) {}

  async send(to: string, mail: RenderedMail, signal?: AbortSignal): Promise<void> {
    const { provider, from } = this.config.mail;
    try {
      if (provider === 'resend') await this.sendWithResend(from, to, mail, signal);
      else await this.smtpTransport().sendMail({ from, to, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (error) {
      if (error instanceof AppException) throw error;
      throw new AppException('EXT-001', 'Email provider failed', undefined, { cause: error });
    }
  }

  onModuleDestroy(): void {
    this.smtp?.close();
  }

  private smtpTransport(): Transporter {
    const { host, port, secure, requireTLS, auth } = this.config.mail;
    this.smtp ??= nodemailer.createTransport({ host, port, secure, requireTLS, ...(auth ? { auth } : {}) });
    return this.smtp;
  }

  private async sendWithResend(from: string, to: string, mail: RenderedMail, signal?: AbortSignal): Promise<void> {
    const response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.mail.resendApiKey ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: mail.subject, html: mail.html, text: mail.text }),
      ...(signal ? { signal } : {}),
    });
    // The response body may echo the address; only the status goes into the error.
    if (!response.ok) throw new AppException('EXT-001', `Email provider answered ${response.status}`);
  }
}
