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
import { FieldCipher } from '../../common/crypto/field-cipher';
import { StorageService } from '../../common/storage/storage.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_ISOLATION_MATRIX } from '../../database/tenant-isolation.matrix';
import type { SeededOffice } from '../../database/tenant-isolation.matrix';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { PasswordHasher } from '../auth/password-hasher';
import { newTotpSecret, totpCode, totpStep } from '../platform-auth/totp';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

const PASSWORD = 'Deletion-Correct-Horse-9';
const DAY_MS = 86_400_000;
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
  const clientUserIds: string[] = [];
  const savedEnv = { ...process.env };

  const http = () => request(app.getHttpServer());
  const as = (user: Seeded) => bearerFor(jwt, user);
  const codeOf = (res: { body: unknown }) => (res.body as ErrorBody).error.code;
  const detailsOf = (res: { body: unknown }) => (res.body as ErrorBody).error.details;
  const ask = (user: Seeded, body: object) =>
    http().post('/api/v1/offices/me/delete-request').set(as(user)).send(body);
  const cancel = (user: Seeded) =>
    http().post('/api/v1/offices/me/delete-request/cancel').set(as(user));

  async function seedUser(officeId: string, role: Role, extra: object = {}): Promise<Seeded> {
    const user = await raw.user.create({
      data: {
        officeId,
        fullName: role,
        email: `deletion-${randomUUID()}@example.test`,
        passwordHash: await app.get(PasswordHasher).hash(PASSWORD),
        role,
        ...extra,
      },
    });
    const plan = await raw.plan.findFirstOrThrow({ select: { id: true } });
    return { officeId, userId: user.id, planId: plan.id, role };
  }

  async function seedOffice(name: string, settings = true): Promise<Seeded> {
    const office = await raw.office.create({
      data: {
        name,
        email: 'office@example.test',
        phone: '+970 2 000 0000',
        address: 'Ramallah',
        website: 'https://office.example.test',
        taxId: '562-000-111',
        ...(settings ? { settings: { create: {} }, subscriptions: liveSubscription() } : {}),
      },
    });
    officeIds.push(office.id);
    return seedUser(office.id, 'OFFICE_MANAGER');
  }

  async function portalUser(): Promise<string> {
    const user = await raw.clientUser.create({
      data: {
        email: `deletion-portal-${randomUUID()}@example.test`,
        fullName: 'Portal',
        passwordHash: '!',
      },
    });
    clientUserIds.push(user.id);
    return user.id;
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
  const leftIn = async (officeId: string) =>
    Object.entries(await rowsOf(officeId)).filter(([table, n]) => !KEPT.has(table) && n > 0);

  /** One clock: the invoice is kept as issued, until records_retained_until, about 7 years after the purge (any year). */
  async function expectOneClock(officeId: string, clientName: string): Promise<void> {
    const office = await raw.office.findUniqueOrThrow({ where: { id: officeId } });
    const kept = await raw.retainedInvoice.findFirstOrThrow({
      where: { officeId, invoiceNumber: 'INV-2026-00001' },
    });
    expect(kept.snapshot).toMatchObject({
      client: clientName,
      office: { name: 'Purged office', taxId: '562-000-111' },
      total: '100',
    });
    expect(office.recordsRetainedUntil).toEqual(kept.retainUntil);
    const purgedAt = office.purgedAt ?? new Date(0);
    const keptDays = (kept.retainUntil.getTime() - purgedAt.getTime()) / DAY_MS;
    expect(keptDays).toBeGreaterThanOrEqual(7 * 365 - 1);
    expect(keptDays).toBeLessThanOrEqual(7 * 366 + 1);
  }

  /** Pseudonyms per actor by first appearance; entity, action and time kept; exactly one PURGED row. Returns every row. */
  async function expectPseudonymizedAudit(
    officeId: string,
    before: readonly { id: string; entityType: string; action: string; occurredAt: Date }[],
  ) {
    const audit = await raw.auditLog.findMany({ where: { officeId }, orderBy: { id: 'asc' } });
    const isPurged = (r: (typeof audit)[number]) =>
      (r.newValues as { deletion?: string } | null)?.deletion === 'PURGED';
    expect(audit.filter(isPurged)).toHaveLength(1);
    const anonymized = audit.filter((r) => !isPurged(r));
    expect(
      anonymized.map(({ id, entityType, action, occurredAt }) => ({
        id,
        entityType,
        action,
        occurredAt,
      })),
    ).toEqual(before);
    for (const row of anonymized) {
      expect(row).toMatchObject({
        userId: null,
        clientUserId: null,
        oldValues: null,
        newValues: null,
        ipAddress: null,
        userAgent: null,
        requestId: null,
      });
    }
    const refs = new Map(anonymized.map((r) => [`${r.entityType}:${r.action}`, r.actorRef]));
    expect(refs.get('ProbeOld:UPDATE')).toBe('User 1'); // the colleague acted first (two years ago)
    expect(refs.get('ProbeAgain:DELETE')).toBe('User 1'); // the same person keeps the same pseudonym
    expect(refs.get('ProbeNew:CREATE')).toBe('User 2');
    expect(refs.get('ProbePortal:CREATE')).toBe('Client 1');
    return audit;
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
      const keep = new Date(Date.now() + 2 * 365 * DAY_MS);
      // Live offices are emptied the same way as purged ones; then only the kept tables need clearing.
      for (const id of officeIds) {
        await raw.office.updateMany({
          where: { id, purgedAt: null },
          data: { deletionScheduledFor: new Date(Date.now() - 1000) },
        });
        await raw.$queryRaw`SELECT nlq_purge_office(${id}::uuid, ${keep}::timestamptz)`.catch(
          () => undefined,
        );
      }
      await raw.retainedInvoice.deleteMany({ where });
      await raw.auditLog.deleteMany({ where });
      await raw.platformPayment.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
      await raw.clientUser.deleteMany({ where: { id: { in: clientUserIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should ask for the password, make the office read-only for 30 days, and let any office manager cancel', async () => {
    const manager = await seedOffice('Leaving office');
    const second = await seedUser(manager.officeId, 'OFFICE_MANAGER');
    const lawyer = await seedUser(manager.officeId, 'LAWYER');
    const other = await seedOffice('Staying office');

    // Only office managers: the lawyer may neither read, ask nor cancel.
    expect(codeOf(await ask(lawyer, { password: PASSWORD }).expect(403))).toBe('AUTH-100');
    expect(
      codeOf(await http().get('/api/v1/offices/me/delete-request').set(as(lawyer)).expect(403)),
    ).toBe('AUTH-100');
    expect(codeOf(await cancel(lawyer).expect(403))).toBe('AUTH-100');

    expect(detailsOf(await ask(manager, { password: 'not-the-password' }).expect(400))).toEqual([
      { field: 'password', message: 'validation.password.currentWrong' },
    ]);
    await ask(manager, { password: PASSWORD, mfaCode: '12' }).expect(400);

    const asked = await ask(manager, { password: PASSWORD }).expect(200);
    const scheduledFor = Date.parse(asked.body.data.scheduledFor as string);
    expect(scheduledFor - Date.now()).toBeGreaterThan(29.9 * DAY_MS);
    expect(scheduledFor - Date.now()).toBeLessThan(30.1 * DAY_MS);
    expect(codeOf(await ask(manager, { password: PASSWORD }).expect(409))).toBe('RES-003');

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

    // Another office manager cancels the first one's request; writes work again.
    await cancel(second).expect(200);
    await patch(manager).expect(200);
    await cancel(manager).expect(409);
    const status = await http()
      .get('/api/v1/offices/me/delete-request')
      .set(as(manager))
      .expect(200);
    expect(status.body.data).toEqual({ requestedAt: null, scheduledFor: null });

    const audit = await raw.auditLog.findMany({
      where: { officeId: manager.officeId, entityType: 'Office', action: 'SECURITY' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(
      audit.map((row) => [(row.newValues as { deletion: string }).deletion, row.userId]),
    ).toEqual([
      ['REQUESTED', manager.userId],
      ['CANCELLED', second.userId],
    ]);
  });

  it('should ask for the authenticator code when MFA is on: required, checked, then accepted', async () => {
    const office = await seedOffice('MFA office');
    const secret = newTotpSecret();
    const id = randomUUID();
    const manager = await seedUser(office.officeId, 'OFFICE_MANAGER', {
      id,
      mfaEnabled: true,
      mfaSecret: app.get(FieldCipher).encrypt(secret, `users.mfa_secret:${id}`),
    });

    expect(detailsOf(await ask(manager, { password: PASSWORD }).expect(400))).toEqual([
      { field: 'mfaCode', message: 'validation.required' },
    ]);
    const now = totpCode(secret, totpStep(new Date()));
    const wrong = now === '000000' ? '111111' : '000000';
    expect(
      detailsOf(await ask(manager, { password: PASSWORD, mfaCode: wrong }).expect(400)),
    ).toEqual([{ field: 'mfaCode', message: 'validation.totpWrong' }]);
    const done = await ask(manager, { password: PASSWORD, mfaCode: now }).expect(200);
    expect(done.body.data.scheduledFor).not.toBeNull();
  });

  it('should answer 409 instead of waiting when a purge holds the office (lock_timeout)', async () => {
    const manager = await seedOffice('Locked office');
    await ask(manager, { password: PASSWORD }).expect(200);
    // A purge's lock on the office row, held while the cancel arrives.
    await raw.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM offices WHERE id = ${manager.officeId}::uuid FOR UPDATE`;
        const started = Date.now();
        expect(codeOf(await cancel(manager).expect(409))).toBe('RES-003');
        expect(Date.now() - started).toBeLessThan(10_000);
      },
      { timeout: 20_000 },
    );
    await cancel(manager).expect(200);
  }, 60_000);

  it('should purge every row and object of the office past its date, keep the legal records, and touch no other office', async () => {
    const leaving = await seedOffice('Purged office', false);
    const staying = await seedOffice('Other office', false);
    for (const office of [leaving, staying]) {
      for (const resource of TENANT_ISOLATION_MATRIX) await resource.create(raw, office);
    }
    const colleague = await seedUser(leaving.officeId, 'LAWYER');
    // An issued invoice is kept as issued; the matrix's draft (no number) is not.
    const issued = await raw.invoice.findFirstOrThrow({
      where: { officeId: leaving.officeId, invoiceNumber: null },
      include: { client: true },
    });
    await raw.invoice.update({
      where: { id: issued.id },
      data: { invoiceNumber: 'INV-2026-00001', status: 'SENT', issueDate: new Date('2026-11-01') },
    });
    await raw.platformPayment.updateMany({
      where: { officeId: leaving.officeId },
      data: { pdfStorageKey: `${leaving.officeId}/receipts/r.pdf`, pdfLanguage: 'AR' },
    });

    // Two staff actors and one portal actor, all to be pseudonymized; one old row the D-136 rule alone would purge.
    const portalOnlyHere = await portalUser();
    const portalSeenElsewhere = await portalUser();
    const clientId = (await raw.client.findFirstOrThrow({ where: { officeId: leaving.officeId } }))
      .id;
    for (const clientUserId of [portalOnlyHere, portalSeenElsewhere]) {
      await raw.clientPortalAccess.create({
        data: { officeId: leaving.officeId, clientUserId, clientId, grantedById: leaving.userId },
      });
    }
    const twoYearsAgo = new Date(Date.now() - 2 * 365 * DAY_MS);
    await raw.auditLog.createMany({
      data: [
        {
          officeId: leaving.officeId,
          userId: colleague.userId,
          entityType: 'ProbeOld',
          action: 'UPDATE',
          occurredAt: twoYearsAgo,
          newValues: { title: 'secret' },
          ipAddress: '10.0.0.1',
        },
        {
          officeId: leaving.officeId,
          userId: leaving.userId,
          entityType: 'ProbeNew',
          action: 'CREATE',
        },
        {
          officeId: leaving.officeId,
          userId: colleague.userId,
          entityType: 'ProbeAgain',
          action: 'DELETE',
        },
        {
          officeId: leaving.officeId,
          clientUserId: portalOnlyHere,
          entityType: 'ProbePortal',
          action: 'CREATE',
          occurredAt: twoYearsAgo,
        },
        // Another office's row naming the second portal user: that account cannot be deleted, only anonymized.
        {
          officeId: staying.officeId,
          clientUserId: portalSeenElsewhere,
          entityType: 'Probe',
          action: 'VIEW',
        },
      ],
    });

    const storage = app.get(StorageService);
    const tenant = app.get(TenantRunner);
    const put = (office: Seeded) =>
      tenant.run({ officeId: office.officeId as OfficeId }, async () => {
        const key = `${office.officeId}/purge-test/${randomUUID()}.txt`;
        await storage.put(key, Buffer.from('x'), { contentType: 'text/plain' });
        return key;
      });
    const exists = (office: Seeded, key: string) =>
      tenant.run({ officeId: office.officeId as OfficeId }, () => storage.head(key));
    const leavingKey = await put(leaving);
    const stayingKey = await put(staying);
    const before = await rowsOf(staying.officeId);
    const subscriptionsBefore = await raw.subscription.count({
      where: { officeId: leaving.officeId },
    });
    const auditBefore = await raw.auditLog.findMany({
      where: { officeId: leaving.officeId },
      select: { id: true, entityType: true, action: true, occurredAt: true },
      orderBy: { id: 'asc' },
    });

    // Not due: the function refuses, and refuses a retention under a year even for a due office.
    const keep = new Date(Date.now() + 7 * 365 * DAY_MS);
    await expect(
      raw.$queryRaw`SELECT nlq_purge_office(${leaving.officeId}::uuid, ${keep}::timestamptz)`,
    ).rejects.toThrow(/not due/);
    await raw.office.update({
      where: { id: leaving.officeId },
      data: { deletionRequestedAt: new Date(), deletionScheduledFor: new Date(Date.now() - 1000) },
    });
    const soon = new Date(Date.now() + 30 * DAY_MS);
    await expect(
      raw.$queryRaw`SELECT nlq_purge_office(${leaving.officeId}::uuid, ${soon}::timestamptz)`,
    ).rejects.toThrow(/at least one year/);

    expect((await app.get(OfficePurge).run()).purged).toBeGreaterThanOrEqual(1);

    expect(await leftIn(leaving.officeId)).toEqual([]);
    expect(await rowsOf(staying.officeId)).toEqual(before);

    const office = await raw.office.findUniqueOrThrow({ where: { id: leaving.officeId } });
    expect(office).toMatchObject({
      isActive: false,
      email: null,
      phone: null,
      address: null,
      website: null,
      taxId: '562-000-111',
      name: 'Purged office',
    });
    expect(office.purgedAt).not.toBeNull();

    // Our own records stay: subscriptions untouched, payments kept without their deleted receipt PDF.
    expect(await raw.subscription.count({ where: { officeId: leaving.officeId } })).toBe(
      subscriptionsBefore,
    );
    const payments = await raw.platformPayment.findMany({ where: { officeId: leaving.officeId } });
    expect(payments.length).toBeGreaterThan(0);
    expect(payments.every((p) => p.pdfStorageKey === null && p.pdfLanguage === null)).toBe(true);

    await expectOneClock(leaving.officeId, issued.client.displayName);
    const audit = await expectPseudonymizedAudit(leaving.officeId, auditBefore);

    // Former portal users: deleted when nothing else names them, anonymized when another office's row does.
    expect(await raw.clientUser.findUnique({ where: { id: portalOnlyHere } })).toBeNull();
    expect(
      await raw.clientUser.findUniqueOrThrow({ where: { id: portalSeenElsewhere } }),
    ).toMatchObject({
      email: `${portalSeenElsewhere}@purged.invalid`,
      fullName: '',
      isActive: false,
    });

    expect(await exists(leaving, leavingKey)).toBeNull();
    expect(await exists(staying, stayingKey)).not.toBeNull();

    // The audit purge keeps the purged office's rows, even two years old, until records_retained_until...
    const purgeAudit = async (): Promise<number> => {
      const [row] = await raw.$queryRaw<{ removed: number }[]>`
        SELECT nlq_purge_audit_logs(${leaving.officeId}::uuid) AS removed`;
      return Number(row?.removed);
    };
    expect(await purgeAudit()).toBe(0);
    // ...then the log and the invoices go together.
    const past = new Date(Date.now() - 1000);
    await raw.office.update({
      where: { id: leaving.officeId },
      data: { recordsRetainedUntil: past },
    });
    await raw.retainedInvoice.updateMany({
      where: { officeId: leaving.officeId },
      data: { retainUntil: past },
    });
    expect(await purgeAudit()).toBe(audit.length);
    expect((await app.get(OfficePurge).run()).expired).toBeGreaterThanOrEqual(1);
    expect(await raw.retainedInvoice.count({ where: { officeId: leaving.officeId } })).toBe(0);

    // A second run finds nothing more to do for it.
    await app.get(OfficePurge).run();
    expect(await leftIn(leaving.officeId)).toEqual([]);
    await tenant.run({ officeId: staying.officeId as OfficeId }, () => storage.delete(stayingKey));
  }, 180_000);

  it('should leave an office alone when its deletion was cancelled after the run listed it', async () => {
    const manager = await seedOffice('Changed its mind');
    await ask(manager, { password: PASSWORD }).expect(200);
    // Past due, as the run saw it...
    await raw.office.update({
      where: { id: manager.officeId },
      data: { deletionScheduledFor: new Date(Date.now() - 1000) },
    });
    const key = await app
      .get(TenantRunner)
      .run({ officeId: manager.officeId as OfficeId }, async () => {
        const k = `${manager.officeId}/race/${randomUUID()}.txt`;
        await app.get(StorageService).put(k, Buffer.from('x'), { contentType: 'text/plain' });
        return k;
      });
    // ...then cancelled before its turn: the locked re-check skips it, and nothing is deleted.
    await cancel(manager).expect(200);
    await expect(app.get(OfficePurge).purge(manager.officeId as OfficeId)).resolves.toBe(false);
    const head = await app
      .get(TenantRunner)
      .run({ officeId: manager.officeId as OfficeId }, () => app.get(StorageService).head(key));
    expect(head).not.toBeNull();
    expect(await raw.user.count({ where: { officeId: manager.officeId } })).toBe(1);
    await app
      .get(TenantRunner)
      .run({ officeId: manager.officeId as OfficeId }, () => app.get(StorageService).delete(key));
  });
});
