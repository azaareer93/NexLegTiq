import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OfficeId, Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { OfficePurge } from './office-purge';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { StorageService } from '../../common/storage/storage.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_ISOLATION_MATRIX } from '../../database/tenant-isolation.matrix';
import type { SeededOffice } from '../../database/tenant-isolation.matrix';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { PasswordHasher } from '../auth/password-hasher';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

const PASSWORD = 'Deletion-Correct-Horse-9';
/** Tables the purge keeps (D-251); every other table with an office_id must be empty for the purged office. */
const KEPT = new Set([
  'offices',
  'office_settings',
  'audit_logs',
  'subscriptions',
  'platform_payments',
  'retained_invoices',
]);
type ErrorBody = { error: { code: string; details?: { field: string; message: string }[] } };
interface Seeded extends SeededOffice {
  readonly role: Role;
}

/** MVP-152 on real PostgreSQL and storage: request, read-only grace, cancel, and the final purge (D-251). */
describe('office deletion (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  const http = () => request(app.getHttpServer());
  const as = (user: Seeded) => bearerFor(jwt, user);
  const codeOf = (res: { body: unknown }) => (res.body as ErrorBody).error.code;

  async function seedOffice(name: string, settings = true): Promise<Seeded> {
    const office = await raw.office.create({
      data: {
        name,
        email: 'office@example.test',
        taxId: '562-000-111',
        ...(settings ? { settings: { create: {} } } : {}),
        ...(settings ? { subscriptions: liveSubscription() } : {}),
      },
    });
    officeIds.push(office.id);
    const user = await raw.user.create({
      data: {
        officeId: office.id,
        fullName: 'Office Manager',
        email: `deletion-${randomUUID()}@example.test`,
        passwordHash: await app.get(PasswordHasher).hash(PASSWORD),
        role: 'OFFICE_MANAGER',
      },
    });
    const plan = await raw.plan.findFirstOrThrow({ select: { id: true } });
    return { officeId: office.id, userId: user.id, planId: plan.id, role: 'OFFICE_MANAGER' };
  }

  /** Rows of the office in every table that has an office_id, by table. */
  async function rowsOf(officeId: string): Promise<Record<string, number>> {
    // One bound statement: query_to_xml runs each table's count, the table names come from the catalogue.
    const rows = await raw.$queryRaw<{ table_name: string; n: number }[]>`
      SELECT c.table_name::text AS table_name,
             (xpath('/row/n/text()', query_to_xml(
               format('SELECT count(*) AS n FROM public.%I WHERE office_id = %L', c.table_name, ${officeId}::text),
               false, true, '')))[1]::text::int AS n
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND c.column_name = 'office_id' AND t.table_type = 'BASE TABLE'
      ORDER BY 1`;
    return Object.fromEntries(rows.map((r) => [r.table_name, r.n]));
  }

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
    const module = await Test.createTestingModule({
      imports: [AppModule],
      providers: [OfficePurge],
    })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: test fixtures across offices.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      // Purged offices keep only these; the live ones were purged by the test or are emptied the same way.
      for (const id of officeIds) {
        await raw.office.updateMany({
          where: { id, purgedAt: null },
          data: { deletionScheduledFor: new Date(Date.now() - 1000) },
        });
        await raw.$queryRaw`SELECT nlq_purge_office(${id}::uuid)`.catch(() => undefined);
      }
      await raw.retainedInvoice.deleteMany({ where });
      await raw.auditLog.deleteMany({ where });
      await raw.platformPayment.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should ask for the password, make the office read-only for 30 days, and let a manager cancel', async () => {
    const manager = await seedOffice('Leaving office');
    const other = await seedOffice('Staying office');
    const lawyerRow = await raw.user.create({
      data: {
        officeId: manager.officeId,
        fullName: 'Lawyer',
        email: `deletion-${randomUUID()}@example.test`,
        passwordHash: '!',
        role: 'LAWYER',
      },
    });
    const lawyer = { ...manager, userId: lawyerRow.id, role: 'LAWYER' as const };
    const ask = (user: Seeded, password: string) =>
      http().post('/api/v1/offices/me/delete-request').set(as(user)).send({ password });

    expect(codeOf(await ask(lawyer, PASSWORD).expect(403))).toBe('AUTH-100');
    const wrong = await ask(manager, 'not-the-password').expect(400);
    expect((wrong.body as ErrorBody).error.details).toEqual([
      { field: 'password', message: 'validation.password.currentWrong' },
    ]);
    await http()
      .post('/api/v1/offices/me/delete-request')
      .set(as(manager))
      .send({ password: PASSWORD, mfaCode: '12' })
      .expect(400);

    const asked = await ask(manager, PASSWORD).expect(200);
    const scheduledFor = Date.parse(asked.body.data.scheduledFor as string);
    expect(scheduledFor - Date.now()).toBeGreaterThan(29.9 * 86_400_000);
    expect(scheduledFor - Date.now()).toBeLessThan(30.1 * 86_400_000);
    expect(codeOf(await ask(manager, PASSWORD).expect(409))).toBe('RES-003');

    // Read-only: reads and the export pass, writes are refused; the other office is untouched.
    const patch = (user: Seeded) =>
      http().patch('/api/v1/offices/me').set(as(user)).send({ website: 'https://example.test' });
    expect(codeOf(await patch(manager).expect(403))).toBe('AUTH-105');
    await patch(other).expect(200);
    await http().get('/api/v1/offices/me').set(as(manager)).expect(200);
    await http().post('/api/v1/offices/me/export').set(as(manager)).expect(202);
    const subscription = await http()
      .get('/api/v1/offices/me/subscription')
      .set(as(manager))
      .expect(200);
    expect(subscription.body.data).toMatchObject({
      readOnly: true,
      deletionScheduledFor: asked.body.data.scheduledFor,
    });

    await http().post('/api/v1/offices/me/delete-request/cancel').set(as(manager)).expect(200);
    await patch(manager).expect(200);
    await http().post('/api/v1/offices/me/delete-request/cancel').set(as(manager)).expect(409);
    const status = await http()
      .get('/api/v1/offices/me/delete-request')
      .set(as(manager))
      .expect(200);
    expect(status.body.data).toEqual({ requestedAt: null, scheduledFor: null });

    const audit = await raw.auditLog.findMany({
      where: { officeId: manager.officeId, entityType: 'Office', action: 'SECURITY' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.map((row) => (row.newValues as { deletion: string }).deletion)).toEqual([
      'REQUESTED',
      'CANCELLED',
    ]);
  });

  it('should purge every row and object of the office past its date, keep the legal records, and touch no other office', async () => {
    const leaving = await seedOffice('Purged office', false);
    const staying = await seedOffice('Other office', false);
    for (const office of [leaving, staying]) {
      for (const resource of TENANT_ISOLATION_MATRIX) await resource.create(raw, office);
    }
    // An issued invoice is kept as issued; the matrix's draft (no number) is not.
    const issued = await raw.invoice.findFirstOrThrow({
      where: { officeId: leaving.officeId, invoiceNumber: null },
      include: { client: true },
    });
    await raw.invoice.update({
      where: { id: issued.id },
      data: { invoiceNumber: 'INV-2026-00001', status: 'SENT', issueDate: new Date('2026-11-01') },
    });
    await raw.auditLog.create({
      data: {
        officeId: leaving.officeId,
        userId: leaving.userId,
        entityType: 'Case',
        action: 'UPDATE',
        newValues: { title: 'secret' },
        ipAddress: '10.0.0.1',
      },
    });
    const storage = app.get(StorageService);
    const tenant = app.get(TenantRunner);
    const put = (office: Seeded) =>
      tenant.run({ officeId: office.officeId as OfficeId }, async () => {
        const key = `${office.officeId}/purge-test/${randomUUID()}.txt`;
        await storage.put(key, Buffer.from('x'), { contentType: 'text/plain' });
        return key;
      });
    const leavingKey = await put(leaving);
    const stayingKey = await put(staying);
    const before = await rowsOf(staying.officeId);

    // Not due: the function refuses, the job leaves it alone.
    await expect(raw.$queryRaw`SELECT nlq_purge_office(${leaving.officeId}::uuid)`).rejects.toThrow(
      /not due/,
    );
    await raw.office.update({
      where: { id: leaving.officeId },
      data: { deletionRequestedAt: new Date(), deletionScheduledFor: new Date(Date.now() - 1000) },
    });
    const result = await app.get(OfficePurge).run();
    expect(result.purged).toBeGreaterThanOrEqual(1);

    const after = await rowsOf(leaving.officeId);
    const left = Object.entries(after).filter(([table, n]) => !KEPT.has(table) && n > 0);
    expect(left).toEqual([]);
    expect(await rowsOf(staying.officeId)).toEqual(before);

    const office = await raw.office.findUniqueOrThrow({ where: { id: leaving.officeId } });
    expect(office).toMatchObject({ isActive: false, email: null, taxId: '562-000-111' });
    expect(office.purgedAt).not.toBeNull();

    const [kept] = await raw.retainedInvoice.findMany({
      where: { officeId: leaving.officeId, invoiceNumber: 'INV-2026-00001' },
    });
    expect(kept?.snapshot).toMatchObject({
      client: issued.client.displayName,
      office: { name: 'Purged office', taxId: '562-000-111' },
      total: '100',
    });
    expect(kept?.retainUntil.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 7);

    const audit = await raw.auditLog.findMany({ where: { officeId: leaving.officeId } });
    expect(audit.length).toBeGreaterThan(0);
    for (const row of audit.filter(
      (r) => (r.newValues as { deletion?: string } | null)?.deletion !== 'PURGED',
    )) {
      expect(row).toMatchObject({
        userId: null,
        clientUserId: null,
        oldValues: null,
        newValues: null,
        ipAddress: null,
      });
    }
    const settings = await raw.officeSettings.findUniqueOrThrow({
      where: { officeId: leaving.officeId },
    });
    expect(settings.maxAuditRetentionDays).toBe(7 * 365);

    const exists = (office: Seeded, key: string) =>
      tenant.run({ officeId: office.officeId as OfficeId }, () => storage.head(key));
    expect(await exists(leaving, leavingKey)).toBeNull();
    expect(await exists(staying, stayingKey)).not.toBeNull();

    // A second run finds nothing more to do for it.
    await app.get(OfficePurge).run();
    expect(
      Object.entries(await rowsOf(leaving.officeId)).filter(([t, n]) => !KEPT.has(t) && n > 0),
    ).toEqual([]);
    await tenant.run({ officeId: staying.officeId as OfficeId }, () => storage.delete(stayingKey));
  }, 120_000);
});
