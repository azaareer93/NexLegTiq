import { Injectable } from '@nestjs/common';
import type { Session } from '@nexlegtiq/shared-contracts';

import { sessionStatus } from './session-rules';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

const PERSON = { select: { id: true, fullName: true } } as const;

const SESSION_SELECT = {
  id: true,
  sessionType: true,
  startsAt: true,
  endsAt: true,
  courtRoom: true,
  reminderDays: true,
  outcome: true,
  minutes: true,
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

type SessionRow = Prisma.SessionGetPayload<{ select: typeof SESSION_SELECT }>;

/** Reads of sessions on the scoped client; callers pass the access `where` from SessionsService. */
@Injectable()
export class SessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(
    where: Prisma.SessionWhereInput,
    orderBy: Prisma.SessionOrderByWithRelationInput[],
    page?: { skip: number; take: number },
  ): Promise<Session[]> {
    const rows = await this.prisma.db.session.findMany({
      where,
      select: SESSION_SELECT,
      orderBy,
      ...page,
    });
    return rows.map(toSession);
  }

  count(where: Prisma.SessionWhereInput): Promise<number> {
    return this.prisma.db.session.count({ where });
  }

  async get(id: string): Promise<Session> {
    return toSession(
      await this.prisma.db.session.findFirstOrThrow({ where: { id }, select: SESSION_SELECT }),
    );
  }
}

function toSession({ isCancelled, previousSession, ...row }: SessionRow): Session {
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
