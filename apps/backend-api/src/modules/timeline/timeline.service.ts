import { Injectable } from '@nestjs/common';
import { TimelinePageSchema } from '@nexlegtiq/shared-contracts';
import type { TimelinePage, TimelineQuery } from '@nexlegtiq/shared-contracts';
import { PORTAL_TIMELINE_EVENT_TYPES } from '@nexlegtiq/shared-types';
import type { TimelineEventType } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import { CaseAccessService } from '../legal-files/case-access.service';

/** One event of a file's history (D-150): the text is rendered by the app from its type and `payload`. */
export interface TimelineEntry {
  readonly fileId: string;
  readonly eventType: TimelineEventType;
  /** The row behind the event (`Session`, `Document`, `Task`, `FileParty`…) and its id; polymorphic, no FK. */
  readonly sourceType?: string;
  readonly sourceId?: string;
  /** i18n params: ids, names the file's readers may see, dates — never a confidential document's name (D-126). */
  readonly payload?: Prisma.InputJsonObject;
  /** Who did it; the caller by default, `null` for the system. */
  readonly actorId?: string | null;
}

/** Payload keys that name a user or a client: their names come with the page, so the app can say who. */
const PERSON_KEYS = ['fromUserId', 'toUserId', 'userId', 'clientId'] as const;

/**
 * A file's timeline (D-039, D-150). `record` is how every module writes an event, inside the transaction of the change it
 * describes (append-only: UPDATE is revoked from the app role, D-095). `list` reads a file's events newest first by
 * cursor, for anyone who may read the file (D-096).
 */
@Injectable()
export class TimelineService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly access: CaseAccessService,
  ) {}

  async record(
    tx: Pick<ScopedTransaction, 'caseTimelineEvent'>,
    entry: TimelineEntry,
  ): Promise<void> {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of a timeline event');
    const { fileId, eventType, sourceType, sourceId, payload = {} } = entry;
    const actorId = entry.actorId === undefined ? (this.cls.get('userId') ?? null) : entry.actorId;
    await tx.caseTimelineEvent.create({
      data: { officeId, fileId, eventType, sourceType, sourceId, actorId, payload },
    });
  }

  async list(fileId: string, { cursor, types, limit }: TimelineQuery): Promise<TimelinePage> {
    await this.access.assertFileAccess(fileId, 'read');
    const rows = await this.prisma.db.caseTimelineEvent.findMany({
      where: { fileId, ...(types?.length ? { eventType: { in: types } } : {}) },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        eventType: true,
        sourceType: true,
        sourceId: true,
        occurredAt: true,
        payload: true,
        actor: { select: { id: true, fullName: true } },
      },
    });
    const page = rows.slice(0, limit);
    return TimelinePageSchema.parse({
      items: page.map((row) => ({
        ...row,
        occurredAt: row.occurredAt.toISOString(),
        portalVisible: PORTAL_TIMELINE_EVENT_TYPES.has(row.eventType),
      })),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      names: await this.names(page.map((row) => row.payload)),
    });
  }

  /** Names of the colleagues and clients the page's events mention, by id (one query each). */
  private async names(payloads: readonly Prisma.JsonValue[]): Promise<Record<string, string>> {
    const users = new Set<string>();
    const clients = new Set<string>();
    for (const payload of payloads) {
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue;
      for (const key of PERSON_KEYS) {
        const value = payload[key];
        if (typeof value === 'string') (key === 'clientId' ? clients : users).add(value);
      }
    }
    const [people, firms] = await Promise.all([
      users.size
        ? this.prisma.db.user.findMany({
            where: { id: { in: [...users] } },
            select: { id: true, fullName: true },
          })
        : [],
      clients.size
        ? this.prisma.db.client.findMany({
            where: { id: { in: [...clients] } },
            select: { id: true, displayName: true },
          })
        : [],
    ]);
    return Object.fromEntries([
      ...people.map((u) => [u.id, u.fullName] as const),
      ...firms.map((c) => [c.id, c.displayName] as const),
    ]);
  }
}
