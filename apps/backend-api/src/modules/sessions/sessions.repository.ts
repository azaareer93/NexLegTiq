import { Injectable } from '@nestjs/common';
import type { Session, SessionListItem } from '@nexlegtiq/shared-contracts';

import { sessionStatus } from './session-rules';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

const PERSON = { select: { id: true, fullName: true } } as const;

const LIST_SELECT = {
  id: true,
  sessionType: true,
  startsAt: true,
  endsAt: true,
  courtRoom: true,
  reminderDays: true,
  outcome: true,
  nextSessionId: true,
  isCancelled: true,
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
  file: { select: { id: true, fileNumber: true, title: true } },
  court: { select: { id: true, nameAr: true, nameEn: true } },
  judge: PERSON,
  attendingLawyer: PERSON,
  previousSession: { select: { id: true } },
} satisfies Prisma.SessionSelect;

const SESSION_SELECT = { ...LIST_SELECT, minutes: true } satisfies Prisma.SessionSelect;

type ListRow = Prisma.SessionGetPayload<{ select: typeof LIST_SELECT }>;

/** Reads of sessions on the scoped client; callers pass the access `where` from SessionsService. */
@Injectable()
export class SessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Lists leave the minutes out (SessionListItem). */
  async findMany(
    where: Prisma.SessionWhereInput,
    orderBy: Prisma.SessionOrderByWithRelationInput[],
    page: { skip: number; take: number },
  ): Promise<SessionListItem[]> {
    const rows = await this.prisma.db.session.findMany({
      where,
      select: LIST_SELECT,
      orderBy,
      ...page,
    });
    return rows.map(toListItem);
  }

  count(where: Prisma.SessionWhereInput): Promise<number> {
    return this.prisma.db.session.count({ where });
  }

  async get(id: string): Promise<Session> {
    const { minutes, ...row } = await this.prisma.db.session.findFirstOrThrow({
      where: { id },
      select: SESSION_SELECT,
    });
    return { ...toListItem(row), minutes };
  }
}

function toListItem({ isCancelled, previousSession, ...row }: ListRow): SessionListItem {
  return {
    ...row,
    status: sessionStatus({ isCancelled, outcome: row.outcome }),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    previousSessionId: previousSession?.id ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
