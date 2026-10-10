import { Injectable } from '@nestjs/common';
import type { ClientListItem, ClientQuery, ContactPerson } from '@nexlegtiq/shared-contracts';
import type { FileStatus } from '@nexlegtiq/shared-types';

import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';

/** A client's files that are still being worked on; CLOSED and ARCHIVED ones count as closed. */
export const OPEN_FILE_STATUSES: readonly FileStatus[] = ['OPEN', 'SUSPENDED'];
const CLOSED_FILE_STATUSES: readonly FileStatus[] = ['CLOSED', 'ARCHIVED'];

export const LIST_SELECT = {
  id: true,
  clientType: true,
  displayName: true,
  fullName: true,
  companyName: true,
  phone: true,
  email: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  primaryLawyer: { select: { id: true, fullName: true } },
} satisfies Prisma.ClientSelect;

export const CONTACT_SELECT = {
  id: true,
  fullName: true,
  position: true,
  email: true,
  phone: true,
  isPrimary: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ContactPersonSelect;

const DETAIL_SELECT = {
  ...LIST_SELECT,
  nationalId: true,
  taxId: true,
  address: true,
  industry: true,
  contacts: {
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: CONTACT_SELECT,
  },
} satisfies Prisma.ClientSelect;

type ListRow = Prisma.ClientGetPayload<{ select: typeof LIST_SELECT }>;
export type ClientRow = Prisma.ClientGetPayload<{ select: typeof DETAIL_SELECT }> & {
  openFiles: number;
  closedFiles: number;
};
type ContactRow = Prisma.ContactPersonGetPayload<{ select: typeof CONTACT_SELECT }>;

const SORT_COLUMN = {
  name: Prisma.sql`c.display_name`,
  createdAt: Prisma.sql`c.created_at`,
  openFiles: Prisma.sql`open_files`,
} as const;

/** `%`, `_` and `\` are literal in a search term. */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, '\\$&')}%`;

/** Reads of clients on the scoped client (raw SQL always takes the current office as a parameter, D-080). */
@Injectable()
export class ClientsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One page of live clients. The order (including by open-file count, which Prisma cannot sort by) and the count come
   * from SQL; the rows are then read with Prisma. Search is a case-insensitive substring match served by the trigram
   * indexes; Arabic normalisation (hamza and alef forms) comes with global search.
   */
  async list(
    officeId: string,
    query: ClientQuery,
  ): Promise<{ items: ClientListItem[]; total: number }> {
    const where = Prisma.join(conditionsOf(officeId, query), ' AND ');
    const orderBy = Prisma.join(
      query.sort.map(({ field, direction }) =>
        direction === 'desc'
          ? Prisma.sql`${SORT_COLUMN[field]} DESC`
          : Prisma.sql`${SORT_COLUMN[field]} ASC`,
      ),
      ', ',
    );
    const [page, [count]] = await Promise.all([
      this.prisma.db.$queryRaw<{ id: string; open_files: number }[]>`
        SELECT c.id, (
          SELECT count(*) FROM file_clients fc
          JOIN legal_files f ON f.id = fc.file_id AND f.office_id = fc.office_id
          WHERE fc.client_id = c.id AND fc.office_id = c.office_id AND f.deleted_at IS NULL
            AND f.status::text IN (${Prisma.join(OPEN_FILE_STATUSES)})
        )::int AS open_files
        FROM clients c WHERE ${where}
        ORDER BY ${orderBy}, c.id ASC
        LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`,
      this.prisma.db.$queryRaw<{ total: number }[]>`
        SELECT count(*)::int AS total FROM clients c WHERE ${where}`,
    ]);
    const rows = await this.prisma.db.client.findMany({
      where: { id: { in: page.map((row) => row.id) } },
      select: LIST_SELECT,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = page.flatMap(({ id, open_files }) => {
      const row = byId.get(id);
      return row ? [toListItem(row, open_files)] : [];
    });
    return { items, total: count?.total ?? 0 };
  }

  /** A live client with its contacts and file counts, or null. */
  async get(id: string): Promise<ClientRow | null> {
    const [row, openFiles, closedFiles] = await Promise.all([
      this.prisma.db.client.findFirst({ where: { id, deletedAt: null }, select: DETAIL_SELECT }),
      this.countFiles(id, OPEN_FILE_STATUSES),
      this.countFiles(id, CLOSED_FILE_STATUSES),
    ]);
    return row && { ...row, openFiles, closedFiles };
  }

  countFiles(clientId: string, statuses: readonly FileStatus[]): Promise<number> {
    return this.prisma.db.fileClient.count({
      where: { clientId, file: { deletedAt: null, status: { in: [...statuses] } } },
    });
  }
}

function conditionsOf(officeId: string, query: ClientQuery): Prisma.Sql[] {
  const conditions = [
    Prisma.sql`c.office_id = ${officeId}::uuid`,
    Prisma.sql`c.deleted_at IS NULL`,
  ];
  if (query.clientType) conditions.push(Prisma.sql`c.client_type::text = ${query.clientType}`);
  if (query.isActive !== undefined) conditions.push(Prisma.sql`c.is_active = ${query.isActive}`);
  if (query.search) {
    const like = likePattern(query.search);
    conditions.push(
      Prisma.sql`(c.display_name ILIKE ${like} OR c.full_name ILIKE ${like}
        OR c.company_name ILIKE ${like} OR c.phone ILIKE ${like})`,
    );
  }
  return conditions;
}

export function toListItem(row: ListRow, openFiles: number): ClientListItem {
  return {
    ...row,
    openFiles,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toContact(row: ContactRow): ContactPerson {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
