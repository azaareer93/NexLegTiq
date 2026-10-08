import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';

import { PrismaService } from './prisma.service';
import { TENANT_ISOLATION_MATRIX } from './tenant-isolation.matrix';
import type { SeededOffice } from './tenant-isolation.matrix';
import { TENANT_MODELS } from './tenant-models';
import { AppModule } from '../app/app.module';
import { configureApp } from '../app/configure-app';
import { integrationEnv } from '../config/env.fixture';
import type { PrismaClient } from '../generated/prisma/client';
import { bearerFor } from '../modules/auth/auth.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };

const WITH_HTTP = TENANT_ISOLATION_MATRIX.flatMap((resource) =>
  resource.http ? [{ ...resource, http: resource.http }] : [],
);

/**
 * D-019 through HTTP for every matrix entry with endpoints: office A's manager — who may see everything of A — gets
 * office B's row in no list, and 404 RES-001 for get, update and delete.
 */
describe('tenant isolation over HTTP (two offices)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let a: SeededOffice;
  let b: SeededOffice;
  const savedEnv = { ...process.env };

  async function seedOffice(name: string): Promise<SeededOffice> {
    const office = await raw.office.create({ data: { name, settings: { create: {} } } });
    const user = await raw.user.create({
      data: {
        officeId: office.id,
        fullName: 'Manager',
        email: `iso-http-${randomUUID()}@example.test`,
        passwordHash: '!',
        role: 'OFFICE_MANAGER',
      },
    });
    return { officeId: office.id, userId: user.id, planId: '' };
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
    // unscoped: fixtures for two offices.
    raw = app.get(PrismaService).unscoped();
    a = await seedOffice('HTTP isolation A');
    b = await seedOffice('HTTP isolation B');
  });

  afterAll(async () => {
    if (raw) {
      const ids = [a?.officeId, b?.officeId].filter((id): id is string => id !== undefined);
      const where = { officeId: { in: ids } };
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const name = model.charAt(0).toLowerCase() + model.slice(1);
        await (raw as unknown as Record<string, Delegate>)[name]?.deleteMany({ where });
      }
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: ids } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should cover at least the legal files', () => {
    expect(WITH_HTTP.map((resource) => resource.model)).toContain('LegalFile');
  });

  it.each(WITH_HTTP.map((resource) => [resource.model, resource] as const))(
    "%s: another office's row is in no list and 404 RES-001 for get, update and delete",
    async (_model, resource) => {
      const { http } = resource;
      const theirs = await resource.create(raw, b);
      const auth = bearerFor(app.get(JwtService), { ...a, role: 'OFFICE_MANAGER' });
      const server = () => request(app.getHttpServer());

      const list = await server().get(`/api/v1/${http.list}?limit=100`).set(auth).expect(200);
      expect((list.body as { data: { id: string }[] }).data.map((row) => row.id)).not.toContain(
        theirs.id,
      );
      for (const call of [
        () =>
          server()
            .get(`/api/v1/${http.item(theirs.id)}`)
            .set(auth),
        () =>
          server()
            .patch(`/api/v1/${http.item(theirs.id)}`)
            .set(auth)
            .send(resource.update),
        () =>
          server()
            .delete(`/api/v1/${http.item(theirs.id)}`)
            .set(auth),
      ]) {
        const res = await call();
        expect({ status: res.status, body: res.body as unknown }).toMatchObject({
          status: 404,
          body: { error: { code: 'RES-001' } },
        });
      }
    },
  );
});
