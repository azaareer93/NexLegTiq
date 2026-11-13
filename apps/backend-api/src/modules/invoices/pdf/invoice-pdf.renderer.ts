import { Injectable } from '@nestjs/common';
import { formatDate, roundMoney } from '@nexlegtiq/shared-utils';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { printPdf } from './chromium';
import { invoiceHtml } from './invoice-pdf.html';
import type { InvoicePdfData, PdfLanguage } from './invoice-pdf.html';
import { uuidV7 } from '../../../common/ids/uuid-v7';
import { MailTransport } from '../../../common/mail/mail-transport';
import { renderMail } from '../../../common/mail/templates';
import { StorageService } from '../../../common/storage/storage.service';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../database/prisma.service';
import type { Prisma } from '../../../generated/prisma/client';
import { day } from '../invoice-presenter';

export const RENDER_INVOICE_PDF_JOB = 'render-invoice-pdf';
export const InvoicePdfJobSchema = z.object({
  invoiceId: z.uuid(),
  language: z.enum(['AR', 'EN']),
  /** Email the PDF to the client's primary contact (the send action, D-171). */
  email: z.boolean().default(false),
});
export type InvoicePdfJob = z.infer<typeof InvoicePdfJobSchema>;

const RENDER_SELECT = {
  id: true,
  invoiceNumber: true,
  status: true,
  currency: true,
  issueDate: true,
  dueDate: true,
  subtotal: true,
  taxRatePercent: true,
  taxAmount: true,
  total: true,
  notes: true,
  updatedAt: true,
  pdfStorageKey: true,
  pdfLanguage: true,
  pdfRenderedFor: true,
  client: {
    select: {
      displayName: true,
      address: true,
      phone: true,
      email: true,
      contacts: { where: { isPrimary: true }, select: { email: true } },
    },
  },
  file: { select: { fileNumber: true, title: true } },
  lines: {
    orderBy: { position: 'asc' },
    select: { description: true, quantity: true, unitPrice: true, amount: true },
  },
} as const satisfies Prisma.InvoiceSelect;
type RenderRow = Prisma.InvoiceGetPayload<{ select: typeof RENDER_SELECT }>;

/** The stored PDF shows the invoice as it is now, in that language. */
export const pdfIsCurrent = (
  row: Pick<RenderRow, 'pdfStorageKey' | 'pdfLanguage' | 'pdfRenderedFor' | 'updatedAt'>,
  language: PdfLanguage,
) =>
  Boolean(row.pdfStorageKey) &&
  row.pdfLanguage === language &&
  row.pdfRenderedFor?.getTime() === row.updatedAt.getTime();

/** Where an invoice is emailed: the primary contact person's address, else the client's own. */
export const recipientOf = (client: RenderRow['client']) =>
  client.contacts[0]?.email ?? client.email ?? null;

/**
 * `report/render-invoice-pdf` (MVP-92, D-171), run in the invoice's office: prints the invoice with Chromium, stores it
 * under `{officeId}/invoices/{id}/…` and records it on the invoice without changing `updatedAt` (so "current" means
 * rendered from the invoice as it now is); an invoice changed during the print fails the attempt and the retry prints
 * the new state. With `email`, the PDF is then sent to the client — last, so a retried job re-sends only when the send
 * itself failed (Resend de-duplicates by job id; SMTP may deliver twice after a lost answer, D-085).
 */
@Injectable()
export class InvoicePdfRenderer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly mail: MailTransport,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InvoicePdfRenderer.name);
  }

  async run(
    job: InvoicePdfJob,
    jobId: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const row = await this.prisma.db.invoice.findFirst({
      where: { id: job.invoiceId },
      select: RENDER_SELECT,
    });
    if (!row) return { skipped: 'NOT_FOUND' };
    const office = await this.prisma.db.office.findFirstOrThrow({
      select: {
        name: true,
        address: true,
        phone: true,
        email: true,
        taxId: true,
        registrationNumber: true,
      },
    });
    const current = pdfIsCurrent(row, job.language) ? row.pdfStorageKey : null;
    let pdf: Buffer | null = null;
    if (!current) {
      pdf = await printPdf(
        this.config.chromiumPath,
        invoiceHtml(pdfData(row, office, job.language)),
        signal,
      );
      await this.store(row, job.language, pdf);
    }
    if (!job.email) return { rendered: pdf !== null };
    const emailed = await this.email(
      row,
      office.name,
      job.language,
      pdf ?? (await this.read(current ?? '')),
      {
        jobId,
        signal,
      },
    );
    return { rendered: true, emailed };
  }

  private async email(
    row: RenderRow,
    officeName: string,
    language: PdfLanguage,
    pdf: Buffer,
    { jobId, signal }: { jobId: string; signal: AbortSignal },
  ): Promise<boolean> {
    const to = recipientOf(row.client);
    if (!to || !row.invoiceNumber) return false;
    const mail = renderMail(
      'invoice',
      language,
      {
        officeName,
        clientName: row.client.displayName,
        invoiceNumber: row.invoiceNumber,
        dueDate: row.dueDate
          ? formatDate(day(row.dueDate), { locale: language === 'AR' ? 'ar' : 'en' })
          : '',
      },
      this.config.mail.officeAppUrl,
    );
    await this.mail.send(to, mail, {
      signal,
      idempotencyKey: `invoice-email-${jobId}`,
      attachments: [
        { filename: `${row.invoiceNumber}.pdf`, content: pdf, contentType: 'application/pdf' },
      ],
    });
    this.logger.info({ invoiceId: row.id }, 'Invoice emailed to the client');
    return true;
  }

  private async store(row: RenderRow, language: PdfLanguage, pdf: Buffer): Promise<void> {
    const key = this.storage.keyFor('invoices', row.id, `${uuidV7()}.pdf`);
    await this.storage.put(key, pdf, { contentType: 'application/pdf', contentLength: pdf.length });
    // `updatedAt` written as it was: recording the PDF is not a change of the invoice.
    const { count } = await this.prisma.db.invoice.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
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
        .catch((err: unknown) => this.logger.warn({ err }, 'Old invoice PDF kept'));
    if (count === 0) throw new Error('Invoice changed while its PDF was printed');
  }

  private async read(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.storage.getStream(key)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
}

type OfficeRow = InvoicePdfData['office'];

function pdfData(row: RenderRow, office: OfficeRow, language: PdfLanguage): InvoicePdfData {
  const money = (value: Prisma.Decimal) => roundMoney(value.toFixed(), row.currency);
  return {
    language,
    invoiceNumber: row.invoiceNumber,
    issueDate: row.issueDate ? day(row.issueDate) : null,
    dueDate: row.dueDate ? day(row.dueDate) : null,
    currency: row.currency,
    subtotal: money(row.subtotal),
    taxRatePercent: row.taxRatePercent.toFixed(2),
    taxAmount: money(row.taxAmount),
    total: money(row.total),
    notes: row.notes,
    office,
    client: {
      name: row.client.displayName,
      address: row.client.address,
      phone: row.client.phone,
      email: row.client.email,
    },
    file: row.file,
    lines: row.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity.toFixed(),
      unitPrice: money(line.unitPrice),
      amount: money(line.amount),
    })),
  };
}
