import { Injectable } from '@nestjs/common';
import type {
  Court,
  CourtQuery,
  CreateJudgeRequest,
  Judge,
  UpdateJudgeRequest,
} from '@nexlegtiq/shared-contracts';

import { deleteOrInUse, ReferenceContext } from './reference-context';
import type { ClientInfo } from '../../common/context/client-info';
import {
  PermissionDeniedException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import { changedFields } from '../clients/client-context';

export const COURT_SELECT = {
  id: true,
  officeId: true,
  jurisdiction: true,
  courtType: true,
  nameAr: true,
  nameEn: true,
  city: true,
  address: true,
  phone: true,
  email: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CourtSelect;

const JUDGE_SELECT = {
  id: true,
  officeId: true,
  courtId: true,
  fullName: true,
  isActive: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JudgeSelect;

type CourtRow = Prisma.CourtGetPayload<{ select: typeof COURT_SELECT }>;
type JudgeRow = Prisma.JudgeGetPayload<{ select: typeof JUDGE_SELECT }>;

export const toCourt = ({ officeId, createdAt, updatedAt, ...row }: CourtRow): Court => ({
  ...row,
  isPlatform: officeId === null,
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

const toJudge = ({ officeId, createdAt, updatedAt, ...row }: JudgeRow): Judge => ({
  ...row,
  isPlatform: officeId === null,
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

/** Platform rows are read-only for offices (403 AUTH-100); the tenant extension would not reach them anyway. */
function assertOwn(row: { officeId: string | null }): void {
  if (row.officeId === null) throw new PermissionDeniedException();
}

/**
 * Courts and their judges (MVP-66, D-037, D-115, D-266). Offices pick from the active platform courts of their country
 * and never write courts (the platform admin does); a court a file already has (an office's legacy court, a deactivated
 * one) still reads. Judges: the office's own, at any court it sees. Another office's court or judge is 404 RES-001.
 */
@Injectable()
export class CourtsService {
  constructor(
    private readonly ctx: ReferenceContext,
    private readonly uow: UnitOfWork,
    private readonly prisma: PrismaService,
  ) {}

  async list(query: CourtQuery): Promise<PaginatedResult<Court>> {
    const contains = query.search && { contains: query.search, mode: 'insensitive' as const };
    const { jurisdiction } = await this.prisma.db.office.findFirstOrThrow({
      select: { jurisdiction: true },
    });
    const where: Prisma.CourtWhereInput = {
      officeId: null,
      isActive: true,
      jurisdiction,
      ...(query.courtType && { courtType: query.courtType }),
      ...(contains && { OR: [{ nameAr: contains }, { nameEn: contains }, { city: contains }] }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.court.findMany({
        where,
        select: COURT_SELECT,
        orderBy: [{ nameAr: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.db.court.count({ where }),
    ]);
    return PaginatedResult.of(rows.map(toCourt), {
      page: query.page,
      limit: query.limit,
      total,
    });
  }

  async get(id: string): Promise<Court> {
    return toCourt(await this.findCourt(id));
  }

  /** The court's judges visible to the office (platform ones and the office's own), active first. */
  async listJudges(courtId: string): Promise<Judge[]> {
    await this.findCourt(courtId);
    const judges = await this.prisma.db.judge.findMany({
      where: { courtId },
      select: JUDGE_SELECT,
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }, { id: 'asc' }],
    });
    return judges.map(toJudge);
  }

  async createJudge(
    courtId: string,
    input: CreateJudgeRequest,
    caller: ClientInfo,
  ): Promise<Judge> {
    return this.uow.run(async (tx) => {
      await this.findCourt(courtId, tx);
      const judge = await tx.judge.create({
        data: { ...input, courtId, officeId: this.ctx.officeId() },
        select: JUDGE_SELECT,
      });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'Judge', judge.id, 'CREATE', null, { courtId, ...input }),
      });
      return toJudge(judge);
    });
  }

  async updateJudge(
    courtId: string,
    id: string,
    input: UpdateJudgeRequest,
    caller: ClientInfo,
  ): Promise<Judge> {
    return this.uow.run(async (tx) => {
      const before = await this.findJudge(courtId, id, tx);
      assertOwn(before);
      const { old, next } = changedFields(before, input);
      if (Object.keys(next).length === 0) return toJudge(before);
      await tx.judge.updateMany({ where: { id }, data: next });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'Judge', id, 'UPDATE', old, next),
      });
      return toJudge(await this.findJudge(courtId, id, tx));
    });
  }

  /** 422 BIZ-011 while a file names the judge (deactivate instead). */
  async removeJudge(courtId: string, id: string, caller: ClientInfo): Promise<void> {
    await deleteOrInUse(() =>
      this.uow.run(async (tx) => {
        const judge = await this.findJudge(courtId, id, tx);
        assertOwn(judge);
        const { count } = await tx.judge.deleteMany({ where: { id } });
        if (count === 0) throw new ResourceNotFoundException();
        await tx.auditLog.create({
          data: this.ctx.auditRow(
            caller,
            'Judge',
            id,
            'DELETE',
            { courtId, fullName: judge.fullName },
            null,
          ),
        });
      }),
    );
  }

  private async findCourt(id: string, db: Pick<PrismaService['db'], 'court'> = this.prisma.db) {
    const court = await db.court.findFirst({ where: { id }, select: COURT_SELECT });
    if (!court) throw new ResourceNotFoundException();
    return court;
  }

  private async findJudge(
    courtId: string,
    id: string,
    db: Pick<PrismaService['db'], 'judge'> = this.prisma.db,
  ) {
    const judge = await db.judge.findFirst({ where: { id, courtId }, select: JUDGE_SELECT });
    if (!judge) throw new ResourceNotFoundException();
    return judge;
  }
}
