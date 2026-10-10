import { Injectable } from '@nestjs/common';
import type { Case, CaseListItem, CaseQuery } from '@nexlegtiq/shared-contracts';

import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

const PERSON = { select: { id: true, fullName: true } } as const;

const LIST_SELECT = {
  id: true,
  fileNumber: true,
  title: true,
  fileType: true,
  status: true,
  priority: true,
  openingDate: true,
  isConfidential: true,
  updatedAt: true,
  responsibleLawyer: PERSON,
  clients: {
    where: { isPrimary: true },
    take: 1,
    select: { client: { select: { id: true, displayName: true } } },
  },
} satisfies Prisma.LegalFileSelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  description: true,
  subType: true,
  closingDate: true,
  courtCaseNumber: true,
  jurisdiction: true,
  billingMethod: true,
  hourlyRate: true,
  fixedFee: true,
  retainerBalance: true,
  currency: true,
  createdAt: true,
  responsibleParalegal: PERSON,
  clients: {
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    select: {
      isPrimary: true,
      client: { select: { id: true, displayName: true, clientType: true } },
    },
  },
  teamMembers: {
    orderBy: { createdAt: 'asc' },
    select: { role: true, user: PERSON },
  },
  _count: { select: { parties: true, notes: true } },
} satisfies Prisma.LegalFileSelect;

type ListRow = Prisma.LegalFileGetPayload<{ select: typeof LIST_SELECT }>;
type DetailRow = Prisma.LegalFileGetPayload<{ select: typeof DETAIL_SELECT }>;

/** `YYYY-MM-DD` of a `@db.Date` column (stored at UTC midnight). */
const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);
const money = (value: Prisma.Decimal | null): string | null => value?.toFixed(2) ?? null;

/** Reads of legal files on the scoped client; callers pass the access `where` from CaseAccessService. */
@Injectable()
export class CasesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    access: Prisma.LegalFileWhereInput,
    query: CaseQuery,
  ): Promise<{ items: CaseListItem[]; total: number }> {
    const where: Prisma.LegalFileWhereInput = { AND: [access, filtersOf(query)] };
    const [rows, total] = await Promise.all([
      this.prisma.db.legalFile.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [
          ...query.sort.map(({ field, direction }) => ({ [field]: direction })),
          { id: 'asc' },
        ],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.db.legalFile.count({ where }),
    ]);
    return { items: rows.map(toListItem), total };
  }

  async get(id: string): Promise<Case> {
    const row = await this.prisma.db.legalFile.findFirstOrThrow({
      where: { id, deletedAt: null },
      select: DETAIL_SELECT,
    });
    return toCase(row);
  }
}

function filtersOf(query: CaseQuery): Prisma.LegalFileWhereInput {
  const search = query.search
    ? {
        OR: [
          { fileNumber: { contains: query.search, mode: 'insensitive' as const } },
          { title: { contains: query.search, mode: 'insensitive' as const } },
          { courtCaseNumber: { contains: query.search, mode: 'insensitive' as const } },
          {
            clients: {
              some: {
                client: {
                  deletedAt: null,
                  displayName: { contains: query.search, mode: 'insensitive' as const },
                },
              },
            },
          },
        ],
      }
    : {};
  return {
    ...search,
    ...(query.status && { status: query.status }),
    ...(query.fileType && { fileType: { in: query.fileType } }),
    ...(query.priority && { priority: query.priority }),
    ...(query.responsibleLawyerId && { responsibleLawyerId: query.responsibleLawyerId }),
    ...(query.clientId && { clients: { some: { clientId: query.clientId } } }),
  };
}

function toListItem(row: ListRow): CaseListItem {
  const primary = row.clients[0]?.client ?? null;
  return {
    id: row.id,
    fileNumber: row.fileNumber,
    title: row.title,
    fileType: row.fileType,
    status: row.status,
    priority: row.priority,
    openingDate: dateOnly(row.openingDate),
    isConfidential: row.isConfidential,
    primaryClient: primary,
    responsibleLawyer: row.responsibleLawyer,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toCase(row: DetailRow): Case {
  const primary = row.clients.find((link) => link.isPrimary)?.client ?? null;
  return {
    ...toListItem({ ...row, clients: [] }),
    primaryClient: primary && { id: primary.id, displayName: primary.displayName },
    description: row.description,
    subType: row.subType,
    closingDate: row.closingDate && dateOnly(row.closingDate),
    responsibleParalegal: row.responsibleParalegal,
    courtCaseNumber: row.courtCaseNumber,
    jurisdiction: row.jurisdiction,
    billingMethod: row.billingMethod,
    hourlyRate: money(row.hourlyRate),
    fixedFee: money(row.fixedFee),
    retainerBalance: row.retainerBalance.toFixed(2),
    currency: row.currency,
    clients: row.clients.map(({ isPrimary, client }) => ({ ...client, isPrimary })),
    team: row.teamMembers.map(({ role, user }) => ({ ...user, role })),
    counts: row._count,
    createdAt: row.createdAt.toISOString(),
  };
}
