import { Injectable } from '@nestjs/common';
import type { InvoicePdf } from '@nexlegtiq/shared-contracts';

import type { PdfLanguage } from './invoice-pdf.html';
import { pdfIsCurrent, RENDER_INVOICE_PDF_JOB } from './invoice-pdf.renderer';
import type { InvoicePdfJob } from './invoice-pdf.renderer';
import { AuditService } from '../../../common/audit/audit.service';
import { ResourceNotFoundException } from '../../../common/errors/app.exception';
import { QueueProducer } from '../../../common/queue/queue-producer';
import { QUEUE } from '../../../common/queue/queues';
import { StorageService } from '../../../common/storage/storage.service';
import { PrismaService } from '../../../database/prisma.service';
import type { ScopedTransaction } from '../../../database/unit-of-work';
import { InvoiceAccess } from '../invoice-access';

const LINK_TTL_SECONDS = 300;

/** The office's language for documents it sends: a bilingual office writes in Arabic unless asked otherwise. */
export async function officePdfLanguage(
  db: Pick<ScopedTransaction, 'office'>,
): Promise<PdfLanguage> {
  const { defaultLanguage } = await db.office.findFirstOrThrow({
    select: { defaultLanguage: true },
  });
  return defaultLanguage === 'EN' ? 'EN' : 'AR';
}

/** Queues a render; one per invoice state, language and minute (a failed render can be asked for again a minute later). */
export function enqueuePdf(
  queues: QueueProducer,
  job: InvoicePdfJob,
  updatedAt: Date,
  suffix = '',
): Promise<unknown> {
  const minute = Math.floor(Date.now() / 60_000);
  return queues.enqueue(QUEUE.REPORT, RENDER_INVOICE_PDF_JOB, job, {
    jobId: `invoice-pdf-${job.invoiceId}-${job.language}-${updatedAt.getTime()}-${minute}${suffix}`,
  });
}

/** `GET /invoices/:id/pdf` (MVP-92, D-171): a link to the PDF of the invoice as it is now, or a render queued. */
@Injectable()
export class InvoicePdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: InvoiceAccess,
    private readonly storage: StorageService,
    private readonly queues: QueueProducer,
    private readonly audit: AuditService,
  ) {}

  async link(id: string, language?: PdfLanguage): Promise<InvoicePdf> {
    const row = await this.prisma.db.invoice.findFirst({
      where: { AND: [{ id }, this.access.visibleWhere()] },
      select: {
        id: true,
        invoiceNumber: true,
        updatedAt: true,
        pdfStorageKey: true,
        pdfLanguage: true,
        pdfRenderedFor: true,
      },
    });
    if (!row) throw new ResourceNotFoundException();
    const lang = language ?? (await officePdfLanguage(this.prisma.db));
    if (!pdfIsCurrent(row, lang) || !row.pdfStorageKey) {
      await enqueuePdf(this.queues, { invoiceId: id, language: lang, email: false }, row.updatedAt);
      return { status: 'RENDERING' };
    }
    const downloadUrl = await this.storage.presignedGetUrl(row.pdfStorageKey, {
      expiresIn: LINK_TTL_SECONDS,
      filename: `${row.invoiceNumber ?? 'invoice-draft'}.pdf`,
      contentType: 'application/pdf',
    });
    await this.audit.log(this.prisma.db, {
      entityType: 'Invoice',
      entityId: id,
      action: 'DOWNLOAD',
      newValues: { language: lang },
    });
    return { status: 'READY', downloadUrl, expiresIn: LINK_TTL_SECONDS };
  }
}
