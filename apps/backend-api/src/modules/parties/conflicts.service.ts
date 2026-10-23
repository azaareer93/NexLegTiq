import { Injectable } from '@nestjs/common';
import { CONFLICT_REASONS } from '@nexlegtiq/shared-contracts';
import type { Conflict, ConflictQuery, ConflictReason } from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { auditRow } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { AppException, ResourceNotFoundException } from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { CaseAccessService } from '../legal-files/case-access.service';

const FILE = { select: { id: true, fileNumber: true, title: true } } as const;
const CONFLICT_SELECT = {
  id: true,
  reason: true,
  detectedAt: true,
  resolved: true,
  resolutionNotes: true,
  resolvedAt: true,
  fileA: FILE,
  fileB: FILE,
  party: { select: { id: true, fullName: true, companyName: true } },
} as const;
type ConflictRow = Prisma.ConflictOfInterestGetPayload<{ select: typeof CONFLICT_SELECT }>;

const isReason = (value: string): value is ConflictReason =>
  (CONFLICT_REASONS as readonly string[]).includes(value);

/**
 * Conflicts of interest (MVP-62, W9, D-135): listed to anyone who can open one of their two files, and resolved — with a
 * note — by someone who may edit one of them. A file the reader may not open is shown as `null` (only that a conflict
 * exists, as for hearing conflicts, D-116), so a confidential matter never leaks its number or title.
 */
@Injectable()
export class ConflictsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly cls: ClsService<RequestContext>,
    private readonly access: CaseAccessService,
  ) {}

  async list(query: ConflictQuery): Promise<PaginatedResult<Conflict>> {
    // Filtering by a file the reader cannot open would tell them it has conflicts: 404, as for any route on it.
    if (query.fileId) await this.access.assertFileAccess(query.fileId, 'read');
    const visible = this.access.visibleWhere();
    const where: Prisma.ConflictOfInterestWhereInput = {
      OR: [{ fileA: visible }, { fileB: visible }],
      ...(query.resolved && { resolved: query.resolved === 'true' }),
      ...(query.fileId && {
        AND: [{ OR: [{ fileIdA: query.fileId }, { fileIdB: query.fileId }] }],
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.conflictOfInterest.findMany({
        where,
        select: CONFLICT_SELECT,
        orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.db.conflictOfInterest.count({ where }),
    ]);
    return PaginatedResult.of(await this.present(rows), {
      page: query.page,
      limit: query.limit,
      total,
    });
  }

  /** Open conflicts of a party on a file: what the add-party answer carries. */
  async openFor(fileId: string, partyId: string): Promise<Conflict[]> {
    const rows = await this.prisma.db.conflictOfInterest.findMany({
      where: { partyId, resolved: false, OR: [{ fileIdA: fileId }, { fileIdB: fileId }] },
      select: CONFLICT_SELECT,
      orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
    });
    return this.present(rows);
  }

  /** Records why the office may proceed. Resolving again is refused (422 BIZ-017), so the first note stays. */
  async resolve(id: string, notes: string, client: ClientInfo): Promise<Conflict> {
    const conflict = await this.prisma.db.conflictOfInterest.findFirst({
      where: { id },
      select: { fileIdA: true, fileIdB: true },
    });
    if (!conflict) throw new ResourceNotFoundException();
    await this.assertEditable(conflict.fileIdA, conflict.fileIdB);
    const userId = this.actorId();
    await this.uow.run(async (tx) => {
      const now = new Date();
      const done = await tx.conflictOfInterest.updateMany({
        where: { id, resolved: false },
        data: { resolved: true, resolutionNotes: notes, resolvedById: userId, resolvedAt: now },
      });
      if (done.count === 0)
        throw new AppException('BIZ-017', 'The conflict has already been resolved');
      await tx.auditLog.create({
        data: auditRow(
          {
            officeId: this.officeId(),
            userId,
            entityType: 'ConflictOfInterest',
            entityId: id,
            action: 'UPDATE',
            oldValues: { resolved: false },
            newValues: { resolved: true, resolutionNotes: notes },
          },
          client,
        ),
      });
    });
    const row = await this.prisma.db.conflictOfInterest.findFirst({
      where: { id },
      select: CONFLICT_SELECT,
    });
    const [presented] = row ? await this.present([row]) : [];
    if (!presented) throw new ResourceNotFoundException();
    return presented;
  }

  /** Write access to either file; neither reachable → 404 (D-019), an archived one → BIZ-007 (the last error wins). */
  private async assertEditable(fileIdA: string, fileIdB: string): Promise<void> {
    try {
      await this.access.assertFileAccess(fileIdA, 'write');
    } catch (error) {
      if (!(error instanceof AppException)) throw error;
      await this.access.assertFileAccess(fileIdB, 'write');
    }
  }

  private async present(rows: ConflictRow[]): Promise<Conflict[]> {
    const ids = [...new Set(rows.flatMap((row) => [row.fileA.id, row.fileB.id]))];
    const visible = new Set(
      (
        await this.prisma.db.legalFile.findMany({
          where: { AND: [{ id: { in: ids } }, this.access.visibleWhere()] },
          select: { id: true },
        })
      ).map((file) => file.id),
    );
    const shown = (file: ConflictRow['fileA']) => (visible.has(file.id) ? file : null);
    return rows.flatMap((row) =>
      isReason(row.reason)
        ? [
            {
              id: row.id,
              reason: row.reason,
              party: { id: row.party.id, name: row.party.fullName ?? row.party.companyName ?? '' },
              file: shown(row.fileA),
              otherFile: shown(row.fileB),
              detectedAt: row.detectedAt.toISOString(),
              resolved: row.resolved,
              // The note may describe either matter: only for readers who can open both.
              resolutionNotes:
                visible.has(row.fileA.id) && visible.has(row.fileB.id) ? row.resolutionNotes : null,
              resolvedAt: row.resolvedAt?.toISOString() ?? null,
            },
          ]
        : [],
    );
  }

  private actorId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}
