import { Injectable } from '@nestjs/common';
import type {
  Invoice,
  MarkInvoicePaidRequest,
  UpdateInvoiceRequest,
} from '@nexlegtiq/shared-contracts';
import { roundMoney, wallClock } from '@nexlegtiq/shared-utils';

import { InvoiceAccess } from './invoice-access';
import { buildLines, invoiceTotals } from './invoice-math';
import { InvoiceNumberService } from './invoice-number.service';
import { day, plusDays } from './invoice-presenter';
import { InvoicesService } from './invoices.service';
import { AuditService } from '../../common/audit/audit.service';
import { ValidationException } from '../../common/errors/app.exception';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { toDbDate } from '../tasks/tasks.repository';
import { TimelineService } from '../timeline/timeline.service';

const PAYMENT_TERM_DAYS = 30;

type Locked = Awaited<ReturnType<InvoiceAccess['locked']>>;

/** Edit, send, pay, void and delete (MVP-91, D-162). Every change locks the invoice row and audits itself. */
@Injectable()
export class InvoiceLifecycle {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly access: InvoiceAccess,
    private readonly invoices: InvoicesService,
    private readonly numbers: InvoiceNumberService,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
  ) {}

  /** A draft's notes, due date, tax inclusion and extra items; time lines stay (delete and re-draft to re-pull entries). */
  async update(id: string, input: UpdateInvoiceRequest): Promise<Invoice> {
    await this.uow.run(async (tx) => {
      const row = await this.access.locked(tx, id, ['DRAFT']);
      const oldExtras = row.lines.filter((line) => line.timeEntryId === null).length;
      const totals = await this.replaceExtras(tx, row, input);
      await tx.invoice.update({
        where: { id },
        data: {
          ...totals,
          ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
          ...(input.dueDate ? { dueDate: toDbDate(input.dueDate) } : {}),
        },
      });
      await this.audit.log(tx, {
        entityType: 'Invoice',
        entityId: id,
        action: 'UPDATE',
        oldValues: {
          total: roundMoney(row.total.toFixed(), row.currency),
          taxRatePercent: row.taxRatePercent.toFixed(2),
          dueDate: row.dueDate ? day(row.dueDate) : null,
          extraLines: oldExtras,
        },
        newValues: {
          ...totals,
          dueDate: input.dueDate ?? (row.dueDate ? day(row.dueDate) : null),
          notesChanged: input.notes !== undefined,
          extraLines: input.extraLines?.length ?? oldExtras,
        },
      });
    });
    return this.invoices.get(id);
  }

  /** Applies new extra items (when sent) and returns the draft's recomputed totals. */
  private async replaceExtras(tx: ScopedTransaction, row: Locked, input: UpdateInvoiceRequest) {
    const { officeId } = this.access.caller();
    const timeAmounts = row.lines
      .filter((l) => l.timeEntryId !== null)
      .map((l) => l.amount.toFixed());
    let amounts = [
      ...timeAmounts,
      ...row.lines.filter((l) => l.timeEntryId === null).map((l) => l.amount.toFixed()),
    ];
    if (input.extraLines) {
      const extras = buildLines([], input.extraLines, row.currency);
      await tx.invoiceLineItem.deleteMany({ where: { invoiceId: row.id, timeEntryId: null } });
      await tx.invoiceLineItem.createMany({
        data: extras.map((line, index) => ({
          officeId,
          invoiceId: row.id,
          position: timeAmounts.length + index,
          ...line,
        })),
      });
      amounts = [...timeAmounts, ...extras.map((line) => line.amount)];
    }
    let rate = row.taxRatePercent.toFixed(2);
    if (input.includeTax) {
      const settings = await tx.officeSettings.findFirstOrThrow({
        select: { taxRatePercent: true },
      });
      rate = settings.taxRatePercent.toFixed(2);
    }
    return invoiceTotals(amounts, rate, input.includeTax ?? row.taxRatePercent.gt(0), row.currency);
  }

  /** Numbers the draft (gap-free per office and year of the send date) and fixes its issue and due dates. */
  async send(id: string): Promise<Invoice> {
    await this.uow.run(async (tx) => {
      const row = await this.access.locked(tx, id, ['DRAFT']);
      const { timezone } = await tx.office.findFirstOrThrow({ select: { timezone: true } });
      const today = wallClock(new Date(), timezone).date;
      const dueDate = row.dueDate ? day(row.dueDate) : plusDays(today, PAYMENT_TERM_DAYS);
      if (dueDate < today) {
        throw new ValidationException([{ field: 'dueDate', message: 'validation.dateRange' }]);
      }
      const number = await this.numbers.next(tx, Number(today.slice(0, 4)));
      await tx.invoice.update({
        where: { id },
        data: {
          status: 'SENT',
          invoiceNumber: number,
          issueDate: toDbDate(today),
          dueDate: toDbDate(dueDate),
          sentAt: new Date(),
        },
      });
      await this.recordOnFiles(tx, row, 'INVOICE_SENT', number);
      await this.audit.log(tx, {
        entityType: 'Invoice',
        entityId: id,
        action: 'UPDATE',
        oldValues: { status: 'DRAFT' },
        newValues: { status: 'SENT', invoiceNumber: number, issueDate: today, dueDate },
      });
    });
    return this.invoices.get(id);
  }

  async markPaid(id: string, input: MarkInvoicePaidRequest): Promise<Invoice> {
    await this.uow.run(async (tx) => {
      const row = await this.access.locked(tx, id, ['SENT', 'OVERDUE']);
      await this.assertPaymentDate(tx, row, input.paidAt);
      await tx.invoice.update({
        where: { id },
        data: {
          status: 'PAID',
          paidAt: new Date(input.paidAt),
          paymentMethod: input.method,
          paymentReference: input.reference ?? null,
        },
      });
      await this.recordOnFiles(tx, row, 'INVOICE_PAID', row.invoiceNumber ?? '');
      await this.audit.log(tx, {
        entityType: 'Invoice',
        entityId: id,
        action: 'UPDATE',
        oldValues: { status: row.status },
        newValues: { status: 'PAID', paidAt: input.paidAt, paymentMethod: input.method },
      });
    });
    return this.invoices.get(id);
  }

  /** The payment date (office time zone) is neither in the future nor before the issue date. */
  private async assertPaymentDate(tx: ScopedTransaction, row: Locked, paidAt: string) {
    const { timezone } = await tx.office.findFirstOrThrow({ select: { timezone: true } });
    const paidOn = wallClock(new Date(paidAt), timezone).date;
    if (paidOn > wallClock(new Date(), timezone).date) {
      throw new ValidationException([{ field: 'paidAt', message: 'validation.futureDate' }]);
    }
    if (row.issueDate && paidOn < day(row.issueDate)) {
      throw new ValidationException([{ field: 'paidAt', message: 'validation.dateRange' }]);
    }
  }

  /** Voiding frees the billed entries; the invoice keeps its number and lines as history. */
  async void(id: string): Promise<Invoice> {
    await this.uow.run(async (tx) => {
      const row = await this.access.locked(tx, id, ['SENT', 'OVERDUE']);
      await tx.invoice.update({ where: { id }, data: { status: 'VOID' } });
      const freed = await tx.timeEntry.updateMany({
        where: { invoiceId: id },
        data: { invoiceId: null },
      });
      await this.audit.log(tx, {
        entityType: 'Invoice',
        entityId: id,
        action: 'UPDATE',
        oldValues: { status: row.status },
        newValues: { status: 'VOID', entriesFreed: freed.count },
      });
    });
    return this.invoices.get(id);
  }

  /** Only a draft can be deleted (it has no number); its entries are freed. */
  async remove(id: string): Promise<void> {
    await this.uow.run(async (tx) => {
      const row = await this.access.locked(tx, id, ['DRAFT']);
      await tx.timeEntry.updateMany({ where: { invoiceId: id }, data: { invoiceId: null } });
      await tx.invoice.delete({ where: { id } });
      await this.audit.log(tx, {
        entityType: 'Invoice',
        entityId: id,
        action: 'DELETE',
        oldValues: {
          total: roundMoney(row.total.toFixed(), row.currency),
          lines: row.lines.length,
        },
      });
    });
  }

  /** INVOICE_SENT / INVOICE_PAID on the invoice's file, or on every file a consolidated invoice bills (portal-visible: no staff text). */
  private async recordOnFiles(
    tx: ScopedTransaction,
    row: Locked,
    eventType: 'INVOICE_SENT' | 'INVOICE_PAID',
    invoiceNumber: string,
  ): Promise<void> {
    const fileIds = new Set([row.fileId, ...row.lines.map((line) => line.fileId)]);
    for (const fileId of fileIds) {
      if (!fileId) continue;
      await this.timeline.record(tx, {
        fileId,
        eventType,
        sourceType: 'Invoice',
        sourceId: row.id,
        payload: { invoiceNumber },
      });
    }
  }
}
