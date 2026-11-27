import { Injectable } from '@nestjs/common';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { PinoLogger } from 'nestjs-pino';

import { auditRow } from '../../common/audit/audit.service';
import { StorageService } from '../../common/storage/storage.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

export const PURGE_OFFICES_JOB = 'purge-offices';
/** Daily at 02:30 UTC, before the audit retention purge (03:00) ages out what this keeps. */
export const PURGE_OFFICES_SCHEDULE = { pattern: '30 2 * * *', tz: 'UTC' } as const;

const DAYS_PER_YEAR = 365;
/** A large office's purge is one transaction; allow it time (the default is 5 s). */
const PURGE_TX_TIMEOUT_MS = 10 * 60_000;

type Tx = Prisma.TransactionClient;

/**
 * The final purge of offices past their deletion date (MVP-152, D-251), run daily by the report queue. Per office: its
 * storage objects, then one transaction that keeps its issued invoices as issued, runs `nlq_purge_office` (anonymized
 * audit, every other office row deleted) and strips the office row to the accounting record. An office that fails is
 * logged and tried again the next day; the others go on. Also deletes retained invoices whose retention ended.
 */
@Injectable()
export class OfficePurge {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantRunner,
    private readonly storage: StorageService,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OfficePurge.name);
  }

  async run(now = new Date()): Promise<{ readonly purged: number; readonly expired: number }> {
    // unscoped: the purge spans every office due; each one's work is limited to its own id.
    const raw = this.prisma.unscoped();
    const due = await raw.office.findMany({
      where: { purgedAt: null, deletionScheduledFor: { lte: now } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let purged = 0;
    for (const { id } of due) {
      try {
        await this.purge(id);
        purged += 1;
      } catch (error) {
        this.logger.error({ err: error, officeId: id }, 'Office purge failed; retried tomorrow');
      }
    }
    const { count: expired } = await raw.retainedInvoice.deleteMany({
      where: { retainUntil: { lte: now } },
    });
    this.logger.info({ purged, expired }, 'Office purge applied');
    return { purged, expired };
  }

  /** One office. Storage first: a failure there leaves every row, so the next run starts again from the top. */
  async purge(officeId: string): Promise<void> {
    const storageObjects = await this.tenant.run({ officeId: officeId as OfficeId }, () =>
      this.storage.deleteOfficeObjects(),
    );
    const years = this.config.retainedRecordsYears;
    const retainUntil = new Date();
    retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + years);
    // unscoped: the purge works on one office by id, including tables the tenant extension does not cover.
    await this.prisma.unscoped().$transaction(
      async (tx) => {
        const invoicesRetained = await this.retainInvoices(tx, officeId, retainUntil);
        const [row] = await tx.$queryRaw<{ removed: number }[]>`
          SELECT nlq_purge_office(${officeId}::uuid) AS removed`;
        await tx.office.update({
          where: { id: officeId },
          data: {
            phone: null,
            email: null,
            address: null,
            website: null,
            isActive: false,
            purgedAt: new Date(),
          },
        });
        // The anonymized audit rows age out with the invoices (the D-136 purge reads the highest retention ever set).
        await tx.officeSettings.updateMany({
          where: { officeId },
          data: { auditRetentionDays: years * DAYS_PER_YEAR },
        });
        await tx.auditLog.create({
          data: auditRow(
            {
              officeId,
              userId: null,
              entityType: 'Office',
              entityId: officeId,
              action: 'DELETE',
              newValues: {
                deletion: 'PURGED',
                rows: row?.removed ?? 0,
                storageObjects,
                invoicesRetained,
              },
            },
            {},
          ),
        });
      },
      { timeout: PURGE_TX_TIMEOUT_MS },
    );
    this.logger.info({ officeId, storageObjects }, 'Office purged');
  }

  /** Issued invoices (those with a number) as issued, voided ones included: the legal record (D-251). */
  private async retainInvoices(tx: Tx, officeId: string, retainUntil: Date): Promise<number> {
    const office = await tx.office.findUniqueOrThrow({
      where: { id: officeId },
      select: { name: true, taxId: true, registrationNumber: true },
    });
    const invoices = await tx.invoice.findMany({
      where: { officeId, invoiceNumber: { not: null } },
      include: {
        client: { select: { displayName: true } },
        lines: { orderBy: { position: 'asc' } },
      },
    });
    const rows = invoices.map((invoice) => ({
      officeId,
      invoiceNumber: invoice.invoiceNumber ?? '',
      retainUntil,
      snapshot: {
        office,
        client: invoice.client.displayName,
        invoiceNumber: invoice.invoiceNumber,
        status: invoice.status,
        currency: invoice.currency,
        issueDate: invoice.issueDate?.toISOString().slice(0, 10) ?? null,
        dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null,
        subtotal: invoice.subtotal.toString(),
        taxRatePercent: invoice.taxRatePercent.toString(),
        taxAmount: invoice.taxAmount.toString(),
        total: invoice.total.toString(),
        sentAt: invoice.sentAt?.toISOString() ?? null,
        paidAt: invoice.paidAt?.toISOString() ?? null,
        paymentMethod: invoice.paymentMethod,
        paymentReference: invoice.paymentReference,
        notes: invoice.notes,
        lines: invoice.lines.map((line) => ({
          description: line.description,
          quantity: line.quantity.toString(),
          unitPrice: line.unitPrice.toString(),
          amount: line.amount.toString(),
        })),
      },
    }));
    if (rows.length === 0) return 0;
    // A retried purge whose first transaction rolled back has none yet; skipDuplicates covers a partial manual rerun.
    const { count } = await tx.retainedInvoice.createMany({ data: rows, skipDuplicates: true });
    return count;
  }
}
