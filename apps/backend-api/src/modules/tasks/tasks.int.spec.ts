import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };

interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}

type TaskBody = Record<string, unknown> & { id: string };

/** MVP-76 through HTTP on real PostgreSQL: tasks CRUD, status, reorder, bulk assign, permissions and isolation (D-098). */
describe('tasks API (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  const users: Record<string, SeededUser> = {};
  let officeId: string;
  let otherOffice: SeededUser;
  /** Responsible lawyer `lawyer`, paralegal `paralegal`, team members `trainee` and `collaborator`. */
  let fileId: string;
  /** Assigned to `otherLawyer` only. */
  let otherFileId: string;

  const http = () => request(app.getHttpServer());
  const user = (key: string) => users[key] as SeededUser;
  const as = (key: string) => bearerFor(jwt, user(key));

  async function seedUser(office: string, role: Role, isActive = true): Promise<SeededUser> {
    const created = await raw.user.create({
      data: {
        officeId: office,
        fullName: `${role} ${randomUUID().slice(0, 4)}`,
        email: `tasks-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
        isActive,
      },
    });
    return { userId: created.id, officeId: office, role };
  }

  async function seedOffice(name: string): Promise<string> {
    const office = await raw.office.create({ data: { name, settings: { create: {} } } });
    officeIds.push(office.id);
    return office.id;
  }

  async function seedFile(lawyer: string, team: string[] = [], paralegal?: string) {
    const file = await raw.legalFile.create({
      data: {
        officeId,
        fileNumber: `T-${randomUUID()}`,
        title: 'Tasks test file',
        fileType: 'LITIGATION',
        responsibleLawyerId: user(lawyer).userId,
        responsibleParalegalId: paralegal && user(paralegal).userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    for (const key of [lawyer, ...(paralegal ? [paralegal] : []), ...team]) {
      await raw.fileTeamMember.create({
        data: { officeId, fileId: file.id, userId: user(key).userId },
      });
    }
    return file.id;
  }

  const create = (key: string, body: Record<string, unknown>) =>
    http().post('/api/v1/tasks').set(as(key)).send(body);

  async function task(body: Record<string, unknown> = {}, key = 'lawyer'): Promise<TaskBody> {
    const res = await create(key, { title: 'Draft the statement of claim', fileId, ...body });
    expect(res.status).toBe(201);
    return (res.body as { data: TaskBody }).data;
  }

  const listIds = async (key: string, query = '') =>
    (
      (await http().get(`/api/v1/tasks${query}`).set(as(key)).expect(200)).body as {
        data: { id: string }[];
      }
    ).data.map((row) => row.id);

  const expectError = (res: request.Response, status: number, code: string) =>
    expect({ status: res.status, body: res.body as unknown }).toMatchObject({
      status,
      body: { error: { code } },
    });

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: test fixtures create offices, users and files across offices.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);

    officeId = await seedOffice('Tasks office');
    for (const [key, role] of [
      ['manager', 'OFFICE_MANAGER'],
      ['senior', 'SENIOR_LAWYER'],
      ['lawyer', 'LAWYER'],
      ['otherLawyer', 'LAWYER'],
      ['paralegal', 'PARALEGAL'],
      ['admin', 'ADMIN'],
      ['trainee', 'TRAINEE'],
      ['collaborator', 'EXTERNAL_COLLABORATOR'],
    ] as const) {
      users[key] = await seedUser(officeId, role);
    }
    users['inactive'] = await seedUser(officeId, 'LAWYER', false);
    fileId = await seedFile('lawyer', ['trainee', 'collaborator'], 'paralegal');
    otherFileId = await seedFile('otherLawyer');
    otherOffice = await seedUser(await seedOffice('Other tasks office'), 'OFFICE_MANAGER');
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const name = model.charAt(0).toLowerCase() + model.slice(1);
        await (raw as unknown as Record<string, Delegate>)[name]?.deleteMany({ where });
      }
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  describe('POST /tasks', () => {
    it('should create a task on a file, audit it and notify the assignee', async () => {
      const created = await task({
        assignedToId: user('paralegal').userId,
        dueDate: '2026-11-02',
        priority: 'HIGH',
        description: 'Before the hearing',
      });
      expect(created).toMatchObject({
        title: 'Draft the statement of claim',
        description: 'Before the hearing',
        file: { id: fileId, title: 'Tasks test file' },
        dueDate: '2026-11-02',
        priority: 'HIGH',
        status: 'TODO',
        completedAt: null,
        assignedTo: { id: user('paralegal').userId },
        createdBy: { id: user('lawyer').userId },
      });
      await expect(
        raw.auditLog.findFirst({ where: { entityId: created.id, action: 'CREATE' } }),
      ).resolves.toMatchObject({ entityType: 'Task', userId: user('lawyer').userId });
      await expect(
        raw.notification.findMany({ where: { userId: user('paralegal').userId } }),
      ).resolves.toEqual([
        expect.objectContaining({
          type: 'task.assigned',
          titleKey: 'common.notifications.taskAssigned',
          params: { taskId: created.id, title: 'Draft the statement of claim' },
        }),
      ]);
    });

    it('should default the assignee to the creator and not notify them, placing new tasks last in TODO', async () => {
      const first = await task();
      const second = await task();
      expect(first.assignedTo).toMatchObject({ id: user('lawyer').userId });
      expect(second.sortOrder).toBe((first.sortOrder as number) + 1);
      await expect(
        raw.notification.count({ where: { userId: user('lawyer').userId } }),
      ).resolves.toBe(0);
    });

    it('should let only OM, SL, L and P create (403 AUTH-100 for admin staff, trainees and collaborators)', async () => {
      for (const key of ['admin', 'trainee', 'collaborator']) {
        expectError(await create(key, { title: 'x', fileId }), 403, 'AUTH-100');
      }
    });

    it('should reject an assignee who is inactive, admin staff, without access to the file or of another office', async () => {
      for (const assignee of ['inactive', 'admin', 'otherLawyer']) {
        const res = await create('lawyer', {
          title: 'x',
          fileId,
          assignedToId: user(assignee).userId,
        });
        expectError(res, 400, 'VAL-001');
        expect(res.body).toMatchObject({
          error: { details: [{ field: 'assignedToId', message: 'validation.assignee' }] },
        });
      }
      expectError(
        await create('lawyer', { title: 'x', fileId, assignedToId: otherOffice.userId }),
        400,
        'VAL-001',
      );
      // A senior lawyer sees every file, so a task on any file may be theirs.
      await task({ assignedToId: user('senior').userId });
    });

    it('should hide a file the caller cannot edit (404) and validate the body', async () => {
      expectError(await create('lawyer', { title: 'x', fileId: otherFileId }), 404, 'RES-001');
      expectError(await create('lawyer', { title: '', fileId }), 400, 'VAL-001');
      expectError(await create('lawyer', { title: 'x', dueDate: '02/11/2026' }), 400, 'VAL-001');
    });
  });

  describe('visibility', () => {
    it("should show a file's tasks to whoever sees the file, and a personal task only to its creator and assignee", async () => {
      const onFile = await task();
      const personal = await task({ fileId: undefined, assignedToId: user('senior').userId });
      expect(personal.file).toBeNull();
      expect(await listIds('trainee')).toContain(onFile.id);
      expect(await listIds('otherLawyer')).not.toContain(onFile.id);
      expect(await listIds('lawyer')).toContain(personal.id);
      expect(await listIds('senior')).toContain(personal.id);
      expect(await listIds('manager')).not.toContain(personal.id);
      await http().get(`/api/v1/tasks/${onFile.id}`).set(as('admin')).expect(200);
      expectError(
        await http().get(`/api/v1/tasks/${onFile.id}`).set(as('otherLawyer')),
        404,
        'RES-001',
      );
      expectError(
        await http().get(`/api/v1/tasks/${personal.id}`).set(as('manager')),
        404,
        'RES-001',
      );
    });

    it("should hide another office's task (404 RES-001) and treat a malformed id the same way", async () => {
      const mine = await task();
      const auth = bearerFor(jwt, otherOffice);
      expectError(await http().get(`/api/v1/tasks/${mine.id}`).set(auth), 404, 'RES-001');
      expectError(
        await http().patch(`/api/v1/tasks/${mine.id}/status`).set(auth).send({ status: 'DONE' }),
        404,
        'RES-001',
      );
      expectError(await http().get('/api/v1/tasks/not-a-uuid').set(as('lawyer')), 404, 'RES-001');
    });
  });

  describe('GET /tasks filters', () => {
    it('should filter by file, assignee=me, status, due date and overdue', async () => {
      const mine = await task({ assignedToId: user('trainee').userId, dueDate: '2020-01-01' });
      const later = await task({ dueDate: '2999-01-01' });
      const elsewhere = await task({ fileId: otherFileId, dueDate: '2020-01-01' }, 'otherLawyer');
      expect(await listIds('trainee', '?assignee=me')).toEqual([mine.id]);
      expect(await listIds('manager', `?fileId=${otherFileId}`)).toEqual([elsewhere.id]);
      const overdue = await listIds('manager', '?overdue=true&limit=100');
      expect(overdue).toEqual(expect.arrayContaining([mine.id, elsewhere.id]));
      expect(overdue).not.toContain(later.id);
      const dueSoon = await listIds('manager', '?dueBefore=2020-01-01&limit=100');
      expect(dueSoon).toEqual(expect.arrayContaining([mine.id, elsewhere.id]));
      expect(dueSoon).not.toContain(later.id);
      await http()
        .patch(`/api/v1/tasks/${mine.id}/status`)
        .set(as('trainee'))
        .send({ status: 'DONE' })
        .expect(200);
      expect(await listIds('manager', '?overdue=true&limit=100')).not.toContain(mine.id);
      expect(await listIds('trainee', '?assignee=me&status=DONE')).toEqual([mine.id]);
      expectError(
        await http().get('/api/v1/tasks?assignee=someone').set(as('lawyer')),
        400,
        'VAL-001',
      );
    });
  });

  describe('PATCH /tasks/:id/status', () => {
    it('should complete a task (completedAt + TASK_COMPLETED on the timeline) and reopen it', async () => {
      const created = await task();
      const done = await http()
        .patch(`/api/v1/tasks/${created.id}/status`)
        .set(as('trainee'))
        .send({ status: 'DONE' })
        .expect(200);
      expect((done.body as { data: TaskBody }).data).toMatchObject({
        status: 'DONE',
        completedAt: expect.any(String),
      });
      await expect(
        raw.caseTimelineEvent.findFirst({ where: { sourceId: created.id } }),
      ).resolves.toMatchObject({
        fileId,
        eventType: 'TASK_COMPLETED',
        sourceType: 'Task',
        actorId: user('trainee').userId,
        payload: { title: 'Draft the statement of claim' },
      });
      const reopened = await http()
        .patch(`/api/v1/tasks/${created.id}/status`)
        .set(as('lawyer'))
        .send({ status: 'IN_PROGRESS' })
        .expect(200);
      expect((reopened.body as { data: TaskBody }).data).toMatchObject({
        status: 'IN_PROGRESS',
        completedAt: null,
      });
    });

    it('should let an external collaborator move only their own tasks, and admin staff none', async () => {
      const theirs = await task({ assignedToId: user('collaborator').userId });
      const notTheirs = await task();
      await http()
        .patch(`/api/v1/tasks/${theirs.id}/status`)
        .set(as('collaborator'))
        .send({ status: 'DONE' })
        .expect(200);
      expectError(
        await http()
          .patch(`/api/v1/tasks/${notTheirs.id}/status`)
          .set(as('collaborator'))
          .send({ status: 'DONE' }),
        403,
        'AUTH-100',
      );
      expectError(
        await http()
          .patch(`/api/v1/tasks/${notTheirs.id}/status`)
          .set(as('admin'))
          .send({ status: 'DONE' }),
        403,
        'AUTH-100',
      );
      await expect(
        raw.task.findUniqueOrThrow({ where: { id: notTheirs.id } }),
      ).resolves.toMatchObject({
        status: 'TODO',
      });
    });
  });

  describe('PATCH and DELETE /tasks/:id', () => {
    it('should edit, audit only changed fields, clear with null and notify a new assignee', async () => {
      const created = await task({ dueDate: '2026-12-01', description: 'x' });
      const res = await http()
        .patch(`/api/v1/tasks/${created.id}`)
        .set(as('paralegal'))
        .send({
          title: 'Draft the statement of claim',
          dueDate: null,
          description: null,
          assignedToId: user('trainee').userId,
        })
        .expect(200);
      expect((res.body as { data: TaskBody }).data).toMatchObject({
        dueDate: null,
        description: null,
        assignedTo: { id: user('trainee').userId },
      });
      const audit = await raw.auditLog.findFirstOrThrow({
        where: { entityId: created.id, action: 'UPDATE' },
      });
      expect(audit.oldValues).toEqual({
        dueDate: '2026-12-01',
        description: 'x',
        assignedToId: user('lawyer').userId,
      });
      await expect(
        raw.notification.count({
          where: {
            userId: user('trainee').userId,
            params: { path: ['taskId'], equals: created.id },
          },
        }),
      ).resolves.toBe(1);
    });

    it('should delete a task (204, audited) and 404 afterwards; not for an unassigned lawyer', async () => {
      const created = await task();
      expectError(
        await http().delete(`/api/v1/tasks/${created.id}`).set(as('otherLawyer')),
        404,
        'RES-001',
      );
      expectError(
        await http().delete(`/api/v1/tasks/${created.id}`).set(as('trainee')),
        403,
        'AUTH-100',
      );
      await http().delete(`/api/v1/tasks/${created.id}`).set(as('lawyer')).expect(204);
      await http().get(`/api/v1/tasks/${created.id}`).set(as('lawyer')).expect(404);
      await expect(
        raw.auditLog.count({ where: { entityId: created.id, action: 'DELETE' } }),
      ).resolves.toBe(1);
    });

    it('should keep the tasks of an archived file read-only (422 BIZ-007) but readable', async () => {
      const archivedFile = await seedFile('lawyer', ['trainee']);
      const created = await task({ fileId: archivedFile });
      await raw.legalFile.update({ where: { id: archivedFile }, data: { status: 'ARCHIVED' } });
      await http().get(`/api/v1/tasks/${created.id}`).set(as('lawyer')).expect(200);
      for (const res of [
        await http().patch(`/api/v1/tasks/${created.id}`).set(as('lawyer')).send({ title: 'y' }),
        await http()
          .patch(`/api/v1/tasks/${created.id}/status`)
          .set(as('trainee'))
          .send({ status: 'DONE' }),
        await http().delete(`/api/v1/tasks/${created.id}`).set(as('lawyer')),
        await http()
          .patch('/api/v1/tasks/reorder')
          .set(as('lawyer'))
          .send({ status: 'TODO', taskIds: [created.id] }),
        await create('lawyer', { title: 'x', fileId: archivedFile }),
      ]) {
        expectError(res, 422, 'BIZ-007');
      }
    });
  });

  describe('reorder and bulk assign', () => {
    it('should set the order of a column, and refuse a task of another column', async () => {
      const [a, b, c] = [await task(), await task(), await task()];
      const ids = [c, a, b].map((row) => (row as TaskBody).id);
      await http()
        .patch('/api/v1/tasks/reorder')
        .set(as('lawyer'))
        .send({ status: 'TODO', taskIds: ids })
        .expect(204);
      const rows = await raw.task.findMany({ where: { id: { in: ids } } });
      expect(ids.map((id) => rows.find((row) => row.id === id)?.sortOrder)).toEqual([0, 1, 2]);
      expectError(
        await http()
          .patch('/api/v1/tasks/reorder')
          .set(as('lawyer'))
          .send({ status: 'DONE', taskIds: ids }),
        400,
        'VAL-001',
      );
    });

    it('should assign every task or none, notifying the assignee once per task', async () => {
      const [a, b] = [await task(), await task()];
      const hidden = await task({ fileId: otherFileId }, 'otherLawyer');
      expectError(
        await http()
          .post('/api/v1/tasks/bulk-assign')
          .set(as('lawyer'))
          .send({ taskIds: [a.id, hidden.id], assignedToId: user('paralegal').userId }),
        404,
        'RES-001',
      );
      expectError(
        await http()
          .post('/api/v1/tasks/bulk-assign')
          .set(as('collaborator'))
          .send({ taskIds: [a.id], assignedToId: user('paralegal').userId }),
        403,
        'AUTH-100',
      );
      const res = await http()
        .post('/api/v1/tasks/bulk-assign')
        .set(as('lawyer'))
        .send({ taskIds: [a.id, b.id], assignedToId: user('paralegal').userId })
        .expect(200);
      expect(res.body).toMatchObject({ data: { updated: 2 } });
      const rows = await raw.task.findMany({ where: { id: { in: [a.id, b.id] } } });
      expect(rows.map((row) => row.assignedToId)).toEqual([
        user('paralegal').userId,
        user('paralegal').userId,
      ]);
      await expect(
        raw.notification.count({
          where: {
            userId: user('paralegal').userId,
            OR: [a.id, b.id].map((id) => ({ params: { path: ['taskId'], equals: id } })),
          },
        }),
      ).resolves.toBe(2);
      expect(await raw.task.findUniqueOrThrow({ where: { id: hidden.id } })).toMatchObject({
        assignedToId: user('otherLawyer').userId,
      });
    });
  });
});
