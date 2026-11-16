import { Injectable } from '@nestjs/common';
import type { InvoiceStatus } from '@nexlegtiq/shared-types';

import { InvoiceAccess } from './invoice-access';
import { AuditService } from '../../common/audit/audit.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { TimelineService } from '../timeline/timeline.service';

/** The invoices a client may see on the portal: issued ones, never a draft or a voided one (D-188). */
export const PORTAL_INVOICE_STATUSES = [
  'SENT',
  'OVERDUE',
  'PAID',
] as const satisfies readonly InvoiceStatus[];
const ANY_STATUS: readonly InvoiceStatus[] = ['DRAFT', 'SENT', 'OVERDUE', 'PAID', 'VOID'];

/**
 * `POST /invoices/:id/share|unshare` (`generate:invoice`, MVP-150, D-188): whether the client sees the invoice on the portal.
 * Under the invoice's row lock; only an issued invoice is shared (BIZ-006 otherwise), withdrawing always works. A change is
 * audited, and a share is an INVOICE_SHARED event on every file the invoice bills. Setting the current value writes nothing.
 * `updatedAt` is kept: sharing does not change what the stored PDF shows (D-171), so it stays current.
 */
@Injectable()
export class InvoiceSharing {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: InvoiceAccess,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
  ) {}

  async setShared(id: string, shared: boolean): Promise<void> {
    await this.uow.run(async (tx) => {
      const row = await this.access.locked(tx, id, shared ? PORTAL_INVOICE_STATUSES : ANY_STATUS);
      const { sharedWithClient, updatedAt } = await tx.invoice.findFirstOrThrow({
        where: { id },
        select: { sharedWithClient: true, updatedAt: true },
      });
      if (sharedWithClient === shared) return;
      await tx.invoice.update({ where: { id }, data: { sharedWithClient: shared, updatedAt } });
      await this.audit.log(tx, {
        entityType: 'Invoice',
        entityId: id,
        action: 'UPDATE',
        oldValues: { sharedWithClient },
        newValues: { sharedWithClient: shared },
      });
      if (!shared) return;
      const fileIds = new Set([row.fileId, ...row.lines.map((line) => line.fileId)]);
      for (const fileId of fileIds) {
        if (!fileId) continue;
        await this.timeline.record(tx, {
          fileId,
          eventType: 'INVOICE_SHARED',
          sourceType: 'Invoice',
          sourceId: id,
          payload: { invoiceNumber: row.invoiceNumber },
        });
      }
    });
  }
}
