import { Injectable } from '@nestjs/common';
import type {
  CancelSessionRequest,
  CreateSessionRequest,
  FileSessionsQuery,
  Session,
  SessionOutcomeRequest,
  SessionQuery,
  UpdateSessionRequest,
} from '@nexlegtiq/shared-contracts';
import type { UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { changes, continuation, toDate } from './session-rules';
import { assertAttendingLawyer, SessionWriter, STATE_SELECT } from './session-writer';
import type { SessionState } from './session-writer';
import { SessionsRepository } from './sessions.repository';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { nextCourtRefs } from '../courts/court-refs';
import { CaseAccessService } from '../legal-files/case-access.service';

/** Calendar default window (SessionQuerySchema). */
const DEFAULT_RANGE_MS = 31 * 86_400_000;
/** Changing any of these re-runs the conflict check. */
const SLOT_FIELDS = ['startsAt', 'endsAt', 'attendingLawyerId'];

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
  ) {}

  async create(input: CreateSessionRequest, client: ClientInfo): Promise<Session> {
    await this.files.assertFileAccess(input.fileId, 'write');
    const id = await this.uow.run((tx) =>
      this.writer.insert(
        tx,
        {
          ...input,
          startsAt: new Date(input.startsAt),
          endsAt: toDate(input.endsAt),
          courtId: input.courtId ?? null,
          judgeId: input.judgeId ?? null,
          courtRoom: input.courtRoom ?? null,
          reminderDays: input.reminderDays,
        },
        client,
      ),
    );
    return this.sessions.get(id);
  }

  /** The calendar: sessions starting in [from, to) on files the caller can see. */
  list(query: SessionQuery): Promise<Session[]> {
    const from = query.from ? new Date(query.from) : new Date();
    const to = query.to ? new Date(query.to) : new Date(from.getTime() + DEFAULT_RANGE_MS);
    const lawyerId = query.lawyerId === 'me' ? this.actorId() : query.lawyerId;
    return this.sessions.findMany(
      {
        AND: [
          this.visibleWhere(),
          { startsAt: { gte: from, lt: to } },
          ...(lawyerId ? [{ attendingLawyerId: lawyerId }] : []),
          ...(query.fileId ? [{ fileId: query.fileId }] : []),
        ],
      },
      [{ startsAt: 'asc' }, { id: 'asc' }],
      // ponytail: a 92-day window of one office stays far below this; paginate if an office ever reaches it.
      { skip: 0, take: 2000 },
    );
  }

  /** A file's sessions: upcoming soonest first, or past latest first. */
  async listForFile(fileId: string, query: FileSessionsQuery): Promise<PaginatedResult<Session>> {
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
    const session = await this.findForWrite(id);
    if (session.isCancelled || session.outcome) throw notScheduled();
    const { acknowledgeConflict, ...wanted } = input;
    const { old, next } = changes(session, wanted);
    if (Object.keys(next).length === 0) return this.sessions.get(id);
    const slot = {
      startsAt: input.startsAt ? new Date(input.startsAt) : session.startsAt,
      endsAt: input.endsAt === undefined ? session.endsAt : toDate(input.endsAt),
      attendingLawyerId: input.attendingLawyerId ?? session.attendingLawyerId,
    };
    if (slot.endsAt && slot.endsAt <= slot.startsAt) {
      throw new ValidationException([{ field: 'endsAt', message: 'validation.endsBeforeStart' }]);
    }
    await this.uow.run(async (tx) => {
      if ('attendingLawyerId' in next) {
        await assertAttendingLawyer(tx, slot.attendingLawyerId, session.fileId);
      }
      const courtRefs = await nextCourtRefs(tx, session, input);
      if (!acknowledgeConflict && SLOT_FIELDS.some((field) => field in next)) {
        await this.writer.assertNoConflict(tx, slot, id);
      }
      const { count } = await tx.session.updateMany({
        where: { id, isCancelled: false, outcome: null },
        data: { ...(next as Prisma.SessionUpdateManyMutationInput), ...courtRefs, ...slot },
      });
      if (count === 0) throw notScheduled();
      if ('startsAt' in next || 'reminderDays' in next) {
        await this.writer.resetReminders(
          tx,
          id,
          slot.startsAt,
          input.reminderDays ?? session.reminderDays,
        );
      }
      auditJudge(old, next, session.judgeId, courtRefs.judgeId);
      await this.writer.event(tx, session.fileId, id, 'SESSION_UPDATED', {
        change: 'UPDATED',
        sessionType: input.sessionType ?? session.sessionType,
        startsAt: slot.startsAt.toISOString(),
      });
      await this.writer.audit(tx, client, id, old, next);
    });
    return this.sessions.get(id);
  }

  /** Cancels a scheduled session and its pending reminders; cancelling again changes nothing. */
  async cancel(id: string, input: CancelSessionRequest, client: ClientInfo): Promise<Session> {
    const session = await this.findForWrite(id);
    if (session.isCancelled) return this.sessions.get(id);
    if (session.outcome) throw notScheduled();
    const reason = input.reason ?? null;
    await this.uow.run(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id, isCancelled: false, outcome: null },
        data: { isCancelled: true, cancellationReason: reason },
      });
      if (count === 0) throw notScheduled();
      await this.writer.cancelReminders(tx, id);
      await this.writer.event(tx, session.fileId, id, 'SESSION_UPDATED', {
        change: 'CANCELLED',
        sessionType: session.sessionType,
        startsAt: session.startsAt.toISOString(),
      });
      await this.writer.audit(
        tx,
        client,
        id,
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
    const session = await this.findForWrite(id);
    this.assertOutcomeAllowed(session, input);
    const next = input.nextSession;
    await this.uow.run(async (tx) => {
      const nextSessionId =
        next &&
        (await this.writer.insert(tx, continuation(session, next), client, {
          fieldPrefix: 'nextSession.',
          // A judge carried over from this session may have retired since; they stay on the continuation.
          keepRetiredJudge: next.judgeId === undefined,
        }));
      const minutes = input.minutes === undefined ? session.minutes : input.minutes || null;
      const { count } = await tx.session.updateMany({
        where: { id, isCancelled: false, ...(nextSessionId && { nextSessionId: null }) },
        data: { outcome: input.outcome, minutes, ...(nextSessionId && { nextSessionId }) },
      });
      if (count === 0) throw new ResourceConflictException('RES-003');
      await this.writer.cancelReminders(tx, id);
      await this.writer.event(tx, session.fileId, id, 'SESSION_UPDATED', {
        change: 'OUTCOME',
        sessionType: session.sessionType,
        startsAt: session.startsAt.toISOString(),
        outcome: input.outcome,
      });
      await this.writer.audit(
        tx,
        client,
        id,
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

  private actorId(): UserId {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }
}

/** A new court without a judge also drops the old court's judge (nextCourtRefs): the audit row says so too. */
function auditJudge(
  old: Record<string, unknown>,
  next: Record<string, unknown>,
  before: string | null,
  after: string | null | undefined,
): void {
  if (after === undefined || after === before) return;
  old['judgeId'] = before;
  next['judgeId'] = after;
}

const notScheduled = () =>
  new BusinessRuleException('BIZ-012', 'The session is cancelled or its outcome is recorded');
