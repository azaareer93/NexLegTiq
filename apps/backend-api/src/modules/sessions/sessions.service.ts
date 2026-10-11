import { Injectable } from '@nestjs/common';
import type {
  CancelSessionRequest,
  CreateSessionRequest,
  FileSessionsQuery,
  Session,
  SessionListItem,
  SessionOutcomeRequest,
  SessionQuery,
  UpdateSessionRequest,
} from '@nexlegtiq/shared-contracts';
import type { UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { ReminderScheduler } from './reminder-scheduler';
import {
  auditJudge,
  changes,
  continuation,
  nextSlot,
  SLOT_FIELDS,
  slotChanges,
  toDate,
  updatedPayload,
} from './session-rules';
import { assertAttendingLawyer, SessionWriter, STATE_SELECT } from './session-writer';
import type { SessionState, Slot } from './session-writer';
import { SessionsRepository } from './sessions.repository';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { nextCourtRefs } from '../courts/court-refs';
import { CaseAccessService } from '../legal-files/case-access.service';

/** Most rows one calendar answer holds (a quarter of a large office's hearings stays far below). */
const CALENDAR_MAX = 2000;
/** A change to any of these replaces the pending reminders (time, recipient, offsets). */
const REMINDER_FIELDS = ['startsAt', 'attendingLawyerId', 'reminderDays'];
/** Calendar default window (SessionQuerySchema). */
const DEFAULT_RANGE_MS = 31 * 86_400_000;

/**
 * Hearings (MVP-67, D-116). A session follows its file: visible when the file is (CaseAccessService), changed only with
 * write access to it (404 otherwise, BIZ-007 once archived), and edited or cancelled only while scheduled (BIZ-012).
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly uow: UnitOfWork,
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
    private readonly writer: SessionWriter,
    private readonly sessions: SessionsRepository,
    private readonly reminders: ReminderScheduler,
  ) {}

  async create(input: CreateSessionRequest, client: ClientInfo): Promise<Session> {
    await this.files.assertFileAccess(input.fileId, 'write');
    const id = await this.uow.run((tx, afterCommit) =>
      this.writer.insert(
        tx,
        afterCommit,
        {
          ...input,
          startsAt: new Date(input.startsAt),
          endsAt: toDate(input.endsAt),
          courtId: input.courtId ?? null,
          judgeId: input.judgeId ?? null,
          courtRoom: input.courtRoom ?? null,
          // Spelled out: an optional key is not "possibly undefined" under exactOptionalPropertyTypes.
          reminderDays: input.reminderDays,
        },
        client,
      ),
    );
    return this.sessions.get(id);
  }

  /**
   * The calendar: sessions starting in [from, to) on files the caller can see. More than CALENDAR_MAX rows is refused
   * (400 `validation.dateRange` on `to`: ask for a shorter range) rather than silently cut.
   */
  async list(query: SessionQuery): Promise<SessionListItem[]> {
    const from = query.from ? new Date(query.from) : new Date();
    const to = query.to ? new Date(query.to) : new Date(from.getTime() + DEFAULT_RANGE_MS);
    const lawyerId = query.lawyerId === 'me' ? this.actorId() : query.lawyerId;
    const rows = await this.sessions.findMany(
      {
        AND: [
          this.visibleWhere(),
          { startsAt: { gte: from, lt: to } },
          ...(lawyerId ? [{ attendingLawyerId: lawyerId }] : []),
          ...(query.fileId ? [{ fileId: query.fileId }] : []),
        ],
      },
      [{ startsAt: 'asc' }, { id: 'asc' }],
      { skip: 0, take: CALENDAR_MAX + 1 },
    );
    if (rows.length > CALENDAR_MAX) {
      throw new ValidationException([{ field: 'to', message: 'validation.dateRange' }]);
    }
    return rows;
  }

  /** A file's sessions: upcoming soonest first, or past latest first. */
  async listForFile(
    fileId: string,
    query: FileSessionsQuery,
  ): Promise<PaginatedResult<SessionListItem>> {
    await this.files.assertFileAccess(fileId, 'read');
    const upcoming = query.when === 'upcoming';
    const now = new Date();
    const where: Prisma.SessionWhereInput = {
      fileId,
      startsAt: upcoming ? { gte: now } : { lt: now },
    };
    const dir = upcoming ? 'asc' : 'desc';
    const [items, total] = await Promise.all([
      this.sessions.findMany(where, [{ startsAt: dir }, { id: dir }], {
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.sessions.count(where),
    ]);
    return PaginatedResult.of(items, { page: query.page, limit: query.limit, total });
  }

  async get(id: string): Promise<Session> {
    await this.find(id);
    return this.sessions.get(id);
  }

  /**
   * Edits a scheduled session; only changed fields are written and audited. A new time or attending lawyer re-runs the
   * conflict check; a new time or new offsets replace the pending reminders.
   */
  async update(id: string, input: UpdateSessionRequest, client: ClientInfo): Promise<Session> {
    await this.findForWrite(id);
    await this.uow.run(async (tx, afterCommit) => {
      const session = await this.lockForWrite(tx, id);
      if (session.isCancelled || session.outcome) throw notScheduled();
      const { acknowledgeConflict, ...wanted } = input;
      const { old, next } = changes(session, wanted);
      if (Object.keys(next).length === 0) return;
      const slot = nextSlot(session, input);
      const moved = SLOT_FIELDS.some((field) => field in next);
      const courtRefs = await this.checkUpdate(tx, session, input, slot, moved, next);
      await tx.session.update({
        where: { id },
        data: {
          ...(next as Prisma.SessionUncheckedUpdateInput),
          ...courtRefs,
          ...slotChanges(slot, next),
        },
        select: { id: true },
      });
      if (REMINDER_FIELDS.some((field) => field in next)) {
        const days = input.reminderDays ?? session.reminderDays;
        await this.reminders.reset(tx, afterCommit, { ...slot, id, fileId: session.fileId }, days);
      }
      auditJudge(old, next, session.judgeId, courtRefs.judgeId);
      await this.writer.event(
        tx,
        session.fileId,
        id,
        'SESSION_UPDATED',
        updatedPayload(session, input, slot),
      );
      const acknowledged = moved && acknowledgeConflict && { acknowledgeConflict: true };
      await this.writer.audit(tx, client, session, old, { ...next, ...acknowledged });
    });
    return this.sessions.get(id);
  }

  /** A PATCH's checks: a new attending lawyer, the court and judge it leaves (returned), and conflicts when moved. */
  private async checkUpdate(
    tx: ScopedTransaction,
    session: SessionState,
    input: UpdateSessionRequest,
    slot: Slot,
    moved: boolean,
    next: Record<string, unknown>,
  ) {
    if ('attendingLawyerId' in next) {
      await assertAttendingLawyer(tx, slot.attendingLawyerId, session.fileId);
    }
    const courtRefs = await nextCourtRefs(tx, session, input);
    if (moved && !input.acknowledgeConflict) {
      await this.writer.assertNoConflict(tx, slot, session.id);
    }
    return courtRefs;
  }

  /** Cancels a scheduled session and its pending reminders; cancelling again changes nothing. */
  async cancel(id: string, input: CancelSessionRequest, client: ClientInfo): Promise<Session> {
    await this.findForWrite(id);
    const reason = input.reason ?? null;
    await this.uow.run(async (tx, afterCommit) => {
      const session = await this.lockForWrite(tx, id);
      if (session.isCancelled) return;
      if (session.outcome) throw notScheduled();
      await tx.session.update({
        where: { id },
        data: { isCancelled: true, cancellationReason: reason },
        select: { id: true },
      });
      await this.reminders.cancel(tx, afterCommit, id);
      await this.writer.event(tx, session.fileId, id, 'SESSION_UPDATED', {
        change: 'CANCELLED',
        sessionType: session.sessionType,
        startsAt: session.startsAt.toISOString(),
      });
      await this.writer.audit(
        tx,
        client,
        session,
        { isCancelled: false },
        { isCancelled: true, cancellationReason: reason },
      );
    });
    return this.sessions.get(id);
  }

  /**
   * Records (or corrects) the outcome and minutes once the session has started; its pending reminders end. A
   * `nextSession` is created and linked in the same transaction (once per session).
   */
  async recordOutcome(
    id: string,
    input: SessionOutcomeRequest,
    client: ClientInfo,
  ): Promise<Session> {
    await this.findForWrite(id);
    const next = input.nextSession;
    await this.uow.run(async (tx, afterCommit) => {
      const session = await this.lockForWrite(tx, id);
      this.assertOutcomeAllowed(session, input);
      const nextSessionId =
        next &&
        (await this.writer.insert(tx, afterCommit, continuation(session, next), client, {
          fieldPrefix: 'nextSession.',
          // A judge carried over from this session may have retired since; they stay on the continuation.
          keepRetiredJudge: next.judgeId === undefined,
          previousSessionId: id,
        }));
      const minutes = input.minutes === undefined ? session.minutes : input.minutes || null;
      await tx.session.update({
        where: { id },
        data: { outcome: input.outcome, minutes, ...(nextSessionId && { nextSessionId }) },
        select: { id: true },
      });
      await this.reminders.cancel(tx, afterCommit, id);
      await this.writer.event(tx, session.fileId, id, 'SESSION_UPDATED', {
        change: 'OUTCOME',
        sessionType: session.sessionType,
        startsAt: session.startsAt.toISOString(),
        outcome: input.outcome,
      });
      await this.writer.audit(
        tx,
        client,
        session,
        { outcome: session.outcome, minutes: session.minutes },
        { outcome: input.outcome, minutes, ...(nextSessionId && { nextSessionId }) },
      );
    });
    return this.sessions.get(id);
  }

  /**
   * Not cancelled (BIZ-012), already started (an outcome of a future hearing is a mistake), and a next session only
   * with `create:session`, once, and after this one.
   */
  private assertOutcomeAllowed(session: SessionState, input: SessionOutcomeRequest): void {
    if (session.isCancelled) throw notScheduled();
    if (session.startsAt > new Date()) {
      throw new ValidationException([{ field: 'outcome', message: 'validation.sessionNotHeld' }]);
    }
    const next = input.nextSession;
    if (!next) return;
    if (!(this.cls.get('permissions') ?? []).includes('create:session')) {
      throw new PermissionDeniedException();
    }
    if (session.nextSessionId) {
      throw new ValidationException([
        { field: 'nextSession', message: 'validation.nextSessionExists' },
      ]);
    }
    if (new Date(next.startsAt) <= session.startsAt) {
      throw new ValidationException([
        { field: 'nextSession.startsAt', message: 'validation.nextSessionBefore' },
      ]);
    }
  }

  /** Sessions on files the caller can see. */
  private visibleWhere(): Prisma.SessionWhereInput {
    return { file: { is: this.files.visibleWhere() } };
  }

  private async find(id: string): Promise<SessionState> {
    const session = await this.prisma.db.session.findFirst({
      where: { AND: [{ id }, this.visibleWhere()] },
      select: STATE_SELECT,
    });
    if (!session) throw new ResourceNotFoundException();
    return session;
  }

  /** The session if the caller may change its file: 404 otherwise, BIZ-007 when the file is archived. */
  private async findForWrite(id: string): Promise<SessionState> {
    const session = await this.find(id);
    await this.files.assertFileAccess(session.fileId, 'write');
    return session;
  }

  /**
   * Inside the write's transaction: the session locked and read again (concurrent writes to it queue and see each
   * other's result), and its file still live and not archived.
   */
  private async lockForWrite(tx: ScopedTransaction, id: string): Promise<SessionState> {
    const session = await this.writer.lockState(tx, id);
    if (!session || session.file.deletedAt) throw new ResourceNotFoundException();
    if (session.file.status === 'ARCHIVED') {
      throw new BusinessRuleException('BIZ-007', 'The file is archived and read-only');
    }
    return session;
  }

  private actorId(): UserId {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }
}

const notScheduled = () =>
  new BusinessRuleException('BIZ-012', 'The session is cancelled or its outcome is recorded');
