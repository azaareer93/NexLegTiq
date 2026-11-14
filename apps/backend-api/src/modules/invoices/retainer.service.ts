import { Injectable } from '@nestjs/common';
import type { Retainer, RetainerDepositRequest } from '@nexlegtiq/shared-contracts';
import { addMoney, currencyDigits, roundMoney, wallClock } from '@nexlegtiq/shared-utils';

import { InvoiceAccess } from './invoice-access';
import { AuditService } from '../../common/audit/audit.service';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { TimelineService } from '../timeline/timeline.service';

/** What an invoice paid from the retainer brings (D-176). */
export interface RetainerDebit {
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  readonly fileId: string | null;
  readonly currency: string;
  readonly total: string;
  readonly paidAt: string;
}

/** Significant decimals: `10.500` has one. */
const decimals = (amount: string) => amount.split('.')[1]?.replace(/0+$/, '').length ?? 0;

/**
 * A file's retainer (MVP-147, D-176): an append-only ledger of deposits and invoice payments whose sum is the file's
 * `retainerBalance`, changed only here, in the transaction that writes the entry, under the file's row lock — two
 * payments queue on it and the CHECK (balance ≥ 0) is the backstop. Visible on the files whose invoices the caller may
 * see (`InvoiceAccess.fileScope`); everything else is 404.
 */
@Injectable()
export class RetainerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly access: InvoiceAccess,
    private readonly audit: AuditService,
    private readonly timeline: TimelineService,
  ) {}

  async get(fileId: string): Promise<Retainer> {
    const file = await this.prisma.db.legalFile.findFirst({
      where: { AND: [{ id: fileId, deletedAt: null }, this.access.fileScope()] },
      select: {
        id: true,
        currency: true,
        retainerBalance: true,
        retainerEntries: {
          orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            kind: true,
            amount: true,
            paidAt: true,
            method: true,
            reference: true,
            createdAt: true,
            invoice: { select: { id: true, invoiceNumber: true } },
            createdBy: { select: { id: true, fullName: true } },
          },
        },
      },
    });
    if (!file) throw new ResourceNotFoundException();
    const money = (value: { toFixed(): string }) => roundMoney(value.toFixed(), file.currency);
    return {
      fileId: file.id,
      currency: file.currency,
      balance: money(file.retainerBalance),
      entries: file.retainerEntries.map((e) => ({
        id: e.id,
        kind: e.kind,
        amount: money(e.amount),
        paidAt: e.paidAt.toISOString(),
        method: e.method,
        reference: e.reference,
        invoice: e.invoice,
        createdBy: e.createdBy,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  async deposit(fileId: string, input: RetainerDepositRequest): Promise<Retainer> {
    await this.uow.run(async (tx) => {
      const file = await this.lockFile(tx, fileId);
      if (file.status === 'ARCHIVED')
        throw new BusinessRuleException('BIZ-007', 'The file is archived');
      if (decimals(input.amount) > currencyDigits(file.currency)) {
        throw new ValidationException([{ field: 'amount', message: 'validation.amount' }]);
      }
      await this.assertNotFuture(tx, input.paidAt);
      const amount = roundMoney(input.amount, file.currency);
      const entry = await tx.retainerEntry.create({
        data: {
          officeId: this.officeId(),
          fileId,
          kind: 'DEPOSIT',
          amount,
          currency: file.currency,
          paidAt: new Date(input.paidAt),
          method: input.method,
          reference: input.reference ?? null,
          createdById: this.userId(),
        },
        select: { id: true },
      });
      const balance = roundMoney(addMoney(file.retainerBalance, amount), file.currency);
      await tx.legalFile.update({ where: { id: fileId }, data: { retainerBalance: balance } });
      await this.timeline.record(tx, {
        fileId,
        eventType: 'RETAINER_DEPOSITED',
        sourceType: 'RetainerEntry',
        sourceId: entry.id,
        payload: { amount, currency: file.currency },
      });
      await this.audit.log(tx, {
        entityType: 'RetainerEntry',
        entityId: entry.id,
        action: 'CREATE',
        oldValues: { retainerBalance: file.retainerBalance },
        newValues: {
          fileId,
          kind: 'DEPOSIT',
          amount,
          method: input.method,
          retainerBalance: balance,
        },
      });
    });
    return this.get(fileId);
  }

  /**
   * Pays a per-file invoice in full from its file's retainer, inside the caller's transaction (mark-paid with method
   * RETAINER): 400 when the invoice has no single file or another currency, 422 BIZ-005 when the balance is short.
   */
  async payInvoice(tx: ScopedTransaction, debit: RetainerDebit): Promise<void> {
    if (!debit.fileId) {
      throw new ValidationException([{ field: 'method', message: 'validation.retainerNeedsFile' }]);
    }
    const file = await this.lockFile(tx, debit.fileId);
    if (file.currency !== debit.currency) {
      throw new ValidationException([{ field: 'method', message: 'validation.retainerCurrency' }]);
    }
    const total = roundMoney(debit.total, file.currency);
    const balance = roundMoney(addMoney(file.retainerBalance, `-${total}`), file.currency);
    if (balance.startsWith('-')) {
      throw new BusinessRuleException('BIZ-005', 'The retainer balance is not enough');
    }
    const entry = await tx.retainerEntry.create({
      data: {
        officeId: this.officeId(),
        fileId: debit.fileId,
        kind: 'INVOICE_PAYMENT',
        amount: `-${total}`,
        currency: file.currency,
        paidAt: new Date(debit.paidAt),
        method: 'RETAINER',
        invoiceId: debit.invoiceId,
        createdById: this.userId(),
      },
      select: { id: true },
    });
    await tx.legalFile.update({ where: { id: debit.fileId }, data: { retainerBalance: balance } });
    await this.audit.log(tx, {
      entityType: 'RetainerEntry',
      entityId: entry.id,
      action: 'CREATE',
      oldValues: { retainerBalance: file.retainerBalance },
      newValues: {
        fileId: debit.fileId,
        kind: 'INVOICE_PAYMENT',
        invoiceNumber: debit.invoiceNumber,
        amount: `-${total}`,
        retainerBalance: balance,
      },
    });
  }

  /** The file row, locked until the transaction ends (concurrent deposits and payments queue), if the caller sees it. */
  private async lockFile(tx: ScopedTransaction, fileId: string) {
    await tx.$queryRaw`
      SELECT 1 FROM legal_files WHERE id = ${fileId}::uuid AND office_id = ${this.officeId()}::uuid FOR UPDATE`;
    const file = await tx.legalFile.findFirst({
      where: { AND: [{ id: fileId, deletedAt: null }, this.access.fileScope()] },
      select: { status: true, currency: true, retainerBalance: true },
    });
    if (!file) throw new ResourceNotFoundException();
    return { ...file, retainerBalance: file.retainerBalance.toFixed() };
  }

  private async assertNotFuture(tx: ScopedTransaction, paidAt: string): Promise<void> {
    const { timezone } = await tx.office.findFirstOrThrow({ select: { timezone: true } });
    if (wallClock(new Date(paidAt), timezone).date > wallClock(new Date(), timezone).date) {
      throw new ValidationException([{ field: 'paidAt', message: 'validation.futureDate' }]);
    }
  }

  private officeId(): string {
    return this.access.caller().officeId;
  }

  private userId(): string {
    return this.access.caller().userId;
  }
}
