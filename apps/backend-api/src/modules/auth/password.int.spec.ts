import { randomUUID } from 'node:crypto';

import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';

import { PasswordHasher } from './password-hasher';
import { PasswordResetLinks } from './password-reset-links';
import { REFRESH_COOKIE } from './refresh-token';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { hashOpaqueToken, newOpaqueToken } from '../../common/auth/opaque-token';
import { QUEUE, QUEUE_NAMES } from '../../common/queue/queues';
import { getQueue } from '../../common/queue/testing';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';

const ORIGIN = 'http://localhost:4200';
const csrf = { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
const PASSWORD = 'Testtesttest1';
const NEW_PASSWORD = 'Newnewnewnew2';

/** MVP-41 on real PostgreSQL and Redis through HTTP: forgot, reset and change password (D-086). */
describe('password reset and change (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const officeIds: string[] = [];
  const emails: string[] = [];
  const savedEnv = { ...process.env };

  async function createApp(options: { throttle: boolean }): Promise<NestExpressApplication> {
    let builder = Test.createTestingModule({ imports: [AppModule] });
    if (!options.throttle)
      builder = builder.overrideProvider(ThrottlerGuard).useValue({ canActivate: () => true });
    const created = (await builder.compile()).createNestApplication<NestExpressApplication>({
      bufferLogs: true,
    });
    configureApp(created);
    await created.init();
    return created;
  }

  async function seedUser() {
    const raw = prisma.unscoped();
    const office = await raw.office.create({ data: { name: 'Password test office' } });
    officeIds.push(office.id);
    const email = `password-${randomUUID()}@example.test`;
    emails.push(email);
    const user = await raw.user.create({
      data: {
        officeId: office.id,
        fullName: 'Password Test',
        email,
        passwordHash: await new PasswordHasher().hash(PASSWORD),
        role: 'LAWYER',
      },
    });
    return { userId: user.id, officeId: office.id, email };
  }

  const http = () => request(app.getHttpServer());
  const login = (email: string, password = PASSWORD) =>
    http().post('/api/v1/auth/login').send({ email, password });
  const cookieOf = (res: request.Response) =>
    (
      ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .find((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`)) ?? ''
    ).split(';')[0] ?? '';
  const refresh = (cookie: string) =>
    http().post('/api/v1/auth/refresh').set('Cookie', cookie).set(csrf);
  const reset = (token: string, password = NEW_PASSWORD) =>
    http()
      .post('/api/v1/auth/reset-password')
      .send({ token, newPassword: password, confirmPassword: password });
  const audits = (user: { userId: string; officeId: string }) =>
    prisma.unscoped().auditLog.findMany({
      where: { officeId: user.officeId, userId: user.userId, action: 'UPDATE' },
      select: { newValues: true },
    });

  /** A second unused reset link, stored directly (the worker would end the first one). */
  async function extraResetLink(user: { userId: string; officeId: string }): Promise<string> {
    const token = newOpaqueToken();
    await prisma.unscoped().passwordResetToken.create({
      data: {
        officeId: user.officeId,
        userId: user.userId,
        tokenHash: hashOpaqueToken(token),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return token;
  }

  /** What the worker does for a reset job: issue a link in the user's office and return its token. */
  async function resetTokenFor(user: { userId: string; officeId: string }): Promise<string> {
    const links = new PasswordResetLinks(prisma, app.get(ClsService), app.get(AppConfig));
    const mail = await app
      .get(TenantRunner)
      .run({ officeId: user.officeId as OfficeId }, () =>
        links.issue(user.userId, new Date(), { retry: true }),
      );
    return new URL(mail?.vars.link ?? 'http://x').searchParams.get('token') ?? '';
  }

  beforeAll(async () => {
    Object.assign(
      process.env,
      integrationEnv({ CORS_ORIGINS: ORIGIN, BULLMQ_PREFIX: `it-${randomUUID().slice(0, 8)}` }),
    );
    app = await createApp({ throttle: false });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const raw = prisma.unscoped();
    const where = { officeId: { in: officeIds } };
    await raw.auditLog.deleteMany({ where });
    await raw.refreshToken.deleteMany({ where });
    await raw.passwordResetToken.deleteMany({ where });
    await raw.user.deleteMany({ where });
    await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    await raw.loginAttempt.deleteMany({ where: { email: { in: emails } } });
    for (const name of QUEUE_NAMES) await getQueue(app, name).obliterate({ force: true });
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  describe('forgot-password', () => {
    it('should answer the same 200 for a known and an unknown email, and ask the worker only for the known one', async () => {
      const user = await seedUser();
      const known = await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: user.email.toUpperCase() })
        .expect(200);
      const unknown = await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: `nobody-${randomUUID()}@example.test` })
        .expect(200);
      expect(unknown.body.data).toEqual(known.body.data);

      // The enqueue is not awaited by the request (same timing either way): wait for it to land.
      const queue = getQueue(app, QUEUE.EMAIL);
      let jobs: Awaited<ReturnType<typeof queue.getJobs>> = [];
      for (let attempt = 0; attempt < 50 && jobs.length === 0; attempt += 1) {
        jobs = (await queue.getJobs(['waiting', 'prioritized'])).filter(
          (job) => job.name === 'send-password-reset',
        );
        if (jobs.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(jobs.map((job) => job.data)).toEqual([
        { userId: user.userId, officeId: user.officeId, requestId: expect.any(String) },
      ]);
      await expect(
        http().post('/api/v1/auth/forgot-password').send({ email: 'nope' }).expect(400),
      ).resolves.toBeDefined();
    });
  });

  describe('reset-password', () => {
    it('should set the new password, end every session, mark the link used and audit', async () => {
      const user = await seedUser();
      const session = cookieOf(await login(user.email).expect(200));
      const token = await resetTokenFor(user);

      const other = await extraResetLink(user);
      const otherOffice = await seedUser();
      const otherSession = cookieOf(await login(otherOffice.email).expect(200));

      await reset(token).expect(204);

      expect((await refresh(session).expect(401)).body.error).toMatchObject({ code: 'AUTH-005' });
      expect((await login(user.email).expect(401)).body.error).toMatchObject({ code: 'AUTH-001' });
      await login(user.email, NEW_PASSWORD).expect(200);
      await expect(audits(user)).resolves.toEqual([{ newValues: { passwordReset: true } }]);
      expect((await reset(token, 'Anotherpass3').expect(410)).body.error).toMatchObject({
        code: 'RES-004',
      });
      // The other link stopped working, and the link proved the address.
      await reset(other, 'Anotherpass3').expect(410);
      await expect(
        prisma.unscoped().user.findUniqueOrThrow({ where: { id: user.userId } }),
      ).resolves.toMatchObject({ emailVerifiedAt: expect.any(Date) });
      // Another office's user is untouched.
      await refresh(otherSession).expect(200);
      await login(otherOffice.email).expect(200);
    });

    it('should let only one of two concurrent resets with the same link succeed', async () => {
      const user = await seedUser();
      const token = await resetTokenFor(user);
      const statuses = (await Promise.all([reset(token), reset(token, 'Anotherpass3')]))
        .map((res) => res.status)
        .sort();
      expect(statuses).toEqual([204, 410]);
      await expect(audits(user)).resolves.toHaveLength(1);
    });

    it('should refuse unknown and expired links, and links of a suspended office, with 410 RES-004 and change nothing', async () => {
      const user = await seedUser();
      const token = await resetTokenFor(user);
      await prisma.unscoped().passwordResetToken.updateMany({
        where: { userId: user.userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await reset(token).expect(410);
      await reset('A'.repeat(43)).expect(410);
      await login(user.email).expect(200);

      const suspended = await seedUser();
      const link = await resetTokenFor(suspended);
      await prisma
        .unscoped()
        .office.update({ where: { id: suspended.officeId }, data: { isActive: false } });
      expect((await reset(link).expect(410)).body.error).toMatchObject({ code: 'RES-004' });
      await expect(audits(suspended)).resolves.toEqual([]);
    });

    it('should answer 400 VAL-001 for a weak or mismatched password', async () => {
      const token = 'A'.repeat(43);
      expect((await reset(token, 'weak').expect(400)).body.error).toMatchObject({
        code: 'VAL-001',
      });
      const mismatch = await http()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD, confirmPassword: 'Different99x' })
        .expect(400);
      expect(mismatch.body.error).toMatchObject({
        code: 'VAL-001',
        details: [expect.objectContaining({ field: 'confirmPassword' })],
      });
    });
  });

  describe('users/me/password', () => {
    it('should change the password, keep this session and end the others', async () => {
      const user = await seedUser();
      const first = await login(user.email).expect(200);
      const other = cookieOf(await login(user.email).expect(200));
      const bearer = { Authorization: `Bearer ${first.body.data.accessToken as string}` };
      const pendingLink = await resetTokenFor(user);

      const wrong = await http()
        .post('/api/v1/users/me/password')
        .set(bearer)
        .send({ currentPassword: 'Wrongwrong99', newPassword: NEW_PASSWORD });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toMatchObject({
        code: 'VAL-001',
        details: [{ field: 'currentPassword' }],
      });

      await http()
        .post('/api/v1/users/me/password')
        .set(bearer)
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(204);

      await refresh(cookieOf(first)).expect(200);
      await refresh(other).expect(401);
      await login(user.email, NEW_PASSWORD).expect(200);
      await expect(audits(user)).resolves.toEqual([{ newValues: { passwordChanged: true } }]);
      // A reset link requested before the change no longer works.
      await reset(pendingLink, 'Anotherpass3').expect(410);
    });

    it('should require authentication', async () => {
      const res = await http()
        .post('/api/v1/users/me/password')
        .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })
        .expect(401);
      expect(res.body.error).toMatchObject({ code: 'AUTH-003' });
    });
  });

  describe('rate limits', () => {
    let limited: NestExpressApplication;

    beforeAll(async () => {
      limited = await createApp({ throttle: true });
    });

    afterAll(async () => {
      await limited?.close();
    });

    it.each([
      [
        'forgot-password',
        '192.0.2.41',
        '/api/v1/auth/forgot-password',
        { email: 'x@example.test' },
        200,
      ],
      [
        'reset-password',
        '192.0.2.42',
        '/api/v1/auth/reset-password',
        { token: 'A'.repeat(43), newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
        410,
      ],
    ])('should allow 5 %s requests a minute per client', async (_label, ip, path, body, status) => {
      const attempt = () =>
        request(limited.getHttpServer()).post(path).set('X-Forwarded-For', ip).send(body);
      for (let i = 0; i < 5; i += 1) await attempt().expect(status);
      expect((await attempt().expect(429)).body.error).toMatchObject({ code: 'RATE-001' });
    });

    it('should allow 5 password changes a minute per client', async () => {
      const user = await seedUser();
      const ip = '192.0.2.43';
      const session = await request(limited.getHttpServer())
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: user.email, password: PASSWORD })
        .expect(200);
      const attempt = () =>
        request(limited.getHttpServer())
          .post('/api/v1/users/me/password')
          .set('X-Forwarded-For', ip)
          .set('Authorization', `Bearer ${session.body.data.accessToken as string}`)
          .send({ currentPassword: 'Wrongwrong99', newPassword: NEW_PASSWORD });
      for (let i = 0; i < 5; i += 1) await attempt().expect(400);
      expect((await attempt().expect(429)).body.error).toMatchObject({ code: 'RATE-001' });
    });
  });
});
