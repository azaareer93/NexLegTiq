import { Injectable } from '@nestjs/common';
import type {
  AuditEntry,
  AuditExportQuery,
  AuditPage,
  AuditQuery,
} from '@nexlegtiq/shared-contracts';
import { zonedDateTime } from '@nexlegtiq/shared-utils';

import { auditCsv } from './audit-csv';
import { fileEntityIds, fileRowsWhere } from './file-rows';
import { AuditService } from '../../common/audit/audit.service';
import type { AuditClient } from '../../common/audit/audit.service';
import { BusinessRuleException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import { addDays } from '../dashboard/dashboard.service';
import { CaseAccessService } from '../legal-files/case-access.service';

/** Rows one export may hold (D-180); more → 422 BIZ-025, narrow the filters. */
export const EXPORT_MAX_ROWS = 10_000;

const ROW_SELECT = {
  id: true,
  occurredAt: true,
  userId: true,
  platformAdminId: true,
  clientUserId: true,
  action: true,
  entityType: true,
  entityId: true,
  oldValues: true,
  newValues: true,
  user: { select: { fullName: true } },
} as const;
type Row = Prisma.AuditLogGetPayload<{ select: typeof ROW_SELECT }>;
type Filters = Omit<AuditQuery, 'cursor' | 'limit'>;

const NEWEST: Prisma.AuditLogOrderByWithRelationInput[] = [{ occurredAt: 'desc' }, { id: 'desc' }];

/**
 * The office's audit log, read (MVP-105, D-180): the office list and export for `view:audit`, and a file's own rows for
 * those who may also read the file. Rows are never changed here; an export is itself audited.
 */
@Injectable()
export class AuditLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
    private readonly audit: AuditService,
    private readonly uow: UnitOfWork,
  ) {}

  async list(query: AuditQuery, fileId?: string): Promise<AuditPage> {
    if (fileId) await this.files.assertFileAccess(fileId, 'read');
    const rows = await this.prisma.db.auditLog.findMany({
      where: await this.where(query, fileId),
      orderBy: NEWEST,
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: ROW_SELECT,
    });
    const page = rows.slice(0, query.limit);
    return {
      items: page.map(toEntry),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** The filtered rows as CSV; the export is recorded with its filters and row count (never the rows). */
  async exportCsv(query: AuditExportQuery, client: AuditClient): Promise<string> {
    const { format, ...filters } = query;
    const zone = await this.timeZone();
    const rows = await this.prisma.db.auditLog.findMany({
      where: await this.where(filters, undefined, zone),
      orderBy: NEWEST,
      take: EXPORT_MAX_ROWS + 1,
      select: ROW_SELECT,
    });
    if (rows.length > EXPORT_MAX_ROWS) {
      throw new BusinessRuleException('BIZ-025', 'Too many audit rows for one export');
    }
    await this.uow.run((tx) =>
      this.audit.log(
        tx,
        {
          entityType: 'AuditLog',
          entityId: null,
          action: 'EXPORT',
          newValues: { format, filters, rows: rows.length },
        },
        client,
      ),
    );
    return auditCsv(rows.map(toEntry), zone);
  }

  private async where(
    filters: Filters,
    fileId?: string,
    zone?: string,
  ): Promise<Prisma.AuditLogWhereInput> {
    const { entityType, entityId, userId, action, from, to } = filters;
    const hidden = await this.hiddenFiles();
    return {
      AND: [
        {
          ...(entityType ? { entityType } : {}),
          ...(entityId ? { entityId } : {}),
          ...(userId ? { userId } : {}),
          ...(action ? { action } : {}),
          ...(from || to
            ? { occurredAt: dayRange(from, to, zone ?? (await this.timeZone())) }
            : {}),
        },
        ...(fileId ? [await fileRowsWhere(this.prisma.db, fileId)] : []),
        // Never the rows of a file the caller may not see (D-096: an Admin is not on confidential files), by id.
        // shortcut: a row naming a hidden file only in its values (a client or team link) is not caught.
        ...(hidden.length
          ? [
              {
                OR: [
                  { entityId: null },
                  { entityId: { notIn: await fileEntityIds(this.prisma.db, hidden) } },
                ],
              },
            ]
          : []),
      ],
    };
  }

  /**
   * Confidential files the caller may not see, deleted ones included (D-096). Audit readers see every file in scope
   * (`view:all:cases`), so only confidentiality can hide one. Two reads and a difference: `NOT (…)` over nullable
   * columns would drop rows (SQL NULL logic).
   */
  private async hiddenFiles(): Promise<string[]> {
    const { deletedAt: _live, ...visible } = this.files.visibleWhere();
    const select = { id: true } as const;
    const [all, seen] = await Promise.all([
      this.prisma.db.legalFile.findMany({ where: { isConfidential: true }, select }),
      this.prisma.db.legalFile.findMany({
        where: { AND: [{ isConfidential: true }, visible] },
        select,
      }),
    ]);
    const shown = new Set(seen.map((row) => row.id));
    return all.flatMap((row) => (shown.has(row.id) ? [] : [row.id]));
  }

  private async timeZone(): Promise<string> {
    const { timezone } = await this.prisma.db.office.findFirstOrThrow({
      select: { timezone: true },
    });
    return timezone;
  }
}

/** Office calendar days `from`..`to`, both included: from the start of `from` to the start of the day after `to`. */
function dayRange(from: string | undefined, to: string | undefined, zone: string) {
  return {
    ...(from ? { gte: new Date(zonedDateTime(from, '00:00', zone)) } : {}),
    ...(to ? { lt: new Date(zonedDateTime(addDays(to, 1), '00:00', zone)) } : {}),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A row in the contract's shape: the actor, and each field written with its old and new value. */
export function toEntry(row: Row): AuditEntry {
  const before = isRecord(row.oldValues) ? row.oldValues : {};
  const after = isRecord(row.newValues) ? row.newValues : {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actor: actorOf(row),
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    changes: fields.map((field) => ({
      field,
      old: before[field] ?? null,
      new: after[field] ?? null,
    })),
  };
}

function actorOf(row: Row): AuditEntry['actor'] {
  if (row.userId) return { type: 'USER', id: row.userId, name: row.user?.fullName ?? null };
  // Platform staff and portal clients are named in the app, not by their accounts (D-158).
  if (row.platformAdminId) return { type: 'PLATFORM_ADMIN', id: null, name: null };
  if (row.clientUserId) return { type: 'CLIENT', id: row.clientUserId, name: null };
  return { type: 'SYSTEM', id: null, name: null };
}
