import { Injectable } from '@nestjs/common';
import type {
  CreateTimeEntryRequest,
  TimeEntry,
  TimeEntryQuery,
  TimeTotals,
  UpdateTimeEntryRequest,
} from '@nexlegtiq/shared-contracts';
import { roundMoney, wallClock } from '@nexlegtiq/shared-utils';
import { ClsService } from 'nestjs-cls';

import { AuditService } from '../../common/audit/audit.service';
import { changes } from '../../common/audit/changes';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';
import { lockFile } from '../file-participants/file-lock';
import { CaseAccessService } from '../legal-files/case-access.service';
import { toDbDate } from '../tasks/tasks.repository';

export const FILE = { select: { id: true, fileNumber: true, title: true } } as const;
const ENTRY = {
  id: true,
  fileId: true,
  userId: true,
  workDate: true,
  durationHours: true,
  description: true,
  isBillable: true,
  hourlyRate: true,
  currency: true,
  invoiceId: true,
  createdAt: true,
  updatedAt: true,
  file: FILE,
  user: { select: { id: true, fullName: true } },
} as const;
type EntryRow = Prisma.TimeEntryGetPayload<{ select: typeof ENTRY }>;

export const day = (value: Date) => value.toISOString().slice(0, 10);

/** Hours × rate as money: rounded once, half-even to the column's 2 digits (D-017, D-092). */
export const amountOf = (hours: Prisma.Decimal, rate: Prisma.Decimal): string =>
  roundMoney(hours.mul(rate).toString(), 2);

/** Time entries (MVP-90, D-152); the timer is TimerService. */
@Injectable()
export class TimeEntriesService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly files: CaseAccessService,
    private readonly audit: AuditService,
  ) {}

  caller() {
    const userId = this.cls.get('userId');
    const role = this.cls.get('role');
    if (!userId || !role) throw new Error('No office caller in the request context');
    const permissions = this.cls.get('permissions') ?? [];
    return {
      userId,
      // "Users edit their own entries unless OM/SL": the office manager and senior lawyers see and change everyone's.
      seesAll: role === 'OFFICE_MANAGER' || role === 'SENIOR_LAWYER',
      // Rates and amounts are billing terms (D-096).
      seesRates:
        permissions.includes('view:all:invoices') || permissions.includes('view:assigned:invoices'),
    };
  }

  private toEntry(row: EntryRow, seesRates: boolean): TimeEntry {
    const rate = seesRates ? row.hourlyRate : null;
    return {
      id: row.id,
      file: row.file,
      user: row.user,
      workDate: day(row.workDate),
      durationHours: row.durationHours.toFixed(2),
      description: row.description,
      isBillable: row.isBillable,
      hourlyRate: rate?.toFixed(2) ?? null,
      amount: rate ? amountOf(row.durationHours, rate) : null,
      currency: row.currency,
      invoiced: row.invoiceId !== null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Entries the caller may see: on files they see, their own unless they are OM/SL. */
  private visibleWhere(): Prisma.TimeEntryWhereInput {
    const { userId, seesAll } = this.caller();
    return { file: this.files.visibleWhere(), ...(seesAll ? {} : { userId }) };
  }

  async list(query: TimeEntryQuery): Promise<PaginatedResult<TimeEntry>> {
    const { seesRates } = this.caller();
    const { fileId, userId, from, to, billable, invoiced, page, limit } = query;
    const where: Prisma.TimeEntryWhereInput = {
      AND: [
        this.visibleWhere(),
        {
          ...(fileId ? { fileId } : {}),
          ...(userId ? { userId } : {}),
          ...(from || to
            ? {
                workDate: {
                  ...(from ? { gte: toDbDate(from) } : {}),
                  ...(to ? { lte: toDbDate(to) } : {}),
                },
              }
            : {}),
          ...(billable === undefined ? {} : { isBillable: billable }),
          ...(invoiced === undefined ? {} : { invoiceId: invoiced ? { not: null } : null }),
        },
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.timeEntry.findMany({
        where,
        orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: ENTRY,
      }),
      this.prisma.db.timeEntry.count({ where }),
    ]);
    return PaginatedResult.of(
      rows.map((row) => this.toEntry(row, seesRates)),
      { page, limit, total },
    );
  }

  async get(id: string): Promise<TimeEntry> {
    const row = await this.prisma.db.timeEntry.findFirst({
      where: { AND: [{ id }, this.visibleWhere()] },
      select: ENTRY,
    });
    if (!row) throw new ResourceNotFoundException();
    return this.toEntry(row, this.caller().seesRates);
  }

  /** The rate and currency an entry on `fileId` takes: the file's rate, else the office's default (D-152). */
  async terms(fileId: string) {
    const file = await this.prisma.db.legalFile.findFirstOrThrow({
      where: { id: fileId },
      select: { hourlyRate: true, currency: true },
    });
    const settings = await this.prisma.db.officeSettings.findFirst({
      select: { defaultBillingRate: true, timeIncrementMinutes: true },
    });
    return {
      hourlyRate: file.hourlyRate ?? settings?.defaultBillingRate ?? null,
      currency: file.currency,
      increment: settings?.timeIncrementMinutes ?? 6,
    };
  }

  /** Time is logged for work done: a date after today (in the office's zone) is refused. */
  private async assertNotFuture(workDate: string): Promise<void> {
    if (workDate > (await this.today())) {
      throw new ValidationException([{ field: 'workDate', message: 'validation.futureDate' }]);
    }
  }

  private async today(): Promise<string> {
    const { timezone } = await this.prisma.db.office.findFirstOrThrow({
      select: { timezone: true },
    });
    return wallClock(new Date(), timezone).date;
  }

  async create(input: CreateTimeEntryRequest): Promise<TimeEntry> {
    const { userId } = this.caller();
    await this.files.assertFileAccess(input.fileId, 'contribute');
    const { hourlyRate, currency } = await this.terms(input.fileId);
    const workDate = input.workDate ?? (await this.today());
    await this.assertNotFuture(workDate);
    const id = await this.uow.run(async (tx) => {
      await lockFile(tx, this.cls.get('officeId') as string, input.fileId);
      const row = await tx.timeEntry.create({
        data: {
          officeId: this.cls.get('officeId') as string,
          fileId: input.fileId,
          userId,
          workDate: toDbDate(workDate),
          durationHours: input.durationHours,
          description: input.description,
          isBillable: input.isBillable ?? true,
          hourlyRate,
          currency,
        },
        select: { id: true },
      });
      await this.audit.log(tx, {
        entityType: 'TimeEntry',
        entityId: row.id,
        action: 'CREATE',
        newValues: {
          hourlyRate: hourlyRate?.toFixed(2) ?? null,
          currency,
          fileId: input.fileId,
          workDate,
          durationHours: input.durationHours,
          isBillable: input.isBillable ?? true,
        },
      });
      return row.id;
    });
    return this.get(id);
  }

  /** The entry for a change: visible to the caller (their own unless OM/SL), its file open to work, not invoiced. */
  private async changeable(tx: ScopedTransaction, id: string) {
    // Locked first, so two changes of one entry (or an invoice claiming it) queue and see each other.
    await tx.$queryRaw`SELECT 1 FROM time_entries WHERE id = ${id}::uuid AND office_id = ${this.cls.get('officeId')}::uuid FOR UPDATE`;
    const row = await tx.timeEntry.findFirst({
      where: { AND: [{ id }, this.visibleWhere()] },
      select: ENTRY,
    });
    if (!row) throw new ResourceNotFoundException();
    await this.files.assertFileAccess(row.fileId, 'contribute');
    await lockFile(tx, this.cls.get('officeId') as string, row.fileId);
    if (row.invoiceId) {
      throw new BusinessRuleException('BIZ-006', 'The time entry is invoiced and cannot change');
    }
    return row;
  }

  async update(id: string, input: UpdateTimeEntryRequest): Promise<TimeEntry> {
    if (Object.values(input).every((value) => value === undefined)) {
      throw new ValidationException([{ field: 'body', message: 'validation.required' }]);
    }
    if (input.workDate) await this.assertNotFuture(input.workDate);
    await this.uow.run(async (tx) => {
      const row = await this.changeable(tx, id);
      const before = { ...row, workDate: day(row.workDate) };
      const { old, next } = changes(before, input);
      if (Object.keys(next).length === 0) return;
      await tx.timeEntry.update({
        where: { id },
        data: {
          ...input,
          ...(input.workDate ? { workDate: toDbDate(input.workDate) } : {}),
        },
      });
      await this.audit.log(tx, {
        entityType: 'TimeEntry',
        entityId: id,
        action: 'UPDATE',
        oldValues: old,
        newValues: next,
      });
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.uow.run(async (tx) => {
      const row = await this.changeable(tx, id);
      await tx.timeEntry.delete({ where: { id } });
      await this.audit.log(tx, {
        entityType: 'TimeEntry',
        entityId: id,
        action: 'DELETE',
        oldValues: {
          fileId: row.fileId,
          workDate: day(row.workDate),
          durationHours: row.durationHours.toFixed(2),
        },
      });
    });
  }

  /** A file's billable, non-billable and unbilled hours; amounts only for readers with invoice rights. */
  async totals(fileId: string): Promise<TimeTotals> {
    await this.files.assertFileAccess(fileId, 'read');
    const { seesRates } = this.caller();
    const [file, rows] = await Promise.all([
      this.prisma.db.legalFile.findFirstOrThrow({
        where: { id: fileId },
        select: { currency: true },
      }),
      // shortcut: sums in the app over every entry of the file; move to SQL if a file ever holds tens of thousands.
      this.prisma.db.timeEntry.findMany({
        where: { fileId },
        select: { durationHours: true, hourlyRate: true, isBillable: true, invoiceId: true },
      }),
    ]);
    const zero = new Prisma.Decimal(0);
    const sum = (list: typeof rows, value: (row: (typeof rows)[number]) => Prisma.Decimal) =>
      list.reduce((total, row) => total.add(value(row)), zero);
    const billable = rows.filter((row) => row.isBillable);
    const unbilled = billable.filter((row) => row.invoiceId === null);
    // The sum of the amounts each entry shows, so the rows add up to the total.
    const amount = (row: (typeof rows)[number]) =>
      row.hourlyRate ? new Prisma.Decimal(amountOf(row.durationHours, row.hourlyRate)) : zero;
    return {
      currency: file.currency,
      billableHours: sum(billable, (row) => row.durationHours).toFixed(2),
      nonBillableHours: sum(
        rows.filter((row) => !row.isBillable),
        (row) => row.durationHours,
      ).toFixed(2),
      unbilledHours: sum(unbilled, (row) => row.durationHours).toFixed(2),
      billableAmount: seesRates ? sum(billable, amount).toFixed(2) : null,
      unbilledAmount: seesRates ? sum(unbilled, amount).toFixed(2) : null,
    };
  }
}
