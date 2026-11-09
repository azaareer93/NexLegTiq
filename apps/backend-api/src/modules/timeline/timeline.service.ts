import { Injectable } from '@nestjs/common';
import { TimelineEventSchema } from '@nexlegtiq/shared-contracts';
import type { TimelineEvent, TimelinePage, TimelineQuery } from '@nexlegtiq/shared-contracts';
import { PORTAL_TIMELINE_EVENT_TYPES } from '@nexlegtiq/shared-types';
import type { TimelineEventType, UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import type { RequestContext } from '../../common/context/request-context';
import { assignedFilesWhere } from '../../common/rbac/case-scope';
import { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import { DocumentAccessService } from '../documents/document-access.service';
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

const withoutName = ({ name: _name, ...rest }: Prisma.JsonObject): Prisma.JsonObject => rest;

const EVENT_SELECT = {
  id: true,
  eventType: true,
  sourceType: true,
  sourceId: true,
  occurredAt: true,
  payload: true,
  actor: { select: { id: true, fullName: true } },
} as const;

type EventFile = { id: string; fileNumber: string; title: string };

interface EventRow {
  readonly id: string;
  readonly eventType: TimelineEventType;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly occurredAt: Date;
  readonly payload: Prisma.JsonValue;
  readonly actor: { id: string; fullName: string } | null;
}

const isObject = (value: Prisma.JsonValue): value is Prisma.JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
    private readonly documents: DocumentAccessService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TimelineService.name);
  }

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
      select: EVENT_SELECT,
    });
    const page = rows.slice(0, limit);
    return {
      items: await this.readable(page),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      names: await this.names(page.map((row) => row.payload)),
    };
  }

  /** The latest events of the files the caller is assigned to (the dashboard, D-151), each with its file. */
  async recent(
    userId: string,
    limit: number,
  ): Promise<{
    items: (TimelineEvent & { file: { id: string; fileNumber: string; title: string } })[];
    names: Record<string, string>;
  }> {
    const rows = await this.prisma.db.caseTimelineEvent.findMany({
      where: { file: { AND: [this.access.visibleWhere(), assignedFilesWhere(userId as UserId)] } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { ...EVENT_SELECT, file: { select: { id: true, fileNumber: true, title: true } } },
    });
    const items = await this.readable(rows);
    const files = new Map(rows.map((row) => [row.id, row.file]));
    return {
      // Every readable item comes from one of `rows`, so its file is always there.
      items: items.map((item) => ({ ...item, file: files.get(item.id) as EventFile })),
      names: await this.names(rows.map((row) => row.payload)),
    };
  }

  /** Rows as contract events, with what the reader may no longer see removed. */
  private async readable(page: readonly EventRow[]): Promise<TimelineEvent[]> {
    const hidden = await this.hiddenDocuments(page);
    return page.flatMap((row) => {
      // Payload strings are snapshots: a document made confidential later, or deleted, keeps neither its name nor its
      // link for readers who may not open it now (D-126, D-150).
      const payload = isObject(row.payload) ? row.payload : {};
      const secret =
        row.sourceType === 'Document' && row.sourceId !== null && hidden.has(row.sourceId);
      const parsed = TimelineEventSchema.safeParse({
        id: row.id,
        eventType: row.eventType,
        sourceType: row.sourceType,
        sourceId: secret ? null : row.sourceId,
        actor: row.actor,
        payload: secret ? withoutName(payload) : payload,
        occurredAt: row.occurredAt.toISOString(),
        portalVisible: PORTAL_TIMELINE_EVENT_TYPES.has(row.eventType),
      });
      if (parsed.success) return [parsed.data];
      // A row the contract cannot read is left out (logged), never a 500 for the whole history (as D-149).
      this.logger.warn({ eventId: row.id }, 'Unreadable timeline event left out');
      return [] as TimelineEvent[];
    });
  }

  /** The documents of the page the caller may not open (confidential, deleted): one query. */
  private async hiddenDocuments(
    rows: readonly { sourceType: string | null; sourceId: string | null }[],
  ): Promise<Set<string>> {
    const ids = [
      ...new Set(
        rows.flatMap((r) => (r.sourceType === 'Document' && r.sourceId ? [r.sourceId] : [])),
      ),
    ];
    if (ids.length === 0) return new Set();
    const visible = await this.prisma.db.document.findMany({
      where: { AND: [{ id: { in: ids } }, this.documents.visibleWhere()] },
      select: { id: true },
    });
    const seen = new Set(visible.map((d) => d.id));
    return new Set(ids.filter((id) => !seen.has(id)));
  }

  /** Names of the colleagues and clients the page's events mention, by id (one query each). */
  private async names(payloads: readonly Prisma.JsonValue[]): Promise<Record<string, string>> {
    const users = new Set<string>();
    const clients = new Set<string>();
    for (const payload of payloads) {
      if (!isObject(payload)) continue;
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
