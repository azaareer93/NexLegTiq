import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { DirectoryUser } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';

interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}

/** `GET /users/directory` (D-123) through HTTP on real PostgreSQL. */
describe('users directory (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  const http = () => request(app.getHttpServer());

  async function seedUser(
    officeId: string,
    role: Role,
    fullName: string,
    isActive = true,
  ): Promise<SeededUser> {
    const user = await raw.user.create({
      data: {
        officeId,
        fullName,
        email: `users-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
        isActive,
      },
    });
    return { userId: user.id, officeId, role };
  }

  async function seedOffice(): Promise<string> {
    const office = await raw.office.create({
      data: { name: 'Users office', settings: { create: {} } },
    });
    officeIds.push(office.id);
    return office.id;
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
    // unscoped: test fixtures across two offices.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.auditLog.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it("should list the office's active people by name, and nobody from another office", async () => {
    const officeId = await seedOffice();
    const manager = await seedUser(officeId, 'OFFICE_MANAGER', 'Basma Office');
    const lawyer = await seedUser(officeId, 'LAWYER', 'Adel Lawyer');
    await seedUser(officeId, 'PARALEGAL', 'Former Paralegal', false);
    const collaborator = await seedUser(officeId, 'EXTERNAL_COLLABORATOR', 'Ziad Outside');
    await seedUser(await seedOffice(), 'LAWYER', 'Other Office Lawyer');

    const res = await http().get('/api/v1/users/directory').set(bearerFor(jwt, lawyer)).expect(200);
    expect((res.body as { data: DirectoryUser[] }).data).toEqual([
      { id: lawyer.userId, fullName: 'Adel Lawyer', role: 'LAWYER' },
      { id: manager.userId, fullName: 'Basma Office', role: 'OFFICE_MANAGER' },
      { id: collaborator.userId, fullName: 'Ziad Outside', role: 'EXTERNAL_COLLABORATOR' },
    ]);
  });

  it.each(['TRAINEE', 'EXTERNAL_COLLABORATOR'] as const)(
    'should refuse the directory to a %s (403 AUTH-100)',
    async (role) => {
      const user = await seedUser(await seedOffice(), role, 'Limited');
      const res = await http().get('/api/v1/users/directory').set(bearerFor(jwt, user)).expect(403);
      expect((res.body as { error: { code: string } }).error.code).toBe('AUTH-100');
    },
  );

  it('should refuse the directory without a token (401 AUTH-003)', async () => {
    const res = await http().get('/api/v1/users/directory').expect(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('AUTH-003');
  });
});
