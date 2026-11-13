import { Injectable } from '@nestjs/common';
import type {
  CreateInvoiceBody,
  Invoice,
  InvoiceListItem,
  InvoiceQuery,
  InvoiceSummary,
} from '@nexlegtiq/shared-contracts';
import { roundMoney } from '@nexlegtiq/shared-utils';

import { InvoiceAccess } from './invoice-access';
import { buildLines, invoiceTotals } from './invoice-math';
import { DETAIL, LISTED, toInvoice, toListItem } from './invoice-presenter';
import { AuditService } from '../../common/audit/audit.service';
import {
  BusinessRuleException,
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import { toDbDate } from '../tasks/tasks.repository';

const invalid = (field: string, message: string) => new ValidationException([{ field, message }]);

/** Reading and drafting invoices (MVP-91, D-162); the rest of the lifecycle is `InvoiceLifecycle`. */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly access: InvoiceAccess,
    private readonly audit: AuditService,
  ) {}

  async list(query: InvoiceQuery): Promise<PaginatedResult<InvoiceListItem>> {
    const { status, clientId, fileId, from, to, sort, page, limit } = query;
    const where: Prisma.InvoiceWhereInput = {
      AND: [
        this.access.visibleWhere(),
        {
          ...(status ? { status } : {}),
          ...(clientId ? { clientId } : {}),
          ...(fileId ? { OR: [{ fileId }, { lines: { some: { fileId } } }] } : {}),
          ...(from || to
            ? {
                issueDate: {
                  ...(from ? { gte: toDbDate(from) } : {}),
                  ...(to ? { lte: toDbDate(to) } : {}),
                },
              }
            : {}),
        },
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.invoice.findMany({
        where,
        orderBy: [
          ...sort.map(({ field, direction }) => ({ [field]: direction })),
          { id: 'desc' as const },
        ],
        skip: (page - 1) * limit,
        take: limit,
        select: LISTED,
      }),
      this.prisma.db.invoice.count({ where }),
    ]);
    return PaginatedResult.of(rows.map(toListItem), { page, limit, total });
  }

  /** A client's billed and outstanding totals over the invoices the caller may see (MVP-55), per currency (D-162). */
  async summary(clientId: string): Promise<InvoiceSummary> {
    const sum = (status: Prisma.InvoiceWhereInput['status']) =>
      this.prisma.db.invoice.groupBy({
        by: ['currency'],
        where: { AND: [this.access.visibleWhere(), { clientId, status }] },
        _sum: { total: true },
        _count: { _all: true },
        orderBy: { currency: 'asc' },
      });
    const [billed, outstanding] = await Promise.all([
      sum({ in: ['SENT', 'OVERDUE', 'PAID'] }),
      sum({ in: ['SENT', 'OVERDUE'] }),
    ]);
    const totals = (rows: Awaited<ReturnType<typeof sum>>) =>
      rows.map((row) => ({
        currency: row.currency,
        amount: roundMoney(row._sum.total?.toFixed() ?? '0', row.currency),
        count: row._count._all,
      }));
    return { billed: totals(billed), outstanding: totals(outstanding) };
  }

  async get(id: string): Promise<Invoice> {
    const row = await this.prisma.db.invoice.findFirst({
      where: { AND: [{ id }, this.access.visibleWhere()] },
      select: DETAIL,
    });
    if (!row) throw new ResourceNotFoundException();
    return toInvoice(row);
  }

  async create(input: CreateInvoiceBody): Promise<Invoice> {
    const client = await this.prisma.db.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
      select: { id: true },
    });
    if (!client) throw invalid('clientId', 'validation.unknownClient');
    const candidates = await this.candidateFiles(input.clientId, input.fileId ?? null);
    const id = await this.uow.run((tx) => this.draft(tx, input, candidates));
    return this.get(id);
  }

  /** The draft, its lines and the claim on the entries, in the caller's transaction. */
  private async draft(
    tx: ScopedTransaction,
    input: CreateInvoiceBody,
    candidates: readonly { id: string; currency: string }[],
  ): Promise<string> {
    const { userId, officeId } = this.access.caller();
    const entries = await this.billableEntries(tx, officeId, candidates, input);
    // A consolidated invoice needs time to bill: extra items alone name no file, so no one could be limited by it.
    if (entries.length === 0 && (input.extraLines.length === 0 || !input.fileId)) {
      throw invalid('periodStart', 'validation.nothingToInvoice');
    }
    const currency = this.currencyOf(entries.length > 0 ? entries : candidates);
    const lines = buildLines(
      entries.map((entry) => ({
        id: entry.id,
        fileId: entry.fileId,
        description: entry.description,
        quantity: entry.durationHours.toFixed(2),
        unitPrice: (entry.hourlyRate as Prisma.Decimal).toFixed(3),
      })),
      input.extraLines,
      currency,
    );
    const settings = await tx.officeSettings.findFirstOrThrow({ select: { taxRatePercent: true } });
    const totals = invoiceTotals(
      lines.map((line) => line.amount),
      settings.taxRatePercent.toFixed(2),
      input.includeTax,
      currency,
    );
    const invoice = await tx.invoice.create({
      data: {
        officeId,
        clientId: input.clientId,
        fileId: input.fileId ?? null,
        currency,
        dueDate: input.dueDate ? toDbDate(input.dueDate) : null,
        notes: input.notes || null,
        createdById: userId,
        ...totals,
      },
      select: { id: true },
    });
    await tx.invoiceLineItem.createMany({
      data: lines.map((line, position) => ({ officeId, invoiceId: invoice.id, position, ...line })),
    });
    const claimed = await tx.timeEntry.updateMany({
      where: { id: { in: entries.map((entry) => entry.id) }, invoiceId: null },
      data: { invoiceId: invoice.id },
    });
    if (claimed.count !== entries.length) throw new ResourceConflictException('RES-003');
    await this.audit.log(tx, {
      entityType: 'Invoice',
      entityId: invoice.id,
      action: 'CREATE',
      newValues: {
        clientId: input.clientId,
        fileId: input.fileId ?? null,
        currency,
        ...totals,
        timeLines: entries.length,
        extraLines: input.extraLines.length,
      },
    });
    return invoice.id;
  }

  /** The unbilled billable entries of the period, locked so a concurrent edit or invoice queues and we read what is final. */
  private async billableEntries(
    tx: ScopedTransaction,
    officeId: string,
    candidates: readonly { id: string }[],
    input: CreateInvoiceBody,
  ) {
    const fileIds = candidates.map((file) => file.id);
    const periodStart = toDbDate(input.periodStart);
    const periodEnd = toDbDate(input.periodEnd);
    await tx.$queryRaw`SELECT id FROM time_entries WHERE office_id = ${officeId}::uuid
      AND file_id = ANY(${fileIds}::uuid[]) AND is_billable AND invoice_id IS NULL
      AND work_date BETWEEN ${periodStart} AND ${periodEnd} FOR UPDATE`;
    const entries = await tx.timeEntry.findMany({
      where: {
        fileId: { in: fileIds },
        isBillable: true,
        invoiceId: null,
        workDate: { gte: periodStart, lte: periodEnd },
      },
      orderBy: [{ workDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        fileId: true,
        description: true,
        durationHours: true,
        hourlyRate: true,
        currency: true,
      },
    });
    // Nothing is silently left unbilled: an entry without a rate must be fixed first.
    if (entries.some((entry) => entry.hourlyRate === null)) {
      throw invalid('periodStart', 'validation.missingRate');
    }
    return entries;
  }

  /** One invoice, one currency (BIZ-021); the entries' currency, else the files' when only extra items are billed. */
  private currencyOf(sources: readonly { currency: string }[]): string {
    const currencies = new Set(sources.map((source) => source.currency));
    if (currencies.size > 1) {
      throw new BusinessRuleException('BIZ-021', 'An invoice can cover one currency only');
    }
    const [currency] = currencies;
    if (!currency) {
      throw invalid('periodStart', 'validation.nothingToInvoice');
    }
    return currency;
  }

  /** The files an invoice for `clientId` draws on; a per-file request needs the file visible, open to work and the client linked. */
  private async candidateFiles(clientId: string, fileId: string | null) {
    const scope = this.access.fileScope();
    const select = { id: true, currency: true, status: true } as const;
    if (!fileId) {
      return this.prisma.db.legalFile.findMany({
        where: {
          AND: [scope],
          deletedAt: null,
          status: { in: ['OPEN', 'SUSPENDED', 'CLOSED'] },
          clients: { some: { clientId } },
        },
        select,
      });
    }
    const file = await this.prisma.db.legalFile.findFirst({
      where: { AND: [{ id: fileId }, scope], deletedAt: null },
      select,
    });
    if (!file) throw new ResourceNotFoundException();
    if (file.status === 'ARCHIVED') {
      throw new BusinessRuleException('BIZ-007', 'The file is archived and read-only');
    }
    const linked = await this.prisma.db.fileClient.count({ where: { fileId, clientId } });
    if (linked === 0) throw invalid('clientId', 'validation.clientNotOnFile');
    return [file];
  }
}
