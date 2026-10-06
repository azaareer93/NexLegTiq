import { randomUUID } from 'node:crypto';

import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import request from 'supertest';

import { seedPlans } from '../../../prisma/seed';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { QUEUE, QUEUE_NAMES } from '../../common/queue/queues';
import { getQueue } from '../../common/queue/testing';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { REFRESH_COOKIE } from './refresh-token';
import { LEGAL_VERSIONS } from './signup.repository';
import { VerificationLinks } from './verification-links';
import { AccountMailer } from './account-mailer';

@Controller('__signup_probe__')
class ProbeController {
  @Get()
  me(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

const ORIGIN = 'http://localhost:4200';
const csrf = { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
const DAY = 86_400_000;
const PASSWORD = 'Testtesttest1';

/** MVP-39 on real PostgreSQL through HTTP: signup, duplicate and invalid input, email verification, AUTH-010 (D-083). */
describe('office signup (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  /** Verification emails requested from the worker (the HTTP app only enqueues; D-085). */
  const requested: { userId: string; officeId: string }[] = [];
  const emails: string[] = [];
  const savedEnv = { ...process.env };

  const body = (overrides: object = {}) => {
    const email = `signup-${randomUUID()}@example.test`;
    emails.push(email);
    return {
      fullName: 'عمر المصري',
      email,
      password: PASSWORD,
      officeName: `signup-test-${randomUUID()}`,
      accountType: 'SOLO',
      currency: 'ILS',
      acceptTerms: true,
      acceptPrivacy: true,
      ...overrides,
    };
  };
  async function createApp(options: { throttle: boolean }): Promise<NestExpressApplication> {
    let builder = Test.createTestingModule({ imports: [AppModule, ProbeModule] });
    if (!options.throttle)
      builder = builder.overrideProvider(ThrottlerGuard).useValue({ canActivate: () => true });
    const created = (await builder.compile()).createNestApplication<NestExpressApplication>({
      bufferLogs: true,
    });
    configureApp(created);
    await created.init();
    return created;
  }

  const register = (payload: object) =>
    request(app.getHttpServer()).post('/api/v1/auth/register').send(payload);
  const verify = (token: string) =>
    request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ token });
  /** What the worker does for a verification job: issues a link (in the user's office) and returns its token. */
  async function tokenFor(email: string): Promise<string> {
    const user = await prisma
      .unscoped()
      .user.findUniqueOrThrow({ where: { email }, select: { id: true, officeId: true } });
    const links = new VerificationLinks(prisma, app.get(ClsService), app.get(AppConfig));
    // retry: as a retried job would, so consecutive calls in one test are not held back by the one-a-minute limit.
    const mail = await app
      .get(TenantRunner)
      .run({ officeId: user.officeId as OfficeId }, () =>
        links.issue(user.id, new Date(), { retry: true }),
      );
    return new URL(mail?.vars.link ?? 'http://x').searchParams.get('token') ?? '';
  }

  beforeAll(async () => {
    // Verification enforced, as it will be once emails are delivered (D-083); the flag's default (off) is unit-tested.
    Object.assign(
      process.env,
      // A queue prefix of its own: the verification jobs this file enqueues never reach a dev worker.
      integrationEnv({
        CORS_ORIGINS: ORIGIN,
        EMAIL_VERIFICATION_ENFORCED: 'true',
        BULLMQ_PREFIX: `it-${randomUUID().slice(0, 8)}`,
      }),
    );
    app = await createApp({ throttle: false });
    prisma = app.get(PrismaService);
    // unscoped: test setup — reference plans, as `pnpm nx run backend-api:seed` creates them.
    await seedPlans(prisma.unscoped());
    // Records what is requested and still enqueues for real (no worker consumes this file's queue prefix).
    const mailer = app.get(AccountMailer);
    const enqueue = mailer.sendVerification.bind(mailer);
    jest.spyOn(mailer, 'sendVerification').mockImplementation(async (user, client) => {
      requested.push(user);
      await enqueue(user, client);
    });
  });

  afterAll(async () => {
    const raw = prisma.unscoped();
    const users = await raw.user.findMany({
      // Offices of this file are named signup-test-…: also catches users whose email a reclaim released.
      where: {
        OR: [{ email: { in: emails } }, { office: { name: { startsWith: 'signup-test-' } } }],
      },
      select: { officeId: true },
    });
    const where = { officeId: { in: users.map((user) => user.officeId) } };
    await raw.auditLog.deleteMany({ where });
    await raw.refreshToken.deleteMany({ where });
    await raw.emailVerificationToken.deleteMany({ where });
    await raw.legalAcceptance.deleteMany({ where });
    await raw.subscription.deleteMany({ where });
    await raw.officeSettings.deleteMany({ where });
    await raw.user.deleteMany({ where });
    await raw.office.deleteMany({ where: { id: { in: where.officeId.in } } });
    await raw.loginAttempt.deleteMany({ where: { email: { in: emails } } });
    for (const name of QUEUE_NAMES) await getQueue(app, name).obliterate({ force: true });
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it('should create the office, manager, 6-month freemium, settings and acceptances, and log in (201)', async () => {
    const payload = body({ phone: '+970 59 123 4567' });
    const res = await register(payload).expect(201);

    expect(res.body.data).toMatchObject({
      expiresIn: 900,
      user: {
        email: payload.email,
        role: 'OFFICE_MANAGER',
        officeName: payload.officeName,
        uiLanguage: 'AR',
        emailVerified: false,
      },
    });
    expect(Date.parse(res.body.data.user.verifyBy) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(
      ([] as string[])
        .concat(res.headers['set-cookie'] ?? [])
        .some((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`)),
    ).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);

    const raw = prisma.unscoped();
    const user = await raw.user.findUniqueOrThrow({
      where: { email: payload.email },
      include: { office: { include: { settings: true } } },
    });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.office).toMatchObject({
      accountType: 'SOLO',
      jurisdiction: 'PALESTINE',
      defaultLanguage: 'AR',
      currency: 'ILS',
      phone: '+970 59 123 4567',
    });
    expect(user.office.settings).toMatchObject({
      courtReminderDays: [7, 3, 1],
      fileNumberFormat: '{YEAR}-{TYPE}-{SEQ:5}',
    });

    const subscription = await raw.subscription.findFirstOrThrow({
      where: { officeId: user.officeId },
      include: { plan: true },
    });
    expect(subscription).toMatchObject({ status: 'TRIALING', plan: { code: 'PS_FREE' } });
    expect(
      Math.round(
        ((subscription.trialEndsAt?.getTime() ?? 0) - subscription.currentPeriodStart.getTime()) /
          86_400_000,
      ),
    ).toBe(180);

    const acceptances = await raw.legalAcceptance.findMany({
      where: { userId: user.id },
      orderBy: { documentType: 'asc' },
    });
    expect(acceptances.map((row) => [row.documentType, row.version])).toEqual([
      ['TOS', LEGAL_VERSIONS.TOS],
      ['PRIVACY', LEGAL_VERSIONS.PRIVACY],
    ]);
    const actions = await raw.auditLog.findMany({
      where: { officeId: user.officeId },
      select: { action: true, entityType: true },
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        { action: 'CREATE', entityType: 'Office' },
        { action: 'LOGIN', entityType: 'User' },
      ]),
    );

    // Signup only asks the worker for the email; the worker creates the link (hash only in the database, D-085).
    expect(requested).toContainEqual({ userId: user.id, officeId: user.officeId });
    const jobs = await getQueue(app, QUEUE.EMAIL).getJobs(['waiting', 'prioritized', 'delayed']);
    const job = jobs.find((candidate) => candidate.data.userId === user.id);
    expect(job?.name).toBe('send-verification-email');
    expect(job?.data).toEqual({
      userId: user.id,
      officeId: user.officeId,
      requestId: expect.any(String),
    });
    await expect(raw.emailVerificationToken.count({ where: { userId: user.id } })).resolves.toBe(0);
    const token = await tokenFor(payload.email);
    expect(token).toHaveLength(43);
    const link = await raw.emailVerificationToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(link.tokenHash).not.toBe(token);
  });

  it('should give other jurisdictions a 30-day trial sized by account type, in English', async () => {
    const payload = body({
      jurisdiction: 'JORDAN',
      accountType: 'FIRM',
      defaultLanguage: 'EN',
      currency: 'JOD',
    });
    const res = await register(payload).expect(201);
    expect(res.body.data.user.uiLanguage).toBe('EN');
    const subscription = await prisma.unscoped().subscription.findFirstOrThrow({
      where: { officeId: res.body.data.user.officeId },
      include: { plan: true },
    });
    expect(subscription.plan.code).toBe('GLOBAL_SMALL_FIRM');
    expect(Math.round(((subscription.trialEndsAt?.getTime() ?? 0) - Date.now()) / 86_400_000)).toBe(
      30,
    );
  });

  it('should answer 409 RES-002 for an existing email in any case, also for two signups racing', async () => {
    const payload = body();
    await register(payload).expect(201);
    expect(
      (await register({ ...payload, officeName: 'signup-test-second' }).expect(409)).body.error,
    ).toMatchObject({ code: 'RES-002' });
    await register({ ...payload, email: payload.email.toUpperCase() }).expect(409);

    const racing = body();
    const statuses = (await Promise.all([register(racing), register(racing)]))
      .map((res) => res.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    await expect(prisma.unscoped().user.count({ where: { email: racing.email } })).resolves.toBe(1);
  });

  it.each([
    ['a weak password', { password: 'weakpassword' }],
    ['a well-known password', { password: 'Password123' }],
    ['missing terms acceptance', { acceptTerms: false }],
    ['missing privacy acceptance', { acceptPrivacy: undefined }],
  ])('should answer 400 VAL-001 for %s and create nothing', async (_label, change) => {
    const payload = body(change);
    const res = await register(payload).expect(400);
    expect(res.body.error).toMatchObject({ code: 'VAL-001' });
    await expect(prisma.unscoped().user.count({ where: { email: payload.email } })).resolves.toBe(
      0,
    );
  });

  it('should verify the email once with the link token (204), then refuse it (410 RES-004)', async () => {
    const payload = body();
    const officeId = (await register(payload).expect(201)).body.data.user.officeId as string;
    const token = await tokenFor(payload.email);

    await verify(token).expect(204);
    const user = await prisma
      .unscoped()
      .user.findUniqueOrThrow({ where: { email: payload.email } });
    expect(user.emailVerifiedAt).toEqual(expect.any(Date));
    await expect(
      prisma
        .unscoped()
        .auditLog.count({ where: { officeId, action: 'UPDATE', entityType: 'User' } }),
    ).resolves.toBe(1);
    expect((await verify(token).expect(410)).body.error).toMatchObject({ code: 'RES-004' });

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: payload.email, password: PASSWORD })
      .expect(200);
    expect(login.body.data.user).toMatchObject({ emailVerified: true, verifyBy: null });
  });

  it('should refuse unknown and expired links with 410 RES-004 and change nothing', async () => {
    const payload = body();
    await register(payload).expect(201);
    const token = await tokenFor(payload.email);
    await prisma.unscoped().emailVerificationToken.updateMany({
      where: { user: { email: payload.email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await verify(token).expect(410)).body.error).toMatchObject({ code: 'RES-004' });
    await verify('A'.repeat(43)).expect(410);
    const user = await prisma.unscoped().user.findUniqueOrThrow({
      where: { email: payload.email },
      include: { emailVerifications: true },
    });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.emailVerifications.map((link) => link.usedAt)).toEqual([null]);
  });

  it('should roll the whole signup back when a step fails (no office, no user)', async () => {
    const payload = body();
    const raw = prisma.unscoped();
    await raw.plan.update({ where: { code: 'PS_FREE' }, data: { isActive: false } });
    try {
      expect((await register(payload).expect(500)).body.error).toMatchObject({ code: 'SYS-001' });
    } finally {
      await raw.plan.update({ where: { code: 'PS_FREE' }, data: { isActive: true } });
    }
    await expect(raw.user.count({ where: { email: payload.email } })).resolves.toBe(0);
    await expect(raw.office.count({ where: { name: payload.officeName } })).resolves.toBe(0);
  });

  it('should let the real owner reclaim an email held by an abandoned unverified signup', async () => {
    const payload = body();
    const squatter = (await register(payload).expect(201)).body.data.user as {
      id: string;
      officeId: string;
    };
    const raw = prisma.unscoped();
    await raw.user.update({
      where: { id: squatter.id },
      data: { createdAt: new Date(Date.now() - 8 * DAY) },
    });

    const owner = (
      await register({ ...payload, officeName: `signup-test-${randomUUID()}` }).expect(201)
    ).body.data.user;
    expect(owner.officeId).not.toBe(squatter.officeId);
    await expect(raw.user.findUniqueOrThrow({ where: { id: squatter.id } })).resolves.toMatchObject(
      {
        email: `released+${squatter.id}@invalid.nexlegtiq`,
        isActive: false,
      },
    );
    await expect(
      raw.office.findUniqueOrThrow({ where: { id: squatter.officeId } }),
    ).resolves.toMatchObject({ isActive: false });
    await expect(
      raw.refreshToken.count({ where: { officeId: squatter.officeId, revokedAt: null } }),
    ).resolves.toBe(0);
    await expect(
      raw.auditLog.count({ where: { officeId: squatter.officeId, action: 'SECURITY' } }),
    ).resolves.toBe(1);
  });

  it('should block an account still unverified 7 days after signup with 403 AUTH-010', async () => {
    const payload = body();
    const signup = await register(payload).expect(201);
    const token = signup.body.data.accessToken as string;
    const signupCookie =
      (
        ([] as string[])
          .concat(signup.headers['set-cookie'] ?? [])
          .find((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`)) ?? ''
      ).split(';')[0] ?? '';
    await prisma.unscoped().user.update({
      where: { email: payload.email },
      data: { createdAt: new Date(Date.now() - 8 * DAY) },
    });

    const server = app.getHttpServer();
    expect(
      (
        await request(server)
          .get('/api/v1/__signup_probe__')
          .set('Authorization', `Bearer ${token}`)
          .expect(403)
      ).body.error,
    ).toMatchObject({
      code: 'AUTH-010',
    });
    const login = await request(server)
      .post('/api/v1/auth/login')
      .send({ email: payload.email, password: PASSWORD })
      .expect(403);
    expect(login.body.error).toMatchObject({ code: 'AUTH-010' });
    const refresh = await request(server)
      .post('/api/v1/auth/refresh')
      .set('Cookie', signupCookie)
      .set(csrf)
      .expect(403);
    expect(refresh.body.error).toMatchObject({ code: 'AUTH-010' });

    // Verifying lifts the block (the link is still valid here: only createdAt was moved back).
    await verify(await tokenFor(payload.email)).expect(204);
    await request(server)
      .post('/api/v1/auth/login')
      .send({ email: payload.email, password: PASSWORD })
      .expect(200);
  });

  it('should invalidate earlier links when a new one is issued', async () => {
    const payload = body();
    await register(payload).expect(201);
    const first = await tokenFor(payload.email);
    const second = await tokenFor(payload.email);
    await verify(first).expect(410);
    await verify(second).expect(204);
  });

  it('should accept resend requests with 202 whether or not the account exists, asking only for unverified ones', async () => {
    const payload = body();
    const userId = (await register(payload).expect(201)).body.data.user.id as string;
    requested.length = 0;
    const resend = (email: string) =>
      request(app.getHttpServer()).post('/api/v1/auth/resend-verification').send({ email });

    const known = await resend(payload.email.toUpperCase()).expect(202);
    const unknown = await resend(`nobody-${randomUUID()}@example.test`).expect(202);
    // Same answer either way: the response never tells whether an account exists.
    expect(unknown.body.data).toEqual(known.body.data);
    expect(unknown.body.success).toBe(known.body.success);
    expect(requested).toEqual([expect.objectContaining({ userId })]);
    expect((await resend('not-an-email').expect(400)).body.error).toMatchObject({
      code: 'VAL-001',
    });

    await verify(await tokenFor(payload.email)).expect(204);
    await resend(payload.email).expect(202);
    expect(requested).toHaveLength(1);
  });

  describe('rate limits', () => {
    let limited: NestExpressApplication;

    beforeAll(async () => {
      limited = await createApp({ throttle: true });
    });

    afterAll(async () => {
      await limited?.close();
    });

    it('should allow 5 signups a minute per client and answer 429 RATE-001 after that', async () => {
      const attempt = () =>
        request(limited.getHttpServer())
          .post('/api/v1/auth/register')
          .set('X-Forwarded-For', '192.0.2.39')
          .send({});
      for (let i = 0; i < 5; i += 1) await attempt().expect(400);
      const blocked = await attempt().expect(429);
      expect(blocked.body.error).toMatchObject({ code: 'RATE-001' });
      expect(blocked.headers['retry-after']).toBeDefined();
    });

    it('should allow 3 resend requests a minute per client', async () => {
      const attempt = () =>
        request(limited.getHttpServer())
          .post('/api/v1/auth/resend-verification')
          .set('X-Forwarded-For', '192.0.2.41')
          .send({ email: 'x@example.test' });
      for (let i = 0; i < 3; i += 1) await attempt().expect(202);
      const blocked = await attempt().expect(429);
      expect(blocked.body.error).toMatchObject({ code: 'RATE-001' });
      expect(blocked.headers['retry-after']).toBeDefined();
    });

    it('should allow 10 verification attempts a minute per client', async () => {
      const attempt = () =>
        request(limited.getHttpServer())
          .post('/api/v1/auth/verify-email')
          .set('X-Forwarded-For', '192.0.2.40')
          .send({ token: 'A'.repeat(43) });
      for (let i = 0; i < 10; i += 1) await attempt().expect(410);
      expect((await attempt().expect(429)).body.error).toMatchObject({ code: 'RATE-001' });
    });
  });
});
