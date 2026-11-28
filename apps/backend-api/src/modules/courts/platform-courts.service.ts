import { Injectable } from '@nestjs/common';
import type {
  AdminCourtQuery,
  AdminOfficeCourtQuery,
  Court,
  CreateCourtRequest,
  OfficeCourt,
  PromoteOfficeCourtRequest,
  ReplaceOfficeCourtResult,
  UpdateCourtRequest,
} from '@nexlegtiq/shared-contracts';

import { COURT_SELECT, toCourt } from './courts.service';
import { deleteOrInUse } from './reference-context';
import { changes } from '../../common/audit/changes';
import type { ClientInfo } from '../../common/context/client-info';
import { ResourceNotFoundException, ValidationException } from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { PlatformAuditService } from '../platform-auth/platform-audit.service';

type Tx = Prisma.TransactionClient;

const contains = (search: string | undefined) =>
  search ? { contains: search, mode: 'insensitive' as const } : undefined;

const OFFICE_COURT_SELECT = {
  ...COURT_SELECT,
  office: { select: { name: true } },
  _count: { select: { legalFiles: true, sessions: true, judges: true } },
} satisfies Prisma.CourtSelect;
type OfficeCourtRow = Prisma.CourtGetPayload<{ select: typeof OFFICE_COURT_SELECT }>;

const toOfficeCourt = ({ office, _count, ...row }: OfficeCourtRow): OfficeCourt => ({
  ...toCourt(row),
  // The select names only office rows, so officeId is set.
  officeId: row.officeId ?? '',
  officeName: office?.name ?? '',
  fileCount: _count.legalFiles,
  sessionCount: _count.sessions,
  judgeCount: _count.judges,
});

/** Lets the D-115 owner-fixed triggers through for this transaction only (migration platform_courts, D-266). */
const allowCourtMerge = (tx: Tx) =>
  tx.$executeRaw`SELECT set_config('nlq.court_merge', 'on', true)`;

/**
 * Courts for the platform admin (MVP-167, D-266): the platform courts of each country, and the offices' own legacy
 * courts, which the admin replaces with a platform court or promotes into one. Every change is audited.
 * unscoped: platform reference data and rows of every office, written only by the platform admin (D-080).
 */
@Injectable()
export class PlatformCourtsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  async list(query: AdminCourtQuery): Promise<PaginatedResult<Court>> {
    const text = contains(query.search);
    const where: Prisma.CourtWhereInput = {
      officeId: null,
      jurisdiction: query.jurisdiction,
      ...(query.courtType && { courtType: query.courtType }),
      ...(text && { OR: [{ nameAr: text }, { nameEn: text }, { city: text }] }),
    };
    // unscoped: see the class comment.
    const db = this.prisma.unscoped();
    const [rows, total] = await Promise.all([
      db.court.findMany({
        where,
        select: COURT_SELECT,
        orderBy: [{ nameAr: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.court.count({ where }),
    ]);
    return PaginatedResult.of(rows.map(toCourt), { page: query.page, limit: query.limit, total });
  }

  /** 409 RES-002 when the country already has a platform court with that English name. */
  async create(body: CreateCourtRequest, adminId: string, client: ClientInfo): Promise<Court> {
    return this.write(async (tx) => {
      const court = await tx.court.create({ data: body, select: COURT_SELECT });
      await this.log(tx, adminId, client, 'COURT_CREATED', court.id, undefined, { ...body });
      return toCourt(court);
    });
  }

  /** A platform court only (an office court or an unknown id → 404). */
  async update(
    id: string,
    body: UpdateCourtRequest,
    adminId: string,
    client: ClientInfo,
  ): Promise<Court> {
    return this.write(async (tx) => {
      const before = await tx.court.findFirst({
        where: { id, officeId: null },
        select: COURT_SELECT,
      });
      if (!before) throw new ResourceNotFoundException();
      const { old, next } = changes(before, body);
      if (Object.keys(next).length === 0) return toCourt(before);
      const court = await tx.court.update({ where: { id }, data: next, select: COURT_SELECT });
      await this.log(tx, adminId, client, 'COURT_UPDATED', id, old, next);
      return toCourt(court);
    });
  }

  async listOfficeCourts(query: AdminOfficeCourtQuery): Promise<PaginatedResult<OfficeCourt>> {
    const text = contains(query.search);
    const where: Prisma.CourtWhereInput = {
      officeId: { not: null },
      ...(text && {
        OR: [{ nameAr: text }, { nameEn: text }, { city: text }, { office: { name: text } }],
      }),
    };
    // unscoped: see the class comment.
    const db = this.prisma.unscoped();
    const [rows, total] = await Promise.all([
      db.court.findMany({
        where,
        select: OFFICE_COURT_SELECT,
        orderBy: [{ nameAr: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      db.court.count({ where }),
    ]);
    return PaginatedResult.of(rows.map(toOfficeCourt), {
      page: query.page,
      limit: query.limit,
      total,
    });
  }

  /**
   * The office court's files and sessions name the platform court instead, its judges move there (they stay the
   * office's), and the office court is deleted — in one transaction, touching only that office's rows. The platform
   * court must be of the same country (400 VAL-001 `validation.unknownCourt`).
   */
  async replace(
    id: string,
    courtId: string,
    adminId: string,
    client: ClientInfo,
  ): Promise<ReplaceOfficeCourtResult> {
    let result: ReplaceOfficeCourtResult | undefined;
    await deleteOrInUse(async () => {
      result = await this.write(async (tx) => {
        const from = await this.lockOfficeCourt(tx, id);
        const target = await tx.court.findFirst({
          where: { id: courtId, officeId: null, jurisdiction: from.jurisdiction },
          select: { id: true },
        });
        if (!target) {
          throw new ValidationException([{ field: 'courtId', message: 'validation.unknownCourt' }]);
        }
        await allowCourtMerge(tx);
        // Judges first: the file and session triggers then find a file's judge at its new court.
        const judges = await tx.$executeRaw`
          UPDATE judges SET court_id = ${courtId}::uuid
          WHERE court_id = ${id}::uuid AND office_id = ${from.officeId}::uuid`;
        // Raw SQL leaves updated_at alone: re-pointing is not an edit of the file or hearing.
        const files = await tx.$executeRaw`
          UPDATE legal_files SET court_id = ${courtId}::uuid
          WHERE court_id = ${id}::uuid AND office_id = ${from.officeId}::uuid`;
        const sessions = await tx.$executeRaw`
          UPDATE sessions SET court_id = ${courtId}::uuid
          WHERE court_id = ${id}::uuid AND office_id = ${from.officeId}::uuid`;
        await tx.court.delete({ where: { id } });
        const counts = { courtId, files, sessions, judges };
        await this.log(
          tx,
          adminId,
          client,
          'OFFICE_COURT_REPLACED',
          id,
          { nameAr: from.nameAr, nameEn: from.nameEn },
          counts,
          from.officeId,
        );
        return counts;
      });
    });
    // deleteOrInUse rethrows every failure, so a result is set here.
    return result as ReplaceOfficeCourtResult;
  }

  /**
   * The office court becomes a platform court of its country, which every office there can pick; its judges stay the
   * office's. It needs an English name (the platform key, D-115): 400 VAL-001 without one, 409 RES-002 when taken.
   */
  async promote(
    id: string,
    body: PromoteOfficeCourtRequest,
    adminId: string,
    client: ClientInfo,
  ): Promise<Court> {
    return this.write(async (tx) => {
      const from = await this.lockOfficeCourt(tx, id);
      const nameEn = body.nameEn ?? from.nameEn;
      if (!nameEn) {
        throw new ValidationException([{ field: 'nameEn', message: 'validation.required' }]);
      }
      await allowCourtMerge(tx);
      const court = await tx.court.update({
        where: { id },
        data: { officeId: null, nameEn },
        select: COURT_SELECT,
      });
      await this.log(
        tx,
        adminId,
        client,
        'OFFICE_COURT_PROMOTED',
        id,
        { officeId: from.officeId, nameEn: from.nameEn },
        { officeId: null, nameEn },
        from.officeId,
      );
      return toCourt(court);
    });
  }

  /** An office court, locked against a concurrent replace or promote; a platform court or unknown id → 404. */
  private async lockOfficeCourt(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM courts WHERE id = ${id}::uuid FOR UPDATE`;
    const court = await tx.court.findFirst({
      where: { id, officeId: { not: null } },
      select: { officeId: true, jurisdiction: true, nameAr: true, nameEn: true },
    });
    if (!court?.officeId) throw new ResourceNotFoundException();
    return { ...court, officeId: court.officeId };
  }

  private write<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    // unscoped: see the class comment.
    return this.prisma.unscoped().$transaction(work);
  }

  private log(
    tx: Tx,
    adminId: string,
    client: ClientInfo,
    action: string,
    entityId: string,
    oldValues: Record<string, unknown> | undefined,
    newValues: Record<string, unknown>,
    targetOfficeId: string | null = null,
  ): Promise<void> {
    // Names, ids, counts and flags only: plain JSON values.
    const json = (values?: Record<string, unknown>) => values as Prisma.InputJsonObject | undefined;
    return this.audit.log(
      {
        adminId,
        action,
        entityType: 'Court',
        entityId,
        targetOfficeId,
        oldValues: json(oldValues),
        newValues: json(newValues),
      },
      client,
      tx,
    );
  }
}
