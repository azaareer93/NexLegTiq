import { Injectable } from '@nestjs/common';
import { formatMoney, roundMoney } from '@nexlegtiq/shared-utils';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { receiptHtml } from './receipt-pdf.html';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { MailTransport } from '../../common/mail/mail-transport';
import { renderMail } from '../../common/mail/templates';
import { StorageService } from '../../common/storage/storage.service';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { PlatformPayment } from '../../generated/prisma/client';
import { printPdf } from '../invoices/pdf/chromium';
import type { PdfLanguage } from '../invoices/pdf/invoice-pdf.html';

export const RENDER_PAYMENT_RECEIPT_JOB = 'render-payment-receipt';
export const ReceiptJobSchema = z.object({
  paymentId: z.uuid(),
  language: z.enum(['AR', 'EN']),
  /** Email the receipt to the office (recording a payment, D-174). */
  email: z.boolean().default(false),
});
export type ReceiptJob = z.infer<typeof ReceiptJobSchema>;

/** The stored receipt shows the payment as it is now (voided or not), in that language. */
export const receiptIsCurrent = (
  row: Pick<PlatformPayment, 'pdfStorageKey' | 'pdfLanguage' | 'pdfRenderedFor' | 'updatedAt'>,
  language: PdfLanguage,
) =>
  Boolean(row.pdfStorageKey) &&
  row.pdfLanguage === language &&
  row.pdfRenderedFor?.getTime() === row.updatedAt.getTime();

/**
 * `report/render-payment-receipt` (MVP-170, D-174), run in the paying office: prints the receipt, stores it under
 * `{officeId}/receipts/{id}/…` and records it on the payment without changing `updatedAt` (compare-and-swap, as
 * invoice PDFs, D-171). With `email`, the PDF then goes to the office's address — last, so a retry re-sends only when
 * the send itself failed; a payment voided meanwhile is not mailed.
 */
@Injectable()
export class ReceiptPdfRenderer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly mail: MailTransport,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReceiptPdfRenderer.name);
  }

  async run(job: ReceiptJob, jobId: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    const row = await this.prisma.db.platformPayment.findFirst({ where: { id: job.paymentId } });
    if (!row) return { skipped: 'NOT_FOUND' };
    const office = await this.prisma.db.office.findFirstOrThrow({
      select: { name: true, address: true, email: true },
    });
    let pdf: Buffer | null = null;
    const current = receiptIsCurrent(row, job.language) ? row.pdfStorageKey : null;
    if (!current) {
      pdf = await printPdf(
        this.config.chromiumPath,
        receiptHtml({
          language: job.language,
          receiptNumber: row.receiptNumber,
          paidAt: row.paidAt.toISOString().slice(0, 10),
          amount: roundMoney(row.amount.toFixed(), row.currency),
          currency: row.currency,
          method: row.method,
          reference: row.reference,
          voided: row.voidedAt !== null,
          issuer: this.config.receiptIssuer,
          office,
        }),
        signal,
      );
      await this.store(row, job.language, pdf);
    }
    if (!job.email) return { rendered: pdf !== null };
    if (row.voidedAt || !office.email) {
      this.logger.warn({ paymentId: row.id }, 'Receipt not emailed');
      return { rendered: pdf !== null, emailed: false };
    }
    const locale = job.language === 'AR' ? 'ar' : 'en';
    const mail = renderMail(
      'payment-receipt',
      job.language,
      {
        issuerName: this.config.receiptIssuer.name,
        officeName: office.name,
        receiptNumber: row.receiptNumber,
        amount: formatMoney(roundMoney(row.amount.toFixed(), row.currency), row.currency, {
          locale,
        }),
      },
      this.config.mail.officeAppUrl,
    );
    await this.mail.send(office.email, mail, {
      signal,
      idempotencyKey: `receipt-email-${jobId}`,
      attachments: [
        {
          filename: `${row.receiptNumber}.pdf`,
          content: pdf ?? (await this.read(current ?? '')),
          contentType: 'application/pdf',
        },
      ],
    });
    this.logger.info({ paymentId: row.id }, 'Receipt emailed to the office');
    return { rendered: pdf !== null, emailed: true };
  }

  private async store(row: PlatformPayment, language: PdfLanguage, pdf: Buffer): Promise<void> {
    const key = this.storage.keyFor('receipts', row.id, `${uuidV7()}.pdf`);
    await this.storage.put(key, pdf, { contentType: 'application/pdf', contentLength: pdf.length });
    const { count } = await this.prisma.db.platformPayment.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt, pdfStorageKey: row.pdfStorageKey },
      data: {
        pdfStorageKey: key,
        pdfLanguage: language,
        pdfRenderedFor: row.updatedAt,
        updatedAt: row.updatedAt,
      },
    });
    const stale = count === 0 ? key : row.pdfStorageKey;
    if (stale)
      await this.storage
        .delete(stale)
        .catch((err: unknown) => this.logger.warn({ err }, 'Old receipt PDF kept'));
    if (count === 0) throw new Error('Payment changed while its receipt was printed');
  }

  private async read(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.storage.getStream(key)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
}
