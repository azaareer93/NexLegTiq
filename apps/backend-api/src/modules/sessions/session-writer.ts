import { Injectable } from '@nestjs/common';
import type { ApiErrorDetail, UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { ReminderScheduler } from './reminder-scheduler';
import { effectiveEnd, MAX_SESSION_MS } from './session-rules';
import type { RequestContext } from '../../common/context/request-context';
import { BusinessRuleException, ValidationException } from '../../common/errors/app.exception';
import type { AfterCommit, ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';
import { assertCourtRefs } from '../courts/court-refs';
import { CaseAccessService } from '../legal-files/case-access.service';

export const STATE_SELECT = {
  id: true,
  fileId: true,
  sessionType: true,
  startsAt: true,
  endsAt: true,
  courtId: true,
  judgeId: true,
  courtRoom: true,
  attendingLawyerId: true,
  reminderDays: true,
  outcome: true,
  minutes: true,
  nextSessionId: true,
  isCancelled: true,
  file: { select: { status: true, deletedAt: true } },
} satisfies Prisma.SessionSelect;
/** What the write routes read of a session before changing it. */
export type SessionState = Prisma.SessionGetPayload<{ select: typeof STATE_SELECT }>;

/** When and for whom a session is: what the conflict check compares. */
export interface Slot {
  readonly attendingLawyerId: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

/** A session to create: from `POST /sessions`, or the next session of an outcome with its defaults filled in. */
export interface NewSession extends Slot {
  readonly fileId: string;
  readonly sessionType: SessionState['sessionType'];
  readonly courtId: string | null;
  readonly judgeId: string | null;
  readonly courtRoom: string | null;
  /** Office default (`courtReminderDays`) when undefined. */
  readonly reminderDays: readonly number[] | undefined;
  readonly acknowledgeConflict: boolean;
}

type TimelineType = 'SESSION_CREATED' | 'SESSION_UPDATED';

/**
 * The writes every session route shares (D-116): checks, the row, its reminders, the file's timeline and the audit
 * log — always inside the caller's transaction.
 */
@Injectable()
export class SessionWriter {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly files: CaseAccessService,
    private readonly reminders: ReminderScheduler,
  ) {}

  /**
   * Checks and writes one session with its reminders (jobs enqueued after the commit), SESSION_CREATED event and audit
   * row; returns its id.
   */
  async insert(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    input: NewSession,
    client: ClientInfo,
    { fieldPrefix = '', keepRetiredJudge = false, previousSessionId = '' } = {},
  ): Promise<string> {
    await assertAttendingLawyer(tx, input.attendingLawyerId, input.fileId, fieldPrefix);
    await assertCourtRefs(tx, input, !keepRetiredJudge, fieldPrefix);
    if (!input.acknowledgeConflict) await this.assertNoConflict(tx, input, null, fieldPrefix);
    const reminderDays =
      input.reminderDays ??
      (await tx.officeSettings.findFirstOrThrow({ select: { courtReminderDays: true } }))
        .courtReminderDays;
    const { id } = await tx.session.create({
      data: {
        officeId: this.officeId(),
        fileId: input.fileId,
        sessionType: input.sessionType,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        courtId: input.courtId,
        judgeId: input.judgeId,
        courtRoom: input.courtRoom,
        attendingLawyerId: input.attendingLawyerId,
        reminderDays: [...reminderDays],
        createdById: this.actorId(),
      },
      select: { id: true },
    });
    await this.reminders.schedule(tx, afterCommit, { ...input, id }, reminderDays);
    await this.event(tx, input.fileId, id, 'SESSION_CREATED', {
      sessionType: input.sessionType,
      startsAt: input.startsAt.toISOString(),
    });
    await this.audit(
      tx,
      client,
      { id, fileId: input.fileId },
      null,
      createdValues(input, reminderDays, previousSessionId),
    );
    return id;
  }

  /**
   * 409 BIZ-004 when the attending lawyer has another live session (not cancelled, file not deleted) overlapping
   * [startsAt, end) — end = endsAt or one hour; touching intervals do not overlap. Concurrent writes for the same lawyer
   * queue on a transaction-scoped advisory lock, so two overlapping writes cannot both pass. Details list up to 5
   * conflicting sessions; one on a file the caller cannot see shows only its time (no id, no file number).
   */
  async assertNoConflict(
    tx: ScopedTransaction,
    slot: Slot,
    excludeId: string | null,
    fieldPrefix = '',
  ): Promise<void> {
    const end = effectiveEnd(slot.startsAt, slot.endsAt);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`session-slot:${slot.attendingLawyerId}`}, 0))`;
    // Sessions last at most MAX_SESSION_HOURS (CHECK), so earlier starts cannot overlap: the index range stays short.
    const rows = await tx.$queryRaw<
      { id: string; starts_at: Date; ends_at: Date | null; file_id: string }[]
    >`
      SELECT s.id, s.starts_at, s.ends_at, s.file_id FROM sessions s
      WHERE s.office_id = ${this.officeId()}::uuid
        AND s.attending_lawyer_id = ${slot.attendingLawyerId}::uuid
        AND NOT s.is_cancelled
        AND (${excludeId}::uuid IS NULL OR s.id <> ${excludeId}::uuid)
        AND s.starts_at < ${end}
        AND s.starts_at > ${new Date(slot.startsAt.getTime() - MAX_SESSION_MS)}
        AND COALESCE(s.ends_at, s.starts_at + interval '1 hour') > ${slot.startsAt}
        AND EXISTS (
          SELECT 1 FROM legal_files f
          WHERE f.id = s.file_id AND f.office_id = s.office_id AND f.deleted_at IS NULL
        )
      ORDER BY s.starts_at, s.id
      LIMIT 5`;
    if (rows.length === 0) return;
    const visible = await tx.legalFile.findMany({
      where: { AND: [{ id: { in: rows.map((row) => row.file_id) } }, this.files.visibleWhere()] },
      select: { id: true, fileNumber: true },
    });
    const numbers = new Map(visible.map((file) => [file.id, file.fileNumber]));
    const details: ApiErrorDetail[] = rows.map((row) => {
      const fileNumber = numbers.get(row.file_id);
      return {
        field: `${fieldPrefix}startsAt`,
        message: 'validation.sessionConflict',
        params: {
          sessionId: fileNumber ? row.id : null,
          startsAt: row.starts_at.toISOString(),
          endsAt: row.ends_at?.toISOString() ?? null,
          fileNumber: fileNumber ?? null,
        },
      };
    });
    throw new BusinessRuleException(
      'BIZ-004',
      'The attending lawyer has another session at that time',
      details,
    );
  }

  /**
   * Locks the session row until the transaction ends and reads it again, so a write works on the current state and
   * concurrent writes to one session queue (D-116). Null when it is gone.
   */
  async lockState(tx: ScopedTransaction, id: string): Promise<SessionState | null> {
    await tx.$queryRaw`SELECT 1 FROM sessions WHERE id = ${id}::uuid AND office_id = ${this.officeId()}::uuid FOR UPDATE`;
    return tx.session.findFirst({ where: { id }, select: STATE_SELECT });
  }

  async event(
    tx: ScopedTransaction,
    fileId: string,
    sessionId: string,
    eventType: TimelineType,
    payload: Record<string, string>,
  ): Promise<void> {
    await tx.caseTimelineEvent.create({
      data: {
        officeId: this.officeId(),
        fileId,
        eventType,
        sourceType: 'Session',
        sourceId: sessionId,
        actorId: this.actorId(),
        payload,
      },
    });
  }

  /**
   * A CREATE row without old values, else an UPDATE row. `newValues` always carries the file, so an audit viewer can
   * hide the rows of files its reader cannot see (minutes of a confidential file, D-096).
   */
  async audit(
    tx: ScopedTransaction,
    client: ClientInfo,
    session: { readonly id: string; readonly fileId: string },
    oldValues: object | null,
    newValues: object,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        officeId: this.officeId(),
        userId: this.actorId(),
        entityType: 'Session',
        entityId: session.id,
        action: oldValues ? 'UPDATE' : 'CREATE',
        ...(oldValues && { oldValues: JSON.parse(JSON.stringify(oldValues)) as object }),
        newValues: JSON.parse(JSON.stringify({ fileId: session.fileId, ...newValues })) as object,
        ipAddress: client.ip,
        userAgent: truncateUserAgent(client.userAgent),
        requestId: client.requestId,
      },
    });
  }

  // A missing caller is a programming error (guarded routes always set it): 500 SYS-001, never a 403 that hides it.
  private actorId(): UserId {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}

/**
 * The attending lawyer must be an active colleague who may hold hearings (`create:session`: office manager, senior
 * lawyer, lawyer) and sees the file by their own scope — otherwise 400 VAL-001 on `attendingLawyerId`.
 */
export async function assertAttendingLawyer(
  tx: ScopedTransaction,
  userId: string,
  fileId: string,
  fieldPrefix = '',
): Promise<void> {
  if (!(await CaseAccessService.colleagueMay(tx, userId, 'create:session', fileId))) {
    throw new ValidationException([
      { field: `${fieldPrefix}attendingLawyerId`, message: 'validation.attendingLawyer' },
    ]);
  }
}

/** The CREATE audit row of a session: everything it was created with. */
function createdValues(
  input: NewSession,
  reminderDays: readonly number[],
  previousSessionId: string,
): Record<string, unknown> {
  return {
    sessionType: input.sessionType,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt?.toISOString() ?? null,
    courtId: input.courtId,
    judgeId: input.judgeId,
    courtRoom: input.courtRoom,
    attendingLawyerId: input.attendingLawyerId,
    reminderDays,
    ...(previousSessionId && { previousSessionId }),
    ...(input.acknowledgeConflict && { acknowledgeConflict: true }),
  };
}
