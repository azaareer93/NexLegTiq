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

const FILES = 5_000;
const WARM_UP = 3;
const RUNS = 15;
/** MVP-57 budget: P95 < 500 ms for the list, measured through HTTP (guards, envelope, serialization included). */
const BUDGET_MS = 500;

/** The case list stays within its budget with 5k files in one office (MVP-57 test notes). */
describe('GET /cases with 5k files (performance)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let officeId: string;
  const users: Record<'manager' | 'lawyer', { userId: string; officeId: string; role: Role }> =
    {} as never;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    // unscoped: bulk fixture data for one office.
    raw = app.get(PrismaService).unscoped();

    officeId = (await raw.office.create({ data: { name: 'Performance office' } })).id;
    for (const [key, role] of [
      ['manager', 'OFFICE_MANAGER'],
      ['lawyer', 'LAWYER'],
    ] as const) {
      const user = await raw.user.create({
        data: {
          officeId,
          fullName: key,
          email: `perf-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      users[key] = { userId: user.id, officeId, role };
    }
    const client = await raw.client.create({
      data: { officeId, clientType: 'INDIVIDUAL', displayName: 'Bulk client' },
    });
    const files = Array.from({ length: FILES }, (_, index) => ({
      id: randomUUID(),
      officeId,
      fileNumber: `PERF-${String(index).padStart(5, '0')}`,
      title: `Performance file ${index}`,
      fileType: index % 2 ? ('LITIGATION' as const) : ('RENTAL_AGREEMENT' as const),
      status: index % 5 ? ('OPEN' as const) : ('CLOSED' as const),
      // A tenth of the files belong to the lawyer, the rest to the manager.
      responsibleLawyerId: index % 10 ? users.manager.userId : users.lawyer.userId,
      jurisdiction: 'PALESTINE' as const,
      currency: 'ILS',
    }));
    for (let start = 0; start < FILES; start += 1_000) {
      await raw.legalFile.createMany({ data: files.slice(start, start + 1_000) });
    }
    await raw.fileClient.createMany({
      data: files.map((file) => ({
        officeId,
        fileId: file.id,
        clientId: client.id,
        isPrimary: true,
      })),
    });
    await raw.$executeRaw`ANALYZE legal_files, file_clients, file_team_members`;
  }, 120_000);

  afterAll(async () => {
    if (raw && officeId) {
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const name = model.charAt(0).toLowerCase() + model.slice(1);
        await (raw as unknown as Record<string, Delegate>)[name]?.deleteMany({
          where: { officeId },
        });
      }
      await raw.user.deleteMany({ where: { officeId } });
      await raw.office.delete({ where: { id: officeId } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  async function p95(user: (typeof users)['manager'], query: string): Promise<number> {
    const auth = bearerFor(app.get(JwtService), user);
    const call = () =>
      request(app.getHttpServer()).get(`/api/v1/cases${query}`).set(auth).expect(200);
    for (let run = 0; run < WARM_UP; run += 1) await call(); // connection pool and query plans warm
    const timings: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      await call();
      timings.push(performance.now() - started);
    }
    timings.sort((x, y) => x - y);
    return timings[Math.ceil(RUNS * 0.95) - 1] ?? Infinity;
  }

  it.each([
    ['the manager, default sort', 'manager', ''],
    [
      'the manager, open litigation files by title',
      'manager',
      '?status=OPEN&fileType=LITIGATION&sort=title:asc',
    ],
    ['the manager, a deep page', 'manager', '?page=200&limit=20'],
    ['the manager, a search', 'manager', '?search=file%204999'],
    ['an assigned-only lawyer', 'lawyer', ''],
  ] as const)(
    `should list for %s within ${BUDGET_MS} ms (P95 of ${RUNS})`,
    async (_case, key, query) => {
      expect(await p95(users[key], query)).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );
});
