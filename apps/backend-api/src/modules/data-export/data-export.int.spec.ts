import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Role } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { OfficeExportBuilder } from './office-export.builder';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { MailService } from '../../common/mail/mail.service';
import { StorageService } from '../../common/storage/storage.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { tenantContextFor } from '../auth/client-info';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Person = { userId: string; officeId: string; role: Role };

/** D-184 on real PostgreSQL and MinIO: an office export asked for, built, downloaded, and only ever the office's own. */
describe('data export (HTTP + PostgreSQL + storage)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let builder: OfficeExportBuilder;
  let manager: Person;
  let lawyer: Person;
  let other: Person;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function office(name: string) {
    const row = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(row.id);
    return async (role: Role, fullName: string): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: row.id,
          fullName,
          email: `export-${randomUUID()}@example.test`,
          passwordHash: 'argon2-secret-hash',
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
    // The worker provides the builder; this app is the API, so the test builds it the same way.
    builder = new OfficeExportBuilder(
      app.get(PrismaService),
      app.get(StorageService, { strict: false }),
      app.get(MailService, { strict: false }),
      app.get(AppConfig),
      app.get(ClsService),
      await app.resolve(PinoLogger),
    );
    const inA = await office('Export office A');
    manager = await inA('OFFICE_MANAGER', 'Layla Manager');
    lawyer = await inA('LAWYER', 'Omar Lawyer');
    other = await (await office('Export office B'))('OFFICE_MANAGER', 'Other Manager');
    await raw.client.createMany({
      data: [
        { officeId: manager.officeId, clientType: 'INDIVIDUAL', displayName: 'Mine Client' },
        { officeId: other.officeId, clientType: 'INDIVIDUAL', displayName: 'Elsewhere Client' },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    if (!raw) return;
    const where = { officeId: { in: officeIds } };
    await raw.officeExport.deleteMany({ where });
    await raw.auditLog.deleteMany({ where });
    await raw.client.deleteMany({ where });
    await app.close();
    process.env = savedEnv;
  });

  it('should queue one export at a time for the office manager only, audited', async () => {
    const first = await http().post('/api/v1/offices/me/export').set(bearerFor(jwt, manager));
    expect([first.status, first.body.data.status]).toEqual([202, 'QUEUED']);
    const again = await http().post('/api/v1/offices/me/export').set(bearerFor(jwt, manager));
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(
      (await http().post('/api/v1/offices/me/export').set(bearerFor(jwt, lawyer))).status,
    ).toBe(403);
    await expect(
      raw.auditLog.count({
        where: { officeId: manager.officeId, entityType: 'OfficeExport', action: 'EXPORT' },
      }),
    ).resolves.toBe(1);
    const early = await http()
      .get(`/api/v1/offices/me/exports/${first.body.data.id}/download`)
      .set(bearerFor(jwt, manager));
    expect(early.body.error.code).toBe('BIZ-026');
  });

  it('should build a ZIP of every entity type with nothing from another office, then link to it', async () => {
    const queued = await raw.officeExport.findFirstOrThrow({
      where: { officeId: manager.officeId },
    });
    const context = tenantContextFor(manager.officeId, manager.userId, { requestId: null });
    const tenant = app.get(TenantRunner);
    const data = await tenant.run(context, () => builder.datasets());
    for (const name of [
      'clients',
      'files',
      'tasks',
      'documents',
      'invoices',
      'timeEntries',
      'users',
      'auditLog',
    ]) {
      expect(data).toHaveProperty(name);
    }
    const text = JSON.stringify(data, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(text).toContain('Mine Client');
    expect(text).not.toContain('Elsewhere Client');
    expect(text).not.toContain('argon2-secret-hash');

    await tenant.run(context, () => builder.run({ exportId: queued.id }));
    const ready = await raw.officeExport.findUniqueOrThrow({ where: { id: queued.id } });
    expect(ready).toMatchObject({ status: 'READY' });
    expect(ready.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(ready.storageKey).toBe(`${manager.officeId}/exports/${queued.id}.zip`);
    const zip = await tenant.run(context, async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of await app
        .get(StorageService, { strict: false })
        .getStream(ready.storageKey as string)) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    });
    // Entry names sit in plain text in the ZIP's directory.
    expect(zip.toString('latin1')).toContain('data/clients.json');
    expect(zip.toString('latin1')).toContain('manifest.json');
    expect(zip.length).toBe(Number(ready.sizeBytes));

    const listed = await http().get('/api/v1/offices/me/exports').set(bearerFor(jwt, manager));
    expect(listed.body.data[0]).toMatchObject({ id: queued.id, status: 'READY' });
    const link = await http()
      .get(`/api/v1/offices/me/exports/${queued.id}/download`)
      .set(bearerFor(jwt, manager));
    expect(link.status).toBe(200);
    expect(link.body.data.expiresIn).toBe(900);
    const elsewhere = await http()
      .get(`/api/v1/offices/me/exports/${queued.id}/download`)
      .set(bearerFor(jwt, other));
    expect(elsewhere.status).toBe(404);
  });

  it("should give any user their own data as JSON, without anyone else's", async () => {
    const res = await http().get('/api/v1/users/me/export').set(bearerFor(jwt, lawyer));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    const body = JSON.parse(res.text) as { profile: { fullName: string } };
    expect(body.profile.fullName).toBe('Omar Lawyer');
    expect(res.text).not.toContain('Layla Manager');
    expect(res.text).not.toContain('argon2-secret-hash');
  });
});
