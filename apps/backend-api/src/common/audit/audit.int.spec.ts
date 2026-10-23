import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../../modules/auth/auth.test-helper';
import { liveSubscription } from '../../modules/subscriptions/subscription.test-helper';

const DAY_MS = 86_400_000;

/** The audit service, append-only grants, retention purge and VIEW throttling (MVP-104, D-136) on real PostgreSQL. */
describe('audit log (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function office(retentionDays = 365) {
    const created = await raw.office.create({
      data: {
        name: 'Audit office',
        settings: { create: { auditRetentionDays: retentionDays } },
        subscriptions: liveSubscription(),
      },
    });
    officeIds.push(created.id);
    const manager = await raw.user.create({
      data: {
        officeId: created.id,
        fullName: 'Manager',
        email: `audit-${randomUUID()}@example.test`,
        passwordHash: '!',
        role: 'OFFICE_MANAGER',
      },
    });
    return { officeId: created.id, userId: manager.id, role: 'OFFICE_MANAGER' as const };
  }

  const row = (officeId: string, daysAgo: number) =>
    raw.auditLog.create({
      data: {
        officeId,
        entityType: 'Probe',
        action: 'UPDATE',
        occurredAt: new Date(Date.now() - daysAgo * DAY_MS),
      },
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
    // unscoped: test fixtures across offices, and a role with the app's audit grants (INSERT/SELECT, EXECUTE purge).
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    await raw.$executeRaw`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nlq_audit_probe') THEN
        CREATE ROLE nlq_audit_probe NOLOGIN;
      END IF;
    END $$`;
    await raw.$executeRaw`GRANT SELECT, INSERT ON audit_logs TO nlq_audit_probe`;
    await raw.$executeRaw`GRANT EXECUTE ON FUNCTION nlq_purge_audit_logs(uuid) TO nlq_audit_probe`;
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      // Test cleanup runs as the superuser: the log is append-only only for the app role.
      await raw.auditLog.deleteMany({ where });
      await raw.legalFile.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should refuse UPDATE and DELETE to a role with the app grants, while the purge still runs', async () => {
    const { officeId } = await office();
    const old = await row(officeId, 400);
    const asApp = <T>(work: (tx: Pick<PrismaClient, '$executeRaw' | '$queryRaw'>) => Promise<T>) =>
      raw.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE nlq_audit_probe`;
        return work(tx);
      });
    await expect(
      asApp(
        (tx) => tx.$executeRaw`UPDATE audit_logs SET entity_type = 'x' WHERE id = ${old.id}::uuid`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp((tx) => tx.$executeRaw`DELETE FROM audit_logs WHERE id = ${old.id}::uuid`),
    ).rejects.toThrow(/permission denied/);
    const [purged] = await asApp(
      (tx) =>
        tx.$queryRaw<
          { removed: number }[]
        >`SELECT nlq_purge_audit_logs(${officeId}::uuid) AS removed`,
    );
    expect(purged?.removed).toBe(1);
  });

  it("should purge only rows older than the office's retention, never under 365 days", async () => {
    const short = await office(365);
    const long = await office(730);
    for (const { officeId } of [short, long]) {
      await row(officeId, 10);
      await row(officeId, 400);
      await row(officeId, 800);
    }
    await raw.$queryRaw`SELECT nlq_purge_audit_logs(${short.officeId}::uuid)`;
    await raw.$queryRaw`SELECT nlq_purge_audit_logs(${long.officeId}::uuid)`;
    expect(
      await raw.auditLog.count({ where: { officeId: short.officeId, entityType: 'Probe' } }),
    ).toBe(1);
    expect(
      await raw.auditLog.count({ where: { officeId: long.officeId, entityType: 'Probe' } }),
    ).toBe(2);
  });

  it('should audit opening a file once per user every 10 minutes, with the request facts', async () => {
    const manager = await office();
    const file = await raw.legalFile.create({
      data: {
        officeId: manager.officeId,
        fileNumber: `A-${randomUUID().slice(0, 8)}`,
        title: 'Viewed file',
        fileType: 'LITIGATION',
        responsibleLawyerId: manager.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await http()
        .get(`/api/v1/cases/${file.id}`)
        .set(bearerFor(jwt, manager))
        .set('User-Agent', 'audit-test/1.0')
        .set('x-request-id', 'req-audit-0001')
        .expect(200);
    }
    const views = await raw.auditLog.findMany({
      where: { entityType: 'LegalFile', entityId: file.id, action: 'VIEW' },
    });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      userId: manager.userId,
      userAgent: 'audit-test/1.0',
      requestId: 'req-audit-0001',
    });
    expect(views[0]?.ipAddress).toBeTruthy();

    // Ten minutes later it counts again.
    await raw.auditLog.updateMany({
      where: { id: views[0]?.id },
      data: { occurredAt: new Date(Date.now() - 11 * 60_000) },
    });
    await http().get(`/api/v1/cases/${file.id}`).set(bearerFor(jwt, manager)).expect(200);
    expect(
      await raw.auditLog.count({
        where: { entityType: 'LegalFile', entityId: file.id, action: 'VIEW' },
      }),
    ).toBe(2);
  });
});
