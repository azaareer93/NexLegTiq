import {
  CreateSessionSchema,
  SessionOutcomeSchema,
  SessionQuerySchema,
  UpdateSessionSchema,
} from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import type { ReminderScheduler } from './reminder-scheduler';
import { SessionWriter } from './session-writer';
import type { SessionState } from './session-writer';
import type { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import type { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';

const OFFICE = '01920000-0000-7000-8000-0000000000aa';
const ME = '01920000-0000-7000-8000-000000000001';
const LAWYER = '01920000-0000-7000-8000-000000000002';
const FILE = '01920000-0000-7000-8000-0000000000f1';
const ID = '01920000-0000-7000-8000-0000000000a1';
const NEXT = '01920000-0000-7000-8000-0000000000a2';
const CLIENT = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const DAY_MS = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);

const state = (overrides: Partial<SessionState> = {}): SessionState => ({
  id: ID,
  fileId: FILE,
  sessionType: 'HEARING',
  startsAt: inDays(10),
  endsAt: null,
  courtId: null,
  judgeId: null,
  courtRoom: null,
  attendingLawyerId: LAWYER,
  reminderDays: [7, 3, 1],
  outcome: null,
  minutes: null,
  nextSessionId: null,
  isCancelled: false,
  file: { status: 'OPEN', deletedAt: null },
  ...overrides,
});

function setup(row: SessionState = state(), role: Role = 'LAWYER') {
  const context: Partial<RequestContext> = {
    officeId: OFFICE as never,
    userId: ME as never,
    role,
    permissions: permissionsFor(role),
  };
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: LAWYER, role: 'LAWYER' }) },
    legalFile: {
      count: jest.fn().mockResolvedValue(1),
      findFirstOrThrow: jest.fn().mockResolvedValue({ responsibleLawyerId: LAWYER }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    court: { count: jest.fn().mockResolvedValue(1) },
    judge: { count: jest.fn().mockResolvedValue(1) },
    officeSettings: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ courtReminderDays: [7, 3, 1] }),
    },
    session: {
      create: jest.fn().mockResolvedValue({ id: NEXT }),
      update: jest.fn().mockResolvedValue({ id: ID }),
      // lockState: the row read again under its lock.
      findFirst: jest.fn().mockResolvedValue(row),
    },
    caseTimelineEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const uow = {
    run: jest.fn((work: (t: typeof tx, afterCommit: jest.Mock) => unknown) => work(tx, jest.fn())),
  } as unknown as UnitOfWork;
  const cls = {
    get: (key: keyof RequestContext) => context[key],
  } as unknown as ClsService<RequestContext>;
  const prisma = {
    db: { session: { findFirst: jest.fn().mockResolvedValue(row) } },
  } as unknown as PrismaService & { db: { session: { findFirst: jest.Mock } } };
  const files = {
    assertFileAccess: jest.fn().mockResolvedValue({ id: FILE }),
    visibleWhere: () => ({ visible: true }),
  } as unknown as CaseAccessService;
  const repo = {
    get: jest.fn().mockResolvedValue({ id: ID }),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const reminders = { schedule: jest.fn(), cancel: jest.fn(), reset: jest.fn() };
  const scheduler = reminders as unknown as ReminderScheduler;
  const service = new SessionsService(
    cls,
    uow,
    prisma,
    files,
    new SessionWriter(cls, files, scheduler, {
      toUser: jest.fn(),
      toUsers: jest.fn(),
      toOffice: jest.fn(),
    } as unknown as RealtimePublisher),
    repo as unknown as SessionsRepository,
    scheduler,
  );
  return { service, tx, files, repo, prisma, context, reminders };
}

const createBody = (overrides: object = {}) =>
  CreateSessionSchema.parse({
    fileId: FILE,
    attendingLawyerId: LAWYER,
    startsAt: inDays(10).toISOString(),
    ...overrides,
  });

describe('SessionsService', () => {
  describe('create', () => {
    it('should write the session with the office reminder days, its reminders, event and audit row', async () => {
      const { service, tx, files, reminders } = setup();
      await service.create(createBody(), CLIENT);
      expect(files.assertFileAccess).toHaveBeenCalledWith(FILE, 'write');
      expect(tx.$executeRaw).toHaveBeenCalled();
      expect(tx.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          officeId: OFFICE,
          fileId: FILE,
          sessionType: 'HEARING',
          attendingLawyerId: LAWYER,
          reminderDays: [7, 3, 1],
          createdById: ME,
        }),
        select: { id: true },
      });
      expect(reminders.schedule).toHaveBeenCalledWith(
        tx,
        expect.any(Function),
        expect.objectContaining({ id: NEXT, fileId: FILE, attendingLawyerId: LAWYER }),
        [7, 3, 1],
      );
      expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ eventType: 'SESSION_CREATED', sourceType: 'Session' }),
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ entityType: 'Session', action: 'CREATE' }),
      });
    });

    it('should skip the conflict check when acknowledged', async () => {
      const { service, tx } = setup();
      await service.create(createBody({ acknowledgeConflict: true }), CLIENT);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('should refuse an overlapping session with BIZ-004 naming visible files only', async () => {
      const { service, tx } = setup();
      const startsAt = inDays(10);
      tx.$queryRaw.mockResolvedValue([
        { id: 'a', starts_at: startsAt, ends_at: null, file_id: 'seen' },
        { id: 'b', starts_at: startsAt, ends_at: inDays(11), file_id: 'hidden' },
      ]);
      tx.legalFile.findMany.mockResolvedValue([{ id: 'seen', fileNumber: '2026-LIT-00001' }]);
      const error = await service.create(createBody(), CLIENT).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BusinessRuleException);
      expect(error).toMatchObject({
        code: 'BIZ-004',
        details: [
          {
            field: 'startsAt',
            params: { sessionId: 'a', fileNumber: '2026-LIT-00001', endsAt: null },
          },
          // On a file the caller cannot see: only the time.
          { field: 'startsAt', params: { sessionId: null, fileNumber: null } },
        ],
      });
      expect(tx.session.create).not.toHaveBeenCalled();
    });

    it('should refuse an attending lawyer who cannot hold hearings or see the file', async () => {
      const { service, tx } = setup();
      tx.user.findFirst.mockResolvedValue({ id: LAWYER, role: 'PARALEGAL' });
      await expect(service.create(createBody(), CLIENT)).rejects.toMatchObject({
        details: [{ field: 'attendingLawyerId', message: 'validation.attendingLawyer' }],
      });
      tx.user.findFirst.mockResolvedValue(null);
      await expect(service.create(createBody(), CLIENT)).rejects.toBeInstanceOf(
        ValidationException,
      );
    });
  });

  describe('reads', () => {
    it('should default the calendar to 31 days from now and resolve lawyerId=me', async () => {
      const { service, repo } = setup();
      await service.list(SessionQuerySchema.parse({ lawyerId: 'me' }));
      const [where] = repo.findMany.mock.calls[0] as [{ AND: object[] }];
      const range = where.AND[1] as { startsAt: { gte: Date; lt: Date } };
      expect(range.startsAt.lt.getTime() - range.startsAt.gte.getTime()).toBe(31 * DAY_MS);
      expect(where.AND).toContainEqual({ attendingLawyerId: ME });
    });

    it('should list upcoming sessions soonest first and past ones latest first', async () => {
      const { service, repo, files } = setup();
      await service.listForFile(FILE, { when: 'upcoming', page: 1, limit: 20 });
      await service.listForFile(FILE, { when: 'past', page: 2, limit: 10 });
      expect(files.assertFileAccess).toHaveBeenCalledWith(FILE, 'read');
      expect(repo.findMany.mock.calls[0]?.[1]).toEqual([{ startsAt: 'asc' }, { id: 'asc' }]);
      expect(repo.findMany.mock.calls[1]?.[1]).toEqual([{ startsAt: 'desc' }, { id: 'desc' }]);
      expect(repo.findMany.mock.calls[1]?.[2]).toEqual({ skip: 10, take: 10 });
    });

    it('should 404 a session the caller cannot see', async () => {
      const { service, prisma } = setup();
      prisma.db.session.findFirst.mockResolvedValue(null);
      await expect(service.get(ID)).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });

  describe('update', () => {
    const patch = (body: object) => UpdateSessionSchema.parse(body);

    it('should do nothing when nothing changes', async () => {
      const { service, tx } = setup();
      await service.update(ID, patch({ reminderDays: [1, 3, 7] }), CLIENT);
      expect(tx.session.update).not.toHaveBeenCalled();
    });

    it('should reschedule: re-check conflicts, replace pending reminders and audit old and new values', async () => {
      const { service, tx, reminders } = setup();
      const startsAt = inDays(20).toISOString();
      await service.update(ID, patch({ startsAt }), CLIENT);
      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.session.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { startsAt: new Date(startsAt) },
        select: { id: true },
      });
      expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ startsAt: new Date(startsAt).toISOString() }),
        }),
      });
      expect(reminders.reset).toHaveBeenCalledWith(
        tx,
        expect.any(Function),
        expect.objectContaining({ id: ID, fileId: FILE, startsAt: new Date(startsAt) }),
        [7, 3, 1],
        true,
      );
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'UPDATE',
          newValues: { fileId: FILE, startsAt },
        }),
      });
    });

    it('should audit a judge dropped with a new court, and not re-check conflicts for the room', async () => {
      const { service, tx } = setup(state({ courtId: 'c1', judgeId: 'j1' }));
      await service.update(ID, patch({ courtId: '01920000-0000-7000-8000-0000000000c2' }), CLIENT);
      expect(tx.$executeRaw).not.toHaveBeenCalled(); // no conflict check, so no lawyer lock
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          oldValues: { courtId: 'c1', judgeId: 'j1' },
          newValues: {
            fileId: FILE,
            courtId: '01920000-0000-7000-8000-0000000000c2',
            judgeId: null,
          },
        }),
      });
    });

    it('should replace the reminders for a new attending lawyer, not for a new room', async () => {
      const { service, tx, reminders } = setup();
      tx.user.findFirst.mockResolvedValue({ id: ME, role: 'LAWYER' });
      await service.update(ID, patch({ courtRoom: 'Hall 9' }), CLIENT);
      expect(reminders.reset).not.toHaveBeenCalled();
      await service.update(ID, patch({ attendingLawyerId: ME }), CLIENT);
      expect(reminders.reset).toHaveBeenCalledWith(
        tx,
        expect.any(Function),
        expect.objectContaining({ id: ID, attendingLawyerId: ME }),
        [7, 3, 1],
        false,
      );
    });

    it('should check a new attending lawyer and refuse an end before the start', async () => {
      const { service, tx } = setup();
      tx.user.findFirst.mockResolvedValue(null);
      await expect(
        service.update(ID, patch({ attendingLawyerId: ME }), CLIENT),
      ).rejects.toBeInstanceOf(ValidationException);
      await expect(
        service.update(ID, patch({ endsAt: inDays(5).toISOString() }), CLIENT),
      ).rejects.toMatchObject({ details: [{ field: 'endsAt' }] });
    });

    it('should refuse a cancelled or held session, also when it changes concurrently (BIZ-012)', async () => {
      for (const row of [state({ isCancelled: true }), state({ outcome: 'DECIDED' })]) {
        const { service } = setup(row);
        await expect(service.update(ID, patch({ courtRoom: 'x' }), CLIENT)).rejects.toMatchObject({
          code: 'BIZ-012',
        });
      }
      // Read again under the lock: a session cancelled meanwhile is refused too.
      const { service, tx } = setup();
      tx.session.findFirst.mockResolvedValue(state({ isCancelled: true }));
      await expect(service.update(ID, patch({ courtRoom: 'x' }), CLIENT)).rejects.toMatchObject({
        code: 'BIZ-012',
      });
    });

    it('should audit an acknowledged conflict and refuse a session that is too long', async () => {
      const { service, tx } = setup();
      const startsAt = inDays(20).toISOString();
      await service.update(ID, patch({ startsAt, acknowledgeConflict: true }), CLIENT);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          newValues: { fileId: FILE, startsAt, acknowledgeConflict: true },
        }),
      });
      await expect(
        service.update(ID, patch({ endsAt: inDays(11.5).toISOString() }), CLIENT),
      ).rejects.toMatchObject({ details: [{ message: 'validation.sessionTooLong' }] });
    });

    it('should refuse when the file was archived or deleted meanwhile', async () => {
      const archived = setup();
      archived.tx.session.findFirst.mockResolvedValue(
        state({ file: { status: 'ARCHIVED', deletedAt: null } }),
      );
      await expect(
        archived.service.update(ID, patch({ courtRoom: 'x' }), CLIENT),
      ).rejects.toMatchObject({ code: 'BIZ-007' });
      const deleted = setup();
      deleted.tx.session.findFirst.mockResolvedValue(
        state({ file: { status: 'OPEN', deletedAt: new Date() } }),
      );
      await expect(
        deleted.service.update(ID, patch({ courtRoom: 'x' }), CLIENT),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });

  describe('cancel', () => {
    it('should cancel the session and its pending reminders', async () => {
      const { service, tx, reminders } = setup();
      await service.cancel(ID, { reason: 'Strike' }, CLIENT);
      expect(tx.session.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { isCancelled: true, cancellationReason: 'Strike' },
        select: { id: true },
      });
      expect(reminders.cancel).toHaveBeenCalledWith(tx, expect.any(Function), ID);
      expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ change: 'CANCELLED' }),
        }),
      });
    });

    it('should change nothing when already cancelled and refuse a held session', async () => {
      const cancelled = setup(state({ isCancelled: true }));
      await cancelled.service.cancel(ID, {}, CLIENT);
      expect(cancelled.tx.session.update).not.toHaveBeenCalled();
      const held = setup(state({ outcome: 'DECIDED' }));
      await expect(held.service.cancel(ID, {}, CLIENT)).rejects.toMatchObject({ code: 'BIZ-012' });
      const gone = setup();
      gone.tx.session.findFirst.mockResolvedValue(null);
      await expect(gone.service.cancel(ID, {}, CLIENT)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });
  });

  describe('recordOutcome', () => {
    const held = () => state({ startsAt: inDays(-1), courtId: 'c1', judgeId: 'j1' });
    const body = (overrides: object = {}) =>
      SessionOutcomeSchema.parse({ outcome: 'ADJOURNED', minutes: 'Adjourned.', ...overrides });

    it('should record the outcome, end the pending reminders and link a new next session', async () => {
      const { service, tx, reminders } = setup(held());
      await service.recordOutcome(
        ID,
        body({ nextSession: { startsAt: inDays(30).toISOString() } }),
        CLIENT,
      );
      expect(tx.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ courtId: 'c1', judgeId: 'j1', attendingLawyerId: LAWYER }),
        select: { id: true },
      });
      // The carried-over judge need not be active any more.
      expect(tx.judge.count).toHaveBeenCalledWith({ where: { id: 'j1', courtId: 'c1' } });
      expect(tx.session.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { outcome: 'ADJOURNED', minutes: 'Adjourned.', nextSessionId: NEXT },
        select: { id: true },
      });
      // The next session's audit row names the session it continues.
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'CREATE',
          newValues: expect.objectContaining({ previousSessionId: ID }),
        }),
      });
      expect(reminders.cancel).toHaveBeenCalledWith(tx, expect.any(Function), ID);
      expect(reminders.schedule).toHaveBeenCalledWith(
        tx,
        expect.any(Function),
        expect.objectContaining({ id: NEXT }),
        [7, 3, 1],
      );
    });

    it('should keep the minutes when none are sent and clear them when empty', async () => {
      const { service, tx } = setup({ ...held(), minutes: 'Old' });
      await service.recordOutcome(ID, SessionOutcomeSchema.parse({ outcome: 'DECIDED' }), CLIENT);
      await service.recordOutcome(ID, body({ minutes: '' }), CLIENT);
      expect(
        tx.session.update.mock.calls.map((call) => (call[0] as { data: object }).data),
      ).toEqual([
        { outcome: 'DECIDED', minutes: 'Old' },
        { outcome: 'ADJOURNED', minutes: null },
      ]);
    });

    it('should refuse a cancelled or future session and a bad next session', async () => {
      await expect(
        setup(state({ isCancelled: true })).service.recordOutcome(ID, body(), CLIENT),
      ).rejects.toMatchObject({ code: 'BIZ-012' });
      await expect(setup().service.recordOutcome(ID, body(), CLIENT)).rejects.toMatchObject({
        details: [{ field: 'outcome', message: 'validation.sessionNotHeld' }],
      });
      const linked = setup({ ...held(), nextSessionId: NEXT });
      await expect(
        linked.service.recordOutcome(
          ID,
          body({ nextSession: { startsAt: inDays(30).toISOString() } }),
          CLIENT,
        ),
      ).rejects.toMatchObject({ details: [{ message: 'validation.nextSessionExists' }] });
      await expect(
        setup(held()).service.recordOutcome(
          ID,
          body({ nextSession: { startsAt: inDays(-2).toISOString() } }),
          CLIENT,
        ),
      ).rejects.toMatchObject({ details: [{ field: 'nextSession.startsAt' }] });
    });

    it('should need create:session for a next session, and report a concurrent change', async () => {
      const paralegal = setup(held(), 'PARALEGAL');
      await expect(
        paralegal.service.recordOutcome(
          ID,
          body({ nextSession: { startsAt: inDays(30).toISOString() } }),
          CLIENT,
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedException);
      // Cancelled between the access check and the lock.
      const raced = setup(held());
      raced.tx.session.findFirst.mockResolvedValue({ ...held(), isCancelled: true });
      await expect(raced.service.recordOutcome(ID, body(), CLIENT)).rejects.toMatchObject({
        code: 'BIZ-012',
      });
    });
  });
});
