import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { BOM } from './audit-csv';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Person = { userId: string; officeId: string; role: Role };

/** D-180 on real PostgreSQL: the audit log read, filtered, paged, exported — `view:audit` only, never across offices. */
describe('audit log (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let admin: Person;
  let lawyer: Person;
  let other: Person;
  let fileId: string;
  let taskId: string;
  let secretId: string;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());
  const get = (person: Person, path: string) =>
    http().get(`/api/v1/${path}`).set(bearerFor(jwt, person));

  async function office(name: string) {
    const row = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(row.id);
    return async (role: Role, fullName: string = role): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: row.id,
          fullName,
          email: `audit-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      return { userId: user.id, officeId: row.id, role };
    };
  }

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: fixtures for two offices and checks across them.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    const inA = await office('Audit office A');
    manager = await inA('OFFICE_MANAGER', 'Layla Manager');
    admin = await inA('ADMIN', 'Rana Admin');
    lawyer = await inA('LAWYER', 'Omar Lawyer');
    other = await (await office('Audit office B'))('OFFICE_MANAGER');
    const file = await raw.legalFile.create({
      data: {
        officeId: manager.officeId,
        fileNumber: `AUD-${randomUUID()}`,
        title: 'Rent claim',
        fileType: 'LITIGATION',
        responsibleLawyerId: lawyer.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    fileId = file.id;
    const task = await raw.task.create({
      data: {
        officeId: manager.officeId,
        fileId,
        title: 'Draft',
        assignedToId: lawyer.userId,
        createdById: manager.userId,
      },
    });
    taskId = task.id;
    const secret = await raw.legalFile.create({
      data: {
        officeId: manager.officeId,
        fileNumber: `AUD-${randomUUID()}`,
        title: 'Confidential settlement',
        fileType: 'LITIGATION',
        responsibleLawyerId: lawyer.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
        isConfidential: true,
      },
    });
    secretId = secret.id;
    const at = (iso: string) => new Date(iso);
    await raw.auditLog.createMany({
      data: [
        {
          officeId: manager.officeId,
          userId: lawyer.userId,
          entityType: 'LegalFile',
          entityId: fileId,
          action: 'UPDATE',
          oldValues: { title: 'Rent' },
          newValues: { title: 'Rent claim' },
          occurredAt: at('2026-11-10T08:00:00.000Z'),
        },
        {
          officeId: manager.officeId,
          userId: manager.userId,
          entityType: 'Task',
          entityId: taskId,
          action: 'CREATE',
          newValues: { title: '=HYPERLINK("x")', fileId },
          occurredAt: at('2026-11-11T08:00:00.000Z'),
        },
        // A task edit as the tasks module writes it: only the changed field, no file id.
        {
          officeId: manager.officeId,
          userId: lawyer.userId,
          entityType: 'Task',
          entityId: taskId,
          action: 'UPDATE',
          oldValues: { status: 'TODO' },
          newValues: { status: 'DONE' },
          occurredAt: at('2026-11-09T08:00:00.000Z'),
        },
        {
          officeId: manager.officeId,
          userId: manager.userId,
          entityType: 'LegalFile',
          entityId: secretId,
          action: 'CREATE',
          newValues: { title: 'Confidential settlement' },
          occurredAt: at('2026-10-05T08:00:00.000Z'),
        },
        {
          officeId: manager.officeId,
          userId: manager.userId,
          entityType: 'User',
          entityId: lawyer.userId,
          action: 'LOGIN',
          occurredAt: at('2026-10-01T08:00:00.000Z'),
        },
        {
          officeId: other.officeId,
          userId: other.userId,
          entityType: 'LegalFile',
          entityId: fileId,
          action: 'VIEW',
          occurredAt: at('2026-11-11T08:00:00.000Z'),
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    if (!raw) return;
    await app.close();
    process.env = savedEnv;
  });

  it('should list the office rows newest first with their actor and changes, paged by cursor', async () => {
    const first = await get(manager, 'audit?limit=2');
    expect(first.status).toBe(200);
    const { items, nextCursor } = first.body.data;
    expect(items.map((i: { entityType: string }) => i.entityType)).toEqual(['Task', 'LegalFile']);
    expect(items[1]).toMatchObject({
      actor: { type: 'USER', id: lawyer.userId, name: 'Omar Lawyer' },
      changes: [{ field: 'title', old: 'Rent', new: 'Rent claim' }],
    });
    const second = await get(admin, `audit?limit=2&cursor=${nextCursor}`);
    // The Admin is not on the confidential file: its row is left out.
    expect(second.body.data.items.map((i: { action: string }) => i.action)).toEqual([
      'UPDATE',
      'LOGIN',
    ]);
    expect(second.body.data.nextCursor).toBeNull();
  });

  it('should filter by action, user and office days, and refuse a range over a year', async () => {
    const created = await get(manager, 'audit?action=CREATE');
    expect(created.body.data.items).toHaveLength(2);
    const byUser = await get(manager, `audit?userId=${lawyer.userId}`);
    expect(byUser.body.data.items).toHaveLength(2);
    const days = await get(manager, 'audit?from=2026-11-11&to=2026-11-11');
    expect(days.body.data.items.map((i: { action: string }) => i.action)).toEqual(['CREATE']);
    const wide = await get(manager, 'audit?from=2025-01-01&to=2026-11-11');
    expect([wide.status, wide.body.error.code]).toEqual([400, 'VAL-001']);
  });

  it('should keep the log to view:audit holders, and a file audit to its own office', async () => {
    expect((await get(lawyer, 'audit')).status).toBe(403);
    expect((await get(lawyer, `cases/${fileId}/audit`)).status).toBe(403);
    const ofFile = await get(manager, `cases/${fileId}/audit`);
    expect(ofFile.status).toBe(200);
    // The file's own row and the task naming it; never office B's row on the same id.
    expect(ofFile.body.data.items.map((i: { entityType: string }) => i.entityType)).toEqual([
      'Task',
      'LegalFile',
      // The task edit that does not repeat the file id, found by the task's id.
      'Task',
    ]);
    expect((await get(other, `cases/${fileId}/audit`)).status).toBe(404);
    expect((await get(other, 'audit')).body.data.items).toHaveLength(1);
  });

  it('should hide the rows of a confidential file from an Admin who is not on it, in the list and the export', async () => {
    expect((await get(manager, `audit?entityId=${secretId}`)).body.data.items).toHaveLength(1);
    expect((await get(admin, `audit?entityId=${secretId}`)).body.data.items).toHaveLength(0);
    const csv = await get(admin, 'audit/export?entityType=LegalFile');
    expect(csv.text).not.toContain(secretId);
    expect(csv.text).toContain(fileId);
  });

  it('should export the filtered rows as CSV, defuse formulas and audit the export', async () => {
    const csv = await get(manager, 'audit/export?format=csv&entityType=Task&action=CREATE');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.replace(BOM, '').trim().split('\r\n');
    expect(lines).toHaveLength(2);
    // 2026-11-11 08:00 UTC is 10:00 in Hebron, the office zone.
    expect(lines[1]).toContain('"2026-11-11 10:00"');
    expect(lines[1]).toContain('"CREATE"');
    // No cell starts with a formula character.
    expect(lines[1]).not.toMatch(/(^|,)"[=+@-]/);
    const exported = await raw.auditLog.findFirstOrThrow({
      where: { officeId: manager.officeId, action: 'EXPORT', userId: manager.userId },
    });
    expect(exported).toMatchObject({ userId: manager.userId, entityType: 'AuditLog' });
    expect(exported.newValues).toMatchObject({ format: 'csv', rows: 1 });
    expect((await get(lawyer, 'audit/export')).status).toBe(403);
  });
});
