import { Injectable } from '@nestjs/common';
import type { OfficeExport, OfficeExportDownload } from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { OFFICE_EXPORT_JOB } from './office-export.builder';
import { AuditService } from '../../common/audit/audit.service';
import type { AuditClient } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';

const EXPORT_SELECT = {
  id: true,
  status: true,
  sizeBytes: true,
  checksum: true,
  errorCode: true,
  expiresAt: true,
  createdAt: true,
  completedAt: true,
  requestedBy: { select: { id: true, fullName: true } },
} as const;
type ExportRow = Prisma.OfficeExportGetPayload<{ select: typeof EXPORT_SELECT }>;

const present = (row: ExportRow): OfficeExport => ({
  ...row,
  sizeBytes: row.sizeBytes === null ? null : row.sizeBytes.toString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  completedAt: row.completedAt?.toISOString() ?? null,
});

/** The user's own data, at most this many audit rows (their sign-ins and changes). */
const OWN_AUDIT_ROWS = 5_000;

/**
 * Data exports (MVP-106, D-184): the office's (`export:office`) as a background ZIP, downloaded through short links,
 * and a user's own data as an immediate JSON file. Every export and download is audited.
 */
@Injectable()
export class DataExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly queues: QueueProducer,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  /** Starts an export, or answers with the one already being prepared (one at a time per office). */
  async request(client: AuditClient): Promise<OfficeExport> {
    const running = await this.prisma.db.officeExport.findFirst({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      select: EXPORT_SELECT,
    });
    if (running) return present(running);
    const row = await this.uow.run(async (tx, afterCommit) => {
      const created = await tx.officeExport.create({
        data: { officeId: this.officeId(), requestedById: this.userId() },
        select: EXPORT_SELECT,
      });
      await this.audit.log(
        tx,
        {
          entityType: 'OfficeExport',
          entityId: created.id,
          action: 'EXPORT',
          newValues: { scope: 'OFFICE' },
        },
        client,
      );
      afterCommit(
        () => this.queues.enqueue(QUEUE.REPORT, OFFICE_EXPORT_JOB, { exportId: created.id }),
        'enqueue office-export',
      );
      return created;
    });
    return present(row);
  }

  /** The office's latest exports, newest first. */
  async list(): Promise<OfficeExport[]> {
    const rows = await this.prisma.db.officeExport.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
      select: EXPORT_SELECT,
    });
    return rows.map(present);
  }

  /** A 15-minute link to a ready, unexpired export (D-013); asked for each time, and audited. */
  async download(id: string, client: AuditClient): Promise<OfficeExportDownload> {
    const row = await this.prisma.db.officeExport.findFirst({
      where: { id },
      select: { status: true, storageKey: true, expiresAt: true, createdAt: true },
    });
    if (!row) throw new ResourceNotFoundException();
    if (
      row.status !== 'READY' ||
      !row.storageKey ||
      !row.expiresAt ||
      row.expiresAt <= new Date()
    ) {
      throw new BusinessRuleException('BIZ-026', 'The export is not available');
    }
    const expiresIn = 900;
    const downloadUrl = await this.storage.presignedGetUrl(row.storageKey, {
      expiresIn,
      filename: `nexlegtiq-export-${row.createdAt.toISOString().slice(0, 10)}.zip`,
      contentType: 'application/zip',
    });
    await this.uow.run((tx) =>
      this.audit.log(tx, { entityType: 'OfficeExport', entityId: id, action: 'DOWNLOAD' }, client),
    );
    return { downloadUrl, expiresIn };
  }

  /** The caller's own data (profile, their tasks, time, notes and audit rows) as one JSON document. */
  async userExport(client: AuditClient): Promise<string> {
    const db = this.prisma.db;
    const userId = this.userId();
    const [profile, tasks, timeEntries, notes, audit] = await Promise.all([
      db.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          role: true,
          uiLanguage: true,
          timezone: true,
          notificationPrefs: true,
          createdAt: true,
          lastLoginAt: true,
        },
      }),
      db.task.findMany({ where: { OR: [{ assignedToId: userId }, { createdById: userId }] } }),
      db.timeEntry.findMany({ where: { userId } }),
      db.fileNote.findMany({ where: { authorId: userId } }),
      db.auditLog.findMany({
        where: { userId },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: OWN_AUDIT_ROWS,
        omit: { userAgent: true },
      }),
    ]);
    await this.uow.run((tx) =>
      this.audit.log(
        tx,
        { entityType: 'User', entityId: userId, action: 'EXPORT', newValues: { scope: 'USER' } },
        client,
      ),
    );
    return JSON.stringify(
      {
        format: 'nexlegtiq-user-export/1',
        createdAt: new Date(),
        profile,
        tasks,
        timeEntries,
        notes,
        audit,
      },
      (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
      2,
    );
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }

  private userId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No user in the request context');
    return userId;
  }
}
