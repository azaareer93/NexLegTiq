import { Injectable } from '@nestjs/common';
import type {
  CreateProsecutorRequest,
  Prosecutor,
  ProsecutorQuery,
  UpdateProsecutorRequest,
} from '@nexlegtiq/shared-contracts';

import { ReferenceContext } from './reference-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { changedFields } from '../clients/client-context';

const SELECT = {
  id: true,
  fullName: true,
  officeName: true,
  phone: true,
  email: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PublicProsecutorSelect;

type Row = Prisma.PublicProsecutorGetPayload<{ select: typeof SELECT }>;

const toProsecutor = ({ createdAt, updatedAt, ...row }: Row): Prosecutor => ({
  ...row,
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

/** The office's public prosecutors (MVP-66): a tenant table, hard-deleted with an audit row. */
@Injectable()
export class ProsecutorsService {
  constructor(
    private readonly ctx: ReferenceContext,
    private readonly uow: UnitOfWork,
    private readonly prisma: PrismaService,
  ) {}

  async list(query: ProsecutorQuery): Promise<PaginatedResult<Prosecutor>> {
    const contains = query.search && { contains: query.search, mode: 'insensitive' as const };
    const where: Prisma.PublicProsecutorWhereInput = contains
      ? { OR: [{ fullName: contains }, { officeName: contains }] }
      : {};
    const [rows, total] = await Promise.all([
      this.prisma.db.publicProsecutor.findMany({
        where,
        select: SELECT,
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.db.publicProsecutor.count({ where }),
    ]);
    return PaginatedResult.of(rows.map(toProsecutor), {
      page: query.page,
      limit: query.limit,
      total,
    });
  }

  async get(id: string): Promise<Prosecutor> {
    return toProsecutor(await this.find(id));
  }

  async create(input: CreateProsecutorRequest, caller: ClientInfo): Promise<Prosecutor> {
    return this.uow.run(async (tx) => {
      const row = await tx.publicProsecutor.create({
        data: { ...input, officeId: this.ctx.officeId() },
        select: SELECT,
      });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'PublicProsecutor', row.id, 'CREATE', null, input),
      });
      return toProsecutor(row);
    });
  }

  async update(
    id: string,
    input: UpdateProsecutorRequest,
    caller: ClientInfo,
  ): Promise<Prosecutor> {
    return this.uow.run(async (tx) => {
      const before = await this.find(id, tx);
      const { old, next } = changedFields(before, input);
      if (Object.keys(next).length === 0) return toProsecutor(before);
      await tx.publicProsecutor.updateMany({ where: { id }, data: next });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'PublicProsecutor', id, 'UPDATE', old, next),
      });
      return toProsecutor(await this.find(id, tx));
    });
  }

  async remove(id: string, caller: ClientInfo): Promise<void> {
    await this.uow.run(async (tx) => {
      const row = await this.find(id, tx);
      const { count } = await tx.publicProsecutor.deleteMany({ where: { id } });
      if (count === 0) throw new ResourceNotFoundException();
      await tx.auditLog.create({
        data: this.ctx.auditRow(
          caller,
          'PublicProsecutor',
          id,
          'DELETE',
          { fullName: row.fullName },
          null,
        ),
      });
    });
  }

  private async find(
    id: string,
    db: Pick<PrismaService['db'], 'publicProsecutor'> = this.prisma.db,
  ) {
    const row = await db.publicProsecutor.findFirst({ where: { id }, select: SELECT });
    if (!row) throw new ResourceNotFoundException();
    return row;
  }
}
