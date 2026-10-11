import {
  CreateSessionSchema,
  SessionOutcomeSchema,
  SessionQuerySchema,
  UpdateSessionSchema,
} from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import { SessionWriter } from './session-writer';
import type { SessionState } from './session-writer';
import type { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
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
      findMany: jest.fn().mockResolvedValue([]),
    },
    court: { count: jest.fn().mockResolvedValue(1) },
    judge: { count: jest.fn().mockResolvedValue(1) },
    officeSettings: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ courtReminderDays: [7, 3, 1] }),
    },
    session: {
      create: jest.fn().mockResolvedValue({ id: NEXT }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    sessionReminder: { createMany: jest.fn(), updateMany: jest.fn() },
    caseTimelineEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const uow = {
    run: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
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
  const service = new SessionsService(
    cls,
    uow,
    prisma,
    files,
    new SessionWriter(cls, files),
    repo as unknown as SessionsRepository,
  );
  return { service, tx, files, repo, prisma, context };
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
      const { service, tx, files } = setup();
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
      expect(tx.sessionReminder.createMany).toHaveBeenCalledWith({
        data: [7, 3, 1].map((daysBefore) =>
          expect.objectContaining({ daysBefore, officeId: OFFICE, sessionId: NEXT }),
        ),
      });
      expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ eventType: 'SESSION_CREATED', sourceType: 'Session' }),
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ entityType: 'Session', action: 'CREATE' }),
      });
    });

    it('should write no reminder when every offset is past, and skip the conflict check when acknowledged', async () => {
      const { service, tx } = setup();
      await service.create(
        createBody({ startsAt: inDays(-1).toISOString(), acknowledgeConflict: true }),
        CLIENT,
      );
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.sessionReminder.createMany).not.toHaveBeenCalled();
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
          { field: 'startsAt', params: { sessionId: 'b', fileNumber: null } },
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
      expect(tx.session.updateMany).not.toHaveBeenCalled();
    });

    it('should reschedule: re-check conflicts, replace pending reminders and audit old and new values', async () => {
      const { service, tx } = setup();
      const startsAt = inDays(20).toISOString();
      await service.update(ID, patch({ startsAt }), CLIENT);
      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.session.updateMany).toHaveBeenCalledWith({
        where: { id: ID, isCancelled: false, outcome: null },
        data: expect.objectContaining({ startsAt: new Date(startsAt) }),
      });
      expect(tx.sessionReminder.updateMany).toHaveBeenCalledWith({
        where: { sessionId: ID, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      expect(tx.sessionReminder.createMany).toHaveBeenCalled();
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'UPDATE',
          newValues: { startsAt },
        }),
      });
    });

    it('should audit a judge dropped with a new court, and not re-check conflicts for the room', async () => {
      const { service, tx } = setup(state({ courtId: 'c1', judgeId: 'j1' }));
      await service.update(ID, patch({ courtId: '01920000-0000-7000-8000-0000000000c2' }), CLIENT);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          oldValues: { courtId: 'c1', judgeId: 'j1' },
          newValues: { courtId: '01920000-0000-7000-8000-0000000000c2', judgeId: null },
        }),
      });
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
      const { service, tx } = setup();
      tx.session.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update(ID, patch({ courtRoom: 'x' }), CLIENT)).rejects.toMatchObject({
        code: 'BIZ-012',
      });
    });
  });

  describe('cancel', () => {
    it('should cancel the session and its pending reminders', async () => {
      const { service, tx } = setup();
      await service.cancel(ID, { reason: 'Strike' }, CLIENT);
      expect(tx.session.updateMany).toHaveBeenCalledWith({
        where: { id: ID, isCancelled: false, outcome: null },
        data: { isCancelled: true, cancellationReason: 'Strike' },
      });
      expect(tx.sessionReminder.updateMany).toHaveBeenCalled();
      expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ change: 'CANCELLED' }),
        }),
      });
    });

    it('should change nothing when already cancelled and refuse a held session', async () => {
      const cancelled = setup(state({ isCancelled: true }));
      await cancelled.service.cancel(ID, {}, CLIENT);
      expect(cancelled.tx.session.updateMany).not.toHaveBeenCalled();
      const held = setup(state({ outcome: 'DECIDED' }));
      await expect(held.service.cancel(ID, {}, CLIENT)).rejects.toMatchObject({ code: 'BIZ-012' });
      const raced = setup();
      raced.tx.session.updateMany.mockResolvedValue({ count: 0 });
      await expect(raced.service.cancel(ID, {}, CLIENT)).rejects.toMatchObject({
        code: 'BIZ-012',
      });
    });
  });

  describe('recordOutcome', () => {
    const held = () => state({ startsAt: inDays(-1), courtId: 'c1', judgeId: 'j1' });
    const body = (overrides: object = {}) =>
      SessionOutcomeSchema.parse({ outcome: 'ADJOURNED', minutes: 'Adjourned.', ...overrides });

    it('should record the outcome, end the pending reminders and link a new next session', async () => {
      const { service, tx } = setup(held());
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
      expect(tx.session.updateMany).toHaveBeenCalledWith({
        where: { id: ID, isCancelled: false, nextSessionId: null },
        data: { outcome: 'ADJOURNED', minutes: 'Adjourned.', nextSessionId: NEXT },
      });
      expect(tx.sessionReminder.updateMany).toHaveBeenCalled();
    });

    it('should keep the minutes when none are sent and clear them when empty', async () => {
      const { service, tx } = setup({ ...held(), minutes: 'Old' });
      await service.recordOutcome(ID, SessionOutcomeSchema.parse({ outcome: 'DECIDED' }), CLIENT);
      await service.recordOutcome(ID, body({ minutes: '' }), CLIENT);
      expect(
        tx.session.updateMany.mock.calls.map((call) => (call[0] as { data: object }).data),
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
      const raced = setup(held());
      raced.tx.session.updateMany.mockResolvedValue({ count: 0 });
      await expect(raced.service.recordOutcome(ID, body(), CLIENT)).rejects.toBeInstanceOf(
        ResourceConflictException,
      );
    });
  });
});
