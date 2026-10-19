import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { zonedInstant } from './session-rules';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { getQueue, QUEUE } from '../../common/queue/queues';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };

interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}

type SessionBody = Record<string, unknown> & { id: string; startsAt: string };
type ErrorBody = { error: { code: string; details?: { field: string; params?: object }[] } };

const DAY_MS = 86_400_000;
/** Midnight UTC of today: every test books its own day, so sessions of different tests never overlap. */
const TODAY = Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
);
let nextDay = 10;
/** A fresh day `nextDay` days ahead; `at(hour, minute)` gives an instant on it. */
const freshDay = () => {
  const day = TODAY + nextDay++ * DAY_MS;
  return (hour: number, minute = 0) =>
    new Date(day + hour * 3_600_000 + minute * 60_000).toISOString();
};

/** 09:00 Hebron time `days` calendar days before the UTC date of `startsAt` (a daytime hearing: same local date). */
const nineAm = (startsAt: string, days: number) => {
  const date = new Date(startsAt);
  return zonedInstant(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate() - days,
    9,
    'Asia/Hebron',
  );
};

/** MVP-67 through HTTP on real PostgreSQL: hearings, conflicts, reminders, outcomes, calendar, access (D-116). */
describe('sessions API (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  const users: Record<string, SeededUser> = {};
  let officeId: string;
  let otherOffice: SeededUser;
  /** Responsible lawyer `lawyer`, paralegal `paralegal`, team members `trainee` and `lawyer2`. */
  let fileId: string;
  let fileNumber: string;
  /** Confidential, assigned to `lawyer2` only. */
  let secretFileId: string;
  let courtId: string;

  const http = () => request(app.getHttpServer());
  const user = (key: string) => users[key] as SeededUser;
  const as = (key: string) => bearerFor(jwt, user(key));

  async function seedUser(office: string, role: Role): Promise<SeededUser> {
    const created = await raw.user.create({
      data: {
        officeId: office,
        fullName: `${role} ${randomUUID().slice(0, 4)}`,
        email: `sessions-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: created.id, officeId: office, role };
  }

  async function seedOffice(name: string): Promise<string> {
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(office.id);
    return office.id;
  }

  async function seedFile(lawyer: string, team: string[] = [], extra: object = {}) {
    const file = await raw.legalFile.create({
      data: {
        officeId,
        fileNumber: `S-${randomUUID()}`,
        title: 'Sessions test file',
        fileType: 'LITIGATION',
        responsibleLawyerId: user(lawyer).userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
        ...extra,
      },
    });
    for (const key of [lawyer, ...team]) {
      await raw.fileTeamMember.create({
        data: { officeId, fileId: file.id, userId: user(key).userId },
      });
    }
    return file;
  }

  const create = (key: string, body: Record<string, unknown>) =>
    http().post('/api/v1/sessions').set(as(key)).send(body);

  async function session(body: Record<string, unknown>, key = 'lawyer'): Promise<SessionBody> {
    const res = await create(key, { fileId, attendingLawyerId: user('lawyer').userId, ...body });
    expect(res.status).toBe(201);
    return (res.body as { data: SessionBody }).data;
  }

  const expectError = (res: request.Response, status: number, code: string) =>
    expect({ status: res.status, body: res.body as unknown }).toMatchObject({
      status,
      body: { error: { code } },
    });

  const reminders = (sessionId: string) =>
    raw.sessionReminder.findMany({
      where: { sessionId },
      orderBy: [{ status: 'asc' }, { daysBefore: 'desc' }],
      select: { daysBefore: true, status: true, scheduledFor: true },
    });

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      EMAIL_VERIFICATION_ENFORCED: 'false',
      // Reminder jobs are enqueued for real; a prefix of its own keeps them away from a running worker.
      BULLMQ_PREFIX: `test-ses-${randomUUID().slice(0, 8)}`,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: test fixtures create offices, users, courts and files across offices.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);

    officeId = await seedOffice('Sessions office');
    for (const [key, role] of [
      ['manager', 'OFFICE_MANAGER'],
      ['senior', 'SENIOR_LAWYER'],
      ['lawyer', 'LAWYER'],
      ['lawyer2', 'LAWYER'],
      ['outsider', 'LAWYER'],
      ['paralegal', 'PARALEGAL'],
      ['trainee', 'TRAINEE'],
    ] as const) {
      users[key] = await seedUser(officeId, role);
    }
    const file = await seedFile('lawyer', ['paralegal', 'trainee', 'lawyer2']);
    fileId = file.id;
    fileNumber = file.fileNumber;
    secretFileId = (await seedFile('lawyer2', [], { isConfidential: true })).id;
    courtId = (
      await raw.court.create({
        data: { officeId, jurisdiction: 'PALESTINE', courtType: 'MAGISTRATE', nameAr: 'محكمة صلح' },
      })
    ).id;
    otherOffice = await seedUser(await seedOffice('Other sessions office'), 'OFFICE_MANAGER');
  }, 60_000);

  afterAll(async () => {
    if (app) await getQueue(app, QUEUE.REMINDER).obliterate({ force: true });
    if (raw) {
      const where = { officeId: { in: officeIds } };
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const name = model.charAt(0).toLowerCase() + model.slice(1);
        await (raw as unknown as Record<string, Delegate>)[name]?.deleteMany({ where });
      }
      await raw.court.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  describe('POST /sessions', () => {
    it('should schedule a hearing with the office reminder days, a timeline event and an audit row', async () => {
      const at = freshDay();
      const created = await session({ startsAt: at(7), courtId, courtRoom: 'Hall 2' });
      expect(created).toMatchObject({
        file: { id: fileId, fileNumber },
        sessionType: 'HEARING',
        status: 'SCHEDULED',
        startsAt: at(7),
        endsAt: null,
        court: { id: courtId, nameAr: 'محكمة صلح' },
        judge: null,
        courtRoom: 'Hall 2',
        attendingLawyer: { id: user('lawyer').userId },
        reminderDays: [7, 3, 1],
        outcome: null,
        nextSessionId: null,
        previousSessionId: null,
      });
      // 09:00 office time (Asia/Hebron) on the days before; one recipient, who is attending and responsible (D-117).
      expect(await reminders(created.id)).toEqual(
        [7, 3, 1].map((days) => ({
          daysBefore: days,
          status: 'PENDING',
          scheduledFor: nineAm(at(7), days),
        })),
      );
      const event = await raw.caseTimelineEvent.findFirst({ where: { sourceId: created.id } });
      expect(event).toMatchObject({
        eventType: 'SESSION_CREATED',
        sourceType: 'Session',
        actorId: user('lawyer').userId,
        payload: { sessionType: 'HEARING', startsAt: at(7) },
      });
      const audit = await raw.auditLog.findFirst({ where: { entityId: created.id } });
      expect(audit).toMatchObject({ entityType: 'Session', action: 'CREATE' });
    });

    it('should store the instant whatever offset it was sent with, and send reminders already due at once', async () => {
      // Tomorrow 06:00Z, sent as +00:00: the 7- and 3-day reminders are past (one reminder due now), and 09:00 on the
      // day itself is after the start (none).
      const local = new Date(TODAY + DAY_MS + 6 * 3_600_000).toISOString().replace('Z', '+00:00');
      const created = await session({ startsAt: local, reminderDays: [7, 3, 0] });
      expect(created.startsAt).toBe(new Date(local).toISOString());
      const [due, ...rest] = await reminders(created.id);
      expect(rest).toEqual([]);
      expect(due?.daysBefore).toBe(3);
      expect(due?.scheduledFor.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should refuse an overlapping session of the same lawyer with BIZ-004 and its details', async () => {
      const at = freshDay();
      const first = await session({ startsAt: at(9), endsAt: at(11) });
      const res = await create('lawyer', {
        fileId,
        attendingLawyerId: user('lawyer').userId,
        startsAt: at(10),
      });
      expectError(res, 409, 'BIZ-004');
      expect((res.body as ErrorBody).error.details).toEqual([
        {
          field: 'startsAt',
          message: 'validation.sessionConflict',
          params: { sessionId: first.id, startsAt: at(9), endsAt: at(11), fileNumber },
        },
      ]);
      // Acknowledged: allowed, and the audit row says so.
      const forced = await session({ startsAt: at(10), acknowledgeConflict: true });
      const audit = await raw.auditLog.findFirst({ where: { entityId: forced.id } });
      expect(audit?.newValues).toMatchObject({ acknowledgeConflict: true });
    });

    it('should allow touching sessions and count one hour for a session without an end', async () => {
      const at = freshDay();
      await session({ startsAt: at(9), endsAt: at(10) });
      await session({ startsAt: at(10) }); // starts when the first ends; no end = until 11:00
      expectError(
        await create('lawyer', {
          fileId,
          attendingLawyerId: user('lawyer').userId,
          startsAt: at(10, 30),
        }),
        409,
        'BIZ-004',
      );
      await session({ startsAt: at(11) });
      // Ending exactly when the first starts is fine too.
      await session({ startsAt: at(8), endsAt: at(9) });
    });

    it('should judge the night summer time ends by instants, not wall-clock times', async () => {
      // Asia/Hebron leaves summer time on 24 Oct 2026 (01:00 → 00:00, D-092): 00:30 happens twice, an hour apart.
      await session({ startsAt: '2026-10-24T00:30:00+03:00' }); // 21:30Z, no end: until 22:30Z
      await session({ startsAt: '2026-10-24T00:30:00+02:00' }); // 22:30Z: touches the first
      expectError(
        await create('lawyer', {
          fileId,
          attendingLawyerId: user('lawyer').userId,
          startsAt: '2026-10-24T00:15:00+02:00', // 22:15Z: inside both
        }),
        409,
        'BIZ-004',
      );
    });

    it('should let only one of two concurrent overlapping creates through', async () => {
      for (let round = 0; round < 5; round++) {
        const at = freshDay();
        const results = await Promise.all(
          [at(9), at(9, 30)].map((startsAt) =>
            create('lawyer', { fileId, attendingLawyerId: user('lawyer').userId, startsAt }),
          ),
        );
        expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
      }
    });

    it('should not count sessions of a deleted file', async () => {
      const at = freshDay();
      const file = await seedFile('lawyer');
      await create('lawyer', {
        fileId: file.id,
        attendingLawyerId: user('lawyer').userId,
        startsAt: at(9),
      }).expect(201);
      await raw.legalFile.update({ where: { id: file.id }, data: { deletedAt: new Date() } });
      await session({ startsAt: at(9) });
    });

    it('should ignore cancelled sessions and other lawyers in the conflict check', async () => {
      const at = freshDay();
      const cancelled = await session({ startsAt: at(9) });
      await http()
        .post(`/api/v1/sessions/${cancelled.id}/cancel`)
        .set(as('lawyer'))
        .send({})
        .expect(200);
      await session({ startsAt: at(9) });
      await session({ startsAt: at(9), attendingLawyerId: user('lawyer2').userId });
    });

    it('should not name the file of a conflicting session the caller cannot see', async () => {
      const at = freshDay();
      const secret = await create('lawyer2', {
        fileId: secretFileId,
        attendingLawyerId: user('lawyer2').userId,
        startsAt: at(9),
      });
      expect(secret.status).toBe(201);
      const res = await create('lawyer', {
        fileId,
        attendingLawyerId: user('lawyer2').userId,
        startsAt: at(9),
      });
      expectError(res, 409, 'BIZ-004');
      expect((res.body as ErrorBody).error.details?.[0]?.params).toMatchObject({
        // Neither the hidden file nor the session id: only the busy time.
        sessionId: null,
        fileNumber: null,
      });
    });

    it('should check the attending lawyer, the court and the input', async () => {
      const at = freshDay();
      for (const attendingLawyerId of [
        user('paralegal').userId, // cannot hold hearings
        user('outsider').userId, // cannot see the file
        otherOffice.userId,
      ]) {
        const res = await create('lawyer', { fileId, attendingLawyerId, startsAt: at(9) });
        expectError(res, 400, 'VAL-001');
        expect((res.body as ErrorBody).error.details).toEqual([
          { field: 'attendingLawyerId', message: 'validation.attendingLawyer' },
        ]);
      }
      expectError(
        await create('lawyer', {
          fileId,
          attendingLawyerId: user('lawyer').userId,
          startsAt: at(9),
          courtId: randomUUID(),
        }),
        400,
        'VAL-001',
      );
      for (const body of [
        { startsAt: '2026-11-02 09:00' },
        { startsAt: '2026-11-02T09:00:00' }, // no offset
        { startsAt: at(10), endsAt: at(9) },
        { startsAt: at(9), reminderDays: [1, 1] },
        { startsAt: at(9), reminderDays: [400] },
      ]) {
        expectError(
          await create('lawyer', { fileId, attendingLawyerId: user('lawyer').userId, ...body }),
          400,
          'VAL-001',
        );
      }
    });

    it('should apply permissions, file access and the archive rule', async () => {
      const at = freshDay();
      const body = { fileId, attendingLawyerId: user('lawyer').userId, startsAt: at(9) };
      expectError(await create('paralegal', body), 403, 'AUTH-100');
      expectError(await create('trainee', body), 403, 'AUTH-100');
      expectError(await create('outsider', body), 404, 'RES-001');
      expectError(
        await http().post('/api/v1/sessions').set(bearerFor(jwt, otherOffice)).send(body),
        404,
        'RES-001',
      );
      const archived = await seedFile('lawyer', [], { status: 'ARCHIVED' });
      expectError(await create('lawyer', { ...body, fileId: archived.id }), 422, 'BIZ-007');
    });
  });

  describe('PATCH /sessions/:id', () => {
    it('should reschedule: re-check conflicts, move the reminders, add a timeline event and audit the change', async () => {
      const at = freshDay();
      await session({ startsAt: at(14) });
      const moved = await session({ startsAt: at(9) });
      const patch = (body: object) =>
        http().patch(`/api/v1/sessions/${moved.id}`).set(as('lawyer')).send(body);

      expectError(await patch({ startsAt: at(14, 30) }), 409, 'BIZ-004');
      const res = await patch({ startsAt: at(12), courtRoom: 'Hall 5' });
      expect(res.status).toBe(200);
      expect((res.body as { data: SessionBody }).data).toMatchObject({
        startsAt: at(12),
        courtRoom: 'Hall 5',
      });
      const rows = await reminders(moved.id);
      expect(rows.filter((row) => row.status === 'CANCELLED')).toHaveLength(3);
      expect(rows.filter((row) => row.status === 'PENDING').map((row) => row.scheduledFor)).toEqual(
        [7, 3, 1].map((days) => nineAm(at(12), days)),
      );
      const audit = await raw.auditLog.findFirst({
        where: { entityId: moved.id, action: 'UPDATE' },
      });
      expect(audit).toMatchObject({
        oldValues: { startsAt: at(9), courtRoom: null },
        newValues: { startsAt: at(12), courtRoom: 'Hall 5' },
      });
      expect(
        await raw.caseTimelineEvent.count({
          where: { sourceId: moved.id, eventType: 'SESSION_UPDATED' },
        }),
      ).toBe(1);
      // The same instant in another offset is no change: nothing written.
      const same = at(12).replace('Z', '+00:00');
      await patch({ startsAt: same }).expect(200);
      expect(await raw.auditLog.count({ where: { entityId: moved.id, action: 'UPDATE' } })).toBe(1);
      // Moving next to the blocker is allowed when acknowledged.
      await patch({ startsAt: at(14, 30), acknowledgeConflict: true }).expect(200);
    });

    it('should refuse edits of a cancelled session (BIZ-012), an end before the start and other callers', async () => {
      const at = freshDay();
      const created = await session({ startsAt: at(9), endsAt: at(10) });
      const patch = (key: string, body: object) =>
        http().patch(`/api/v1/sessions/${created.id}`).set(as(key)).send(body);
      expectError(await patch('lawyer', { endsAt: at(8) }), 400, 'VAL-001');
      expectError(await patch('lawyer', {}), 400, 'VAL-001');
      expectError(await patch('paralegal', { courtRoom: 'x' }), 403, 'AUTH-100');
      expectError(await patch('outsider', { courtRoom: 'x' }), 404, 'RES-001');
      expectError(
        await http()
          .patch(`/api/v1/sessions/${created.id}`)
          .set(bearerFor(jwt, otherOffice))
          .send({ courtRoom: 'x' }),
        404,
        'RES-001',
      );
      await http()
        .post(`/api/v1/sessions/${created.id}/cancel`)
        .set(as('lawyer'))
        .send({})
        .expect(200);
      expectError(await patch('lawyer', { courtRoom: 'x' }), 422, 'BIZ-012');
    });

    it('should refuse changes once the file is archived (BIZ-007), while reads still work', async () => {
      const at = freshDay();
      const file = await seedFile('lawyer');
      const res = await create('lawyer', {
        fileId: file.id,
        attendingLawyerId: user('lawyer').userId,
        startsAt: at(9),
      });
      const id = (res.body as { data: { id: string } }).data.id;
      await raw.legalFile.update({ where: { id: file.id }, data: { status: 'ARCHIVED' } });
      expectError(
        await http().patch(`/api/v1/sessions/${id}`).set(as('lawyer')).send({ courtRoom: 'x' }),
        422,
        'BIZ-007',
      );
      expectError(
        await http().post(`/api/v1/sessions/${id}/cancel`).set(as('lawyer')).send({}),
        422,
        'BIZ-007',
      );
      await http().get(`/api/v1/sessions/${id}`).set(as('lawyer')).expect(200);
    });
  });

  describe('POST /sessions/:id/cancel', () => {
    it('should cancel the session and its pending reminders, once', async () => {
      const at = freshDay();
      const created = await session({ startsAt: at(9) });
      const cancel = () =>
        http()
          .post(`/api/v1/sessions/${created.id}/cancel`)
          .set(as('lawyer'))
          .send({ reason: 'Judge on leave' });
      const res = await cancel().expect(200);
      expect((res.body as { data: SessionBody }).data).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'Judge on leave',
      });
      expect((await reminders(created.id)).every((row) => row.status === 'CANCELLED')).toBe(true);
      await cancel().expect(200);
      expect(await raw.auditLog.count({ where: { entityId: created.id, action: 'UPDATE' } })).toBe(
        1,
      );
    });
  });

  describe('POST /sessions/:id/outcome', () => {
    it('should record the outcome and minutes and schedule the next session', async () => {
      const yesterday = (hour: number) => new Date(TODAY - DAY_MS + hour * 3_600_000).toISOString();
      const held = await session({ startsAt: yesterday(9), courtId, courtRoom: 'Hall 1' });
      const at = freshDay();
      const outcome = (body: object) =>
        http().post(`/api/v1/sessions/${held.id}/outcome`).set(as('lawyer')).send(body);

      const res = await outcome({
        outcome: 'ADJOURNED',
        minutes: 'Adjourned for the defence to reply.',
        nextSession: { startsAt: at(9) },
      });
      expect(res.status).toBe(200);
      const body = (res.body as { data: SessionBody & { nextSessionId: string } }).data;
      expect(body).toMatchObject({
        status: 'COMPLETED',
        outcome: 'ADJOURNED',
        minutes: 'Adjourned for the defence to reply.',
      });
      const next = await http()
        .get(`/api/v1/sessions/${body.nextSessionId}`)
        .set(as('lawyer'))
        .expect(200);
      expect((next.body as { data: SessionBody }).data).toMatchObject({
        status: 'SCHEDULED',
        startsAt: at(9),
        court: { id: courtId },
        courtRoom: 'Hall 1',
        attendingLawyer: { id: user('lawyer').userId },
        previousSessionId: held.id,
      });
      // Correcting the minutes is allowed; a second next session is not.
      await outcome({ outcome: 'ADJOURNED', minutes: 'Corrected.' }).expect(200);
      expectError(
        await outcome({ outcome: 'ADJOURNED', nextSession: { startsAt: at(12) } }),
        400,
        'VAL-001',
      );
      // A held session is no longer editable or cancellable.
      expectError(
        await http().post(`/api/v1/sessions/${held.id}/cancel`).set(as('lawyer')).send({}),
        422,
        'BIZ-012',
      );
    });

    it('should refuse an outcome before the session starts, and a next session before it', async () => {
      const at = freshDay();
      const future = await session({ startsAt: at(9) });
      const res = await http()
        .post(`/api/v1/sessions/${future.id}/outcome`)
        .set(as('lawyer'))
        .send({ outcome: 'DECIDED' });
      expectError(res, 400, 'VAL-001');
      expect((res.body as ErrorBody).error.details).toEqual([
        { field: 'outcome', message: 'validation.sessionNotHeld' },
      ]);
      const held = await session({ startsAt: new Date(TODAY - 2 * DAY_MS).toISOString() });
      expectError(
        await http()
          .post(`/api/v1/sessions/${held.id}/outcome`)
          .set(as('lawyer'))
          .send({
            outcome: 'ADJOURNED',
            nextSession: { startsAt: new Date(TODAY - 3 * DAY_MS).toISOString() },
          }),
        400,
        'VAL-001',
      );
    });
  });

  describe('reads', () => {
    it('should list the calendar of visible files in a range, filtered by lawyer and file', async () => {
      const at = freshDay();
      const mine = await session({ startsAt: at(9) });
      const theirs = await create('lawyer2', {
        fileId: secretFileId,
        attendingLawyerId: user('lawyer2').userId,
        startsAt: at(11),
      });
      const secretId = (theirs.body as { data: { id: string } }).data.id;
      const calendar = async (key: string, query: string) =>
        (
          (await http().get(`/api/v1/sessions?${query}`).set(as(key)).expect(200)).body as {
            data: { id: string }[];
          }
        ).data.map((row) => row.id);
      const range = `from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(24))}`;

      expect(await calendar('manager', range)).toEqual([mine.id, secretId]);
      expect(await calendar('senior', range)).toEqual([mine.id]); // confidential file
      expect(await calendar('lawyer', range)).toEqual([mine.id]);
      expect(await calendar('lawyer2', `${range}&lawyerId=me`)).toEqual([secretId]);
      expect(await calendar('manager', `${range}&fileId=${fileId}`)).toEqual([mine.id]);
      expect(await calendar('trainee', range)).toEqual([mine.id]);
      expect(await calendar('outsider', range)).toEqual([]);
      expectError(
        await http()
          .get(
            `/api/v1/sessions?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(new Date(TODAY + 200 * DAY_MS).toISOString())}`,
          )
          .set(as('manager')),
        400,
        'VAL-001',
      );
      expectError(
        await http().get(`/api/v1/sessions/${secretId}`).set(as('lawyer')),
        404,
        'RES-001',
      );
      expectError(
        await http().get('/api/v1/sessions/not-a-uuid').set(as('lawyer')),
        404,
        'RES-001',
      );
    });

    it("should list a file's upcoming and past sessions", async () => {
      const file = await seedFile('lawyer');
      const at = freshDay();
      const add = (startsAt: string) =>
        create('lawyer', { fileId: file.id, attendingLawyerId: user('lawyer').userId, startsAt });
      const past = await add(new Date(TODAY - 5 * DAY_MS).toISOString());
      const later = await add(at(15));
      const sooner = await add(at(9));
      const ids = (res: request.Response) =>
        (res.body as { data: { id: string }[] }).data.map((row) => row.id);
      const idOf = (res: request.Response) => (res.body as { data: { id: string } }).data.id;

      const upcoming = await http()
        .get(`/api/v1/cases/${file.id}/sessions`)
        .set(as('lawyer'))
        .expect(200);
      expect(ids(upcoming)).toEqual([idOf(sooner), idOf(later)]);
      expect(
        (upcoming.body as { meta: { pagination: { total: number } } }).meta.pagination.total,
      ).toBe(2);
      const before = await http()
        .get(`/api/v1/cases/${file.id}/sessions?when=past`)
        .set(as('lawyer'))
        .expect(200);
      expect(ids(before)).toEqual([idOf(past)]);
      expectError(
        await http().get(`/api/v1/cases/${file.id}/sessions`).set(as('outsider')),
        404,
        'RES-001',
      );
    });
  });
});
