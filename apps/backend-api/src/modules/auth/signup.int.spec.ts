import { randomUUID } from 'node:crypto';

import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';

import { seedPlans } from '../../../prisma/seed';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { testEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { REFRESH_COOKIE } from './refresh-token';
import { LEGAL_VERSIONS } from './signup.service';
import { VerificationMailer } from './verification-mailer';
import type { VerificationEmail } from './verification-mailer';

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
const PASSWORD = 'Testtesttest1';

/** MVP-39 on real PostgreSQL through HTTP: signup, duplicate and invalid input, email verification, AUTH-010 (D-083). */
describe('office signup (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const sent: VerificationEmail[] = [];
  const emails: string[] = [];
  const savedEnv = { ...process.env };

  const body = (overrides: object = {}) => {
    const email = `signup-${randomUUID()}@example.test`;
    emails.push(email);
    return {
      fullName: 'عمر المصري',
      email,
      password: PASSWORD,
      officeName: 'مكتب المصري للمحاماة',
      accountType: 'SOLO',
      currency: 'ILS',
      acceptTerms: true,
      acceptPrivacy: true,
      ...overrides,
    };
  };
  const register = (payload: object) => request(app.getHttpServer()).post('/api/v1/auth/register').send(payload);
  const verify = (token: string) => request(app.getHttpServer()).post('/api/v1/auth/verify-email').send({ token });
  const tokenFor = (email: string): string => sent.find((mail) => mail.email === email)?.token ?? '';

  beforeAll(async () => {
    Object.assign(process.env, testEnv({ DATABASE_URL: process.env['DATABASE_URL'], NODE_ENV: 'test', CORS_ORIGINS: ORIGIN, METRICS_ENABLED: 'false' }));
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, ProbeModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    // unscoped: test setup — reference plans, as `pnpm nx run backend-api:seed` creates them.
    await seedPlans(prisma.unscoped());
    jest.spyOn(app.get(VerificationMailer), 'send').mockImplementation((mail) => void sent.push(mail));
  });

  afterAll(async () => {
    const raw = prisma.unscoped();
    const users = await raw.user.findMany({ where: { email: { in: emails } }, select: { officeId: true } });
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
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  it('should create the office, manager, 6-month freemium, settings and acceptances, and log in (201)', async () => {
    const payload = body({ phone: '+970 59 123 4567' });
    const res = await register(payload).expect(201);

    expect(res.body.data).toMatchObject({
      expiresIn: 900,
      user: { email: payload.email, role: 'OFFICE_MANAGER', officeName: payload.officeName, uiLanguage: 'AR', emailVerified: false },
    });
    expect(Date.parse(res.body.data.user.verifyBy) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(([] as string[]).concat(res.headers['set-cookie'] ?? []).some((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`))).toBe(true);

    const raw = prisma.unscoped();
    const user = await raw.user.findUniqueOrThrow({ where: { email: payload.email }, include: { office: { include: { settings: true } } } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.office).toMatchObject({ accountType: 'SOLO', jurisdiction: 'PALESTINE', defaultLanguage: 'AR', currency: 'ILS', phone: '+970 59 123 4567' });
    expect(user.office.settings).toMatchObject({ courtReminderDays: [7, 3, 1], fileNumberFormat: '{YEAR}-{TYPE}-{SEQ:5}' });

    const subscription = await raw.subscription.findFirstOrThrow({ where: { officeId: user.officeId }, include: { plan: true } });
    expect(subscription).toMatchObject({ status: 'TRIALING', plan: { code: 'PS_FREE' } });
    expect(Math.round(((subscription.trialEndsAt?.getTime() ?? 0) - subscription.currentPeriodStart.getTime()) / 86_400_000)).toBe(180);

    const acceptances = await raw.legalAcceptance.findMany({ where: { userId: user.id }, orderBy: { documentType: 'asc' } });
    expect(acceptances.map((row) => [row.documentType, row.version])).toEqual([
      ['TOS', LEGAL_VERSIONS.TOS],
      ['PRIVACY', LEGAL_VERSIONS.PRIVACY],
    ]);
    const actions = await raw.auditLog.findMany({ where: { officeId: user.officeId }, select: { action: true, entityType: true } });
    expect(actions).toEqual(expect.arrayContaining([{ action: 'CREATE', entityType: 'Office' }, { action: 'LOGIN', entityType: 'User' }]));

    // The link handed to email delivery is the stored one (hash only in the database).
    const link = await raw.emailVerificationToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(link.tokenHash).not.toBe(tokenFor(payload.email));
    expect(tokenFor(payload.email)).toHaveLength(43);
  });

  it('should give other jurisdictions a 30-day trial sized by account type, in English', async () => {
    const payload = body({ jurisdiction: 'JORDAN', accountType: 'FIRM', defaultLanguage: 'EN', currency: 'JOD' });
    const res = await register(payload).expect(201);
    expect(res.body.data.user.uiLanguage).toBe('EN');
    const subscription = await prisma.unscoped().subscription.findFirstOrThrow({
      where: { officeId: res.body.data.user.officeId },
      include: { plan: true },
    });
    expect(subscription.plan.code).toBe('GLOBAL_SMALL_FIRM');
    expect(Math.round(((subscription.trialEndsAt?.getTime() ?? 0) - Date.now()) / 86_400_000)).toBe(30);
  });

  it('should answer 409 RES-002 for an existing email, also for two signups racing', async () => {
    const payload = body();
    await register(payload).expect(201);
    expect((await register({ ...payload, officeName: 'Second' }).expect(409)).body.error).toMatchObject({ code: 'RES-002' });

    const racing = body();
    const statuses = (await Promise.all([register(racing), register(racing)])).map((res) => res.status).sort();
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
    await expect(prisma.unscoped().user.count({ where: { email: payload.email } })).resolves.toBe(0);
  });

  it('should verify the email once with the link token (204), then refuse it (410 RES-004)', async () => {
    const payload = body();
    const officeId = (await register(payload).expect(201)).body.data.user.officeId as string;
    const token = tokenFor(payload.email);

    await verify(token).expect(204);
    const user = await prisma.unscoped().user.findUniqueOrThrow({ where: { email: payload.email } });
    expect(user.emailVerifiedAt).toEqual(expect.any(Date));
    await expect(prisma.unscoped().auditLog.count({ where: { officeId, action: 'UPDATE', entityType: 'User' } })).resolves.toBe(1);
    expect((await verify(token).expect(410)).body.error).toMatchObject({ code: 'RES-004' });

    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: payload.email, password: PASSWORD }).expect(200);
    expect(login.body.data.user).toMatchObject({ emailVerified: true, verifyBy: null });
  });

  it('should refuse unknown and expired links with 410 RES-004', async () => {
    const payload = body();
    await register(payload).expect(201);
    await prisma.unscoped().emailVerificationToken.updateMany({
      where: { user: { email: payload.email } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await verify(tokenFor(payload.email)).expect(410)).body.error).toMatchObject({ code: 'RES-004' });
    await verify('A'.repeat(43)).expect(410);
  });

  it('should block an account still unverified 7 days after signup with 403 AUTH-010', async () => {
    const payload = body();
    const token = (await register(payload).expect(201)).body.data.accessToken as string;
    await prisma.unscoped().user.update({ where: { email: payload.email }, data: { createdAt: new Date(Date.now() - 8 * 86_400_000) } });

    const server = app.getHttpServer();
    expect((await request(server).get('/api/v1/__signup_probe__').set('Authorization', `Bearer ${token}`).expect(403)).body.error).toMatchObject({
      code: 'AUTH-010',
    });
    const login = await request(server).post('/api/v1/auth/login').send({ email: payload.email, password: PASSWORD }).expect(403);
    expect(login.body.error).toMatchObject({ code: 'AUTH-010' });

    // Verifying lifts the block (the link is still valid here: only createdAt was moved back).
    await verify(tokenFor(payload.email)).expect(204);
    await request(server).post('/api/v1/auth/login').send({ email: payload.email, password: PASSWORD }).expect(200);
  });
});
