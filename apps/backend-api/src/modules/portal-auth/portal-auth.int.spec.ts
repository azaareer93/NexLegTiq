import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { PortalInvitation, PortalSession, PortalUsers } from '@nexlegtiq/shared-contracts';
import type { OfficeId, Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { PORTAL_REFRESH_COOKIE } from './portal-auth.constants';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import { QueueProducer } from '../../common/queue/queue-producer';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
type ErrorBody = { error: { code: string } };

const PASSWORD = 'Correct-Horse-42';
const OTHER_PASSWORD = 'Another-Horse-77';
const ORIGIN = 'http://localhost:4202';
const csrf = { Origin: ORIGIN, 'X-Requested-With': 'XMLHttpRequest' };
const portalApi = '/api/v1/portal/auth';

const cookieOf = (res: request.Response): string => {
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  return (cookies.find((c) => c.startsWith(`${PORTAL_REFRESH_COOKIE}=`)) ?? '').split(';')[0] ?? '';
};
const sessionOf = (res: request.Response) => (res.body as { data: PortalSession }).data;
const codeOf = (res: request.Response) => (res.body as ErrorBody).error.code;

/** The client-portal realm (D-158) on real PostgreSQL: invitations, sessions, revocation, realm boundaries, lockout. */
describe('portal auth (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const officeIds: string[] = [];
  const emails: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function office(role: Role = 'OFFICE_MANAGER') {
    const created = await raw.office.create({
      data: {
        name: `Portal office ${randomUUID().slice(0, 4)}`,
        settings: { create: {} },
        subscriptions: liveSubscription(),
      },
    });
    officeIds.push(created.id);
    const user = await raw.user.create({
      data: {
        officeId: created.id,
        fullName: 'Manager',
        email: `mgr-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    const clientRow = await raw.client.create({
      data: { officeId: created.id, clientType: 'INDIVIDUAL', displayName: 'Layla Client' },
    });
    return { officeId: created.id, userId: user.id, role, clientId: clientRow.id };
  }

  const newEmail = () => {
    const email = `portal-${randomUUID()}@example.test`;
    emails.push(email);
    return email;
  };

  const invite = (o: Awaited<ReturnType<typeof office>>, body: object, clientId = o.clientId) =>
    http().post(`/api/v1/clients/${clientId}/portal-invitations`).set(bearerFor(jwt, o)).send(body);

  /** The worker emails the link; here the test sets a known token, as PortalInvitationLinks would. */
  async function linkFor(invitationId: string): Promise<string> {
    const token = randomUUID().replaceAll('-', '');
    await raw.clientInvitation.update({
      where: { id: invitationId },
      data: { tokenHash: hashOpaqueToken(token) },
    });
    return token;
  }

  const accept = (token: string, password = PASSWORD) =>
    http()
      .post(`${portalApi}/accept-invite`)
      .send({ token, fullName: 'Layla Portal', password, acceptTerms: true, acceptPrivacy: true });

  const login = (email: string, password = PASSWORD) =>
    http().post(`${portalApi}/login`).send({ email, password });

  /** Invites `email` to the office's client and accepts: returns the session, cookie and the grant id. */
  async function joined(o: Awaited<ReturnType<typeof office>>, email: string, password = PASSWORD) {
    const created = await invite(o, { email }).expect(201);
    const token = await linkFor((created.body as { data: PortalInvitation }).data.id);
    const res = await accept(token, password).expect(201);
    const grant = await raw.clientPortalAccess.findFirstOrThrow({
      where: { officeId: o.officeId, clientUser: { email } },
    });
    return { session: sessionOf(res), cookie: cookieOf(res), accessId: grant.id };
  }

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), {
      JWT_PORTAL_SECRET: 'integration-only-portal-secret-0123456789abcdef',
      CLIENT_PORTAL_URL: ORIGIN,
    });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(QueueProducer)
      .useValue({ enqueue, remove: jest.fn() })
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
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const delegate = (raw as unknown as Record<string, Delegate>)[
          model.charAt(0).toLowerCase() + model.slice(1)
        ];
        await delegate?.deleteMany({ where });
      }
      await raw.user.deleteMany({ where });
      await raw.subscription.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
      await raw.clientUser.deleteMany({ where: { email: { in: emails } } });
      await raw.loginAttempt.deleteMany({
        where: { email: { in: emails.map((e) => `portal:${e}`) } },
      });
    }
    await app?.close();
    process.env = savedEnv;
  });

  beforeEach(() => enqueue.mockClear());

  it('should run invite, accept, login, refresh rotation with reuse detection and logout', async () => {
    const o = await office();
    const email = newEmail();
    const created = await invite(o, { email: email.toUpperCase() }).expect(201);
    const invitation = (created.body as { data: PortalInvitation }).data;
    expect(invitation).toMatchObject({ email, status: 'PENDING' });
    expect(enqueue).toHaveBeenCalledWith('email', 'send-client-invitation', {
      invitationId: invitation.id,
    });
    const listed = await http()
      .get(`/api/v1/clients/${o.clientId}/portal-users`)
      .set(bearerFor(jwt, o))
      .expect(200);
    expect((listed.body as { data: PortalUsers }).data.invitations.map((i) => i.id)).toEqual([
      invitation.id,
    ]);

    const token = await linkFor(invitation.id);
    const preview = await http().post(`${portalApi}/invites/preview`).send({ token }).expect(200);
    expect((preview.body as { data: object }).data).toMatchObject({
      email,
      clientName: 'Layla Client',
      accountExists: false,
    });

    const accepted = await accept(token).expect(201);
    const session = sessionOf(accepted);
    expect(session.user).toMatchObject({
      email,
      offices: [{ officeId: o.officeId, clientId: o.clientId }],
    });
    expect(cookieOf(accepted)).toMatch(new RegExp(`^${PORTAL_REFRESH_COOKIE}=`));
    // The link is single use.
    expect(codeOf(await accept(token))).toBe('RES-004');

    const me = await http()
      .get(`${portalApi}/me`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(200);
    expect((me.body as { data: { email: string } }).data.email).toBe(email);

    const signedIn = await login(email).expect(200);
    const first = cookieOf(signedIn);
    const rotated = await http()
      .post(`${portalApi}/refresh`)
      .set(csrf)
      .set('Cookie', first)
      .expect(200);
    const second = cookieOf(rotated);
    expect(second).not.toBe(first);
    // A cookie without the portal origin is refused (CSRF).
    await http().post(`${portalApi}/refresh`).set('Cookie', second).expect(403);
    // The old token comes back: the whole family ends.
    const reused = await http()
      .post(`${portalApi}/refresh`)
      .set(csrf)
      .set('Cookie', first)
      .expect(401);
    expect(codeOf(reused)).toBe('AUTH-005');
    const security = await raw.auditLog.findMany({
      where: { officeId: o.officeId, action: 'SECURITY', clientUser: { email } },
    });
    expect(security).toHaveLength(1);
    expect(security[0]?.newValues).toMatchObject({ event: 'REFRESH_TOKEN_REUSED' });
    await http().post(`${portalApi}/refresh`).set(csrf).set('Cookie', second).expect(401);

    const again = await login(email).expect(200);
    const live = cookieOf(again);
    await http().post(`${portalApi}/logout`).set(csrf).set('Cookie', live).expect(204);
    await http().post(`${portalApi}/logout`).set(csrf).set('Cookie', live).expect(204);
    await http().post(`${portalApi}/refresh`).set(csrf).set('Cookie', live).expect(401);
    // The old access token stops with its session.
    await http()
      .get(`${portalApi}/me`)
      .set('Authorization', `Bearer ${sessionOf(again).accessToken}`)
      .expect(401);

    const actions = await raw.auditLog.findMany({
      where: { officeId: o.officeId, clientUser: { email } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['CREATE', 'LOGIN', 'LOGOUT']),
    );
  });

  it('should keep the realms apart: an office token fails portal routes and a portal token fails office routes', async () => {
    const o = await office();
    const { session } = await joined(o, newEmail());
    const office401 = await http().get(`${portalApi}/me`).set(bearerFor(jwt, o)).expect(401);
    expect(codeOf(office401)).toBe('AUTH-003');
    const portal401 = await http()
      .get('/api/v1/clients')
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(401);
    expect(codeOf(portal401)).toBe('AUTH-003');
  });

  it('should end access at once when the office revokes it', async () => {
    const o = await office();
    const email = newEmail();
    const { session, cookie, accessId } = await joined(o, email);
    await http()
      .delete(`/api/v1/clients/${o.clientId}/portal-users/${accessId}`)
      .set(bearerFor(jwt, o))
      .expect(204);
    await http()
      .delete(`/api/v1/clients/${o.clientId}/portal-users/${accessId}`)
      .set(bearerFor(jwt, o))
      .expect(404);
    await http().post(`${portalApi}/refresh`).set(csrf).set('Cookie', cookie).expect(401);
    await http()
      .get(`${portalApi}/me`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .expect(401);
    expect(codeOf(await login(email).expect(403))).toBe('AUTH-006');
    // Re-invited, the same account gets a new grant.
    const second = await joined(o, email);
    expect(second.session.user.id).toBe(session.user.id);
  });

  it('should reuse the account for a second office and need its existing password', async () => {
    const first = await office();
    const second = await office();
    const email = newEmail();
    const one = await joined(first, email);
    const created = await invite(second, { email }).expect(201);
    const token = await linkFor((created.body as { data: PortalInvitation }).data.id);
    const preview = await http().post(`${portalApi}/invites/preview`).send({ token }).expect(200);
    expect((preview.body as { data: { accountExists: boolean } }).data.accountExists).toBe(true);
    expect(codeOf(await accept(token, OTHER_PASSWORD).expect(401))).toBe('AUTH-001');
    const res = await accept(token).expect(201);
    expect(sessionOf(res).user.id).toBe(one.session.user.id);
    expect(
      sessionOf(res)
        .user.offices.map((x) => x.officeId)
        .sort(),
    ).toEqual([first.officeId, second.officeId].sort());
    expect(await raw.clientUser.count({ where: { email } })).toBe(1);
    // Inviting an address that already has a live grant here is a conflict.
    expect(codeOf(await invite(first, { email }).expect(409))).toBe('RES-002');
  });

  it("should answer 404 for another office's client, grant and invitation, and 403 without the permission", async () => {
    const a = await office();
    const b = await office();
    const trainee = await office('TRAINEE');
    const { accessId } = await joined(a, newEmail());
    await invite(b, { email: newEmail() }, a.clientId).expect(404);
    await http()
      .get(`/api/v1/clients/${a.clientId}/portal-users`)
      .set(bearerFor(jwt, b))
      .expect(404);
    await http()
      .delete(`/api/v1/clients/${b.clientId}/portal-users/${accessId}`)
      .set(bearerFor(jwt, b))
      .expect(404);
    await http()
      .delete(`/api/v1/clients/${b.clientId}/portal-invitations/${randomUUID()}`)
      .set(bearerFor(jwt, b))
      .expect(404);
    await http().get('/api/v1/clients/not-a-uuid/portal-users').set(bearerFor(jwt, a)).expect(404);
    const denied = await invite(trainee, { email: newEmail() }).expect(403);
    expect(codeOf(denied)).toBe('AUTH-100');
    await invite(a, { email: 'not-an-email' }).expect(400);
    await invite(a, { email: newEmail(), contactPersonId: randomUUID() }).expect(400);
  });

  it('should keep access revocable after the subscription ended, while inviting and listing are refused', async () => {
    const o = await office();
    const { accessId } = await joined(o, newEmail());
    const pending = await invite(o, { email: newEmail() }).expect(201);
    await raw.subscription.updateMany({
      where: { officeId: o.officeId },
      data: { status: 'CANCELLED' },
    });
    app.get(EntitlementsService).invalidate(o.officeId as OfficeId);
    expect(codeOf(await invite(o, { email: newEmail() }).expect(403))).toBe('AUTH-104');
    await http()
      .delete(
        `/api/v1/clients/${o.clientId}/portal-invitations/${(pending.body as { data: PortalInvitation }).data.id}`,
      )
      .set(bearerFor(jwt, o))
      .expect(204);
    await http()
      .delete(`/api/v1/clients/${o.clientId}/portal-users/${accessId}`)
      .set(bearerFor(jwt, o))
      .expect(204);
  });

  it('should refuse a portal invitation for a client with a confidential file the caller may not expose', async () => {
    const o = await office('LAWYER');
    const other = await raw.user.create({
      data: {
        officeId: o.officeId,
        fullName: 'Boss',
        email: `boss-${randomUUID()}@example.test`,
        passwordHash: '!',
        role: 'SENIOR_LAWYER',
      },
    });
    const file = await raw.legalFile.create({
      data: {
        officeId: o.officeId,
        fileNumber: `PC-${randomUUID()}`,
        title: 'Secret',
        fileType: 'LITIGATION',
        responsibleLawyerId: other.id,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
        isConfidential: true,
      },
    });
    await raw.fileClient.create({
      data: { officeId: o.officeId, fileId: file.id, clientId: o.clientId, isPrimary: true },
    });
    expect(codeOf(await invite(o, { email: newEmail() }).expect(403))).toBe('AUTH-100');
    // Its responsible lawyer may.
    await invite({ ...o, userId: other.id, role: 'SENIOR_LAWYER' }, { email: newEmail() }).expect(
      201,
    );
  });

  it('should withdraw a pending invitation so its link stops working', async () => {
    const o = await office();
    const created = await invite(o, { email: newEmail() }).expect(201);
    const id = (created.body as { data: PortalInvitation }).data.id;
    const token = await linkFor(id);
    await http()
      .delete(`/api/v1/clients/${o.clientId}/portal-invitations/${id}`)
      .set(bearerFor(jwt, o))
      .expect(204);
    await http().post(`${portalApi}/invites/preview`).send({ token }).expect(410);
  });

  it('should lock a portal account after 5 failed sign-ins', async () => {
    const o = await office();
    const email = newEmail();
    await joined(o, email);
    for (let i = 0; i < 5; i += 1) {
      expect(codeOf(await login(email, OTHER_PASSWORD).expect(401))).toBe('AUTH-001');
    }
    expect(codeOf(await login(email).expect(423))).toBe('AUTH-007');
    expect(codeOf(await login(`nobody-${email}`, PASSWORD).expect(401))).toBe('AUTH-001');
  });

  it('should reset the password with an emailed link and end every session', async () => {
    const o = await office();
    const email = newEmail();
    const { cookie, session } = await joined(o, email);
    await http().post(`${portalApi}/forgot-password`).send({ email }).expect(200);
    await http().post(`${portalApi}/forgot-password`).send({ email: newEmail() }).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(enqueue).toHaveBeenCalledWith('email', 'send-client-password-reset', {
      clientUserId: session.user.id,
    });
    expect(
      enqueue.mock.calls.filter(([, name]) => name === 'send-client-password-reset'),
    ).toHaveLength(1);

    const token = randomUUID().replaceAll('-', '');
    await raw.clientPasswordResetToken.create({
      data: {
        clientUserId: session.user.id,
        tokenHash: hashOpaqueToken(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const body = { token, newPassword: OTHER_PASSWORD, confirmPassword: OTHER_PASSWORD };
    await http().post(`${portalApi}/reset-password`).send(body).expect(204);
    expect(codeOf(await http().post(`${portalApi}/reset-password`).send(body).expect(410))).toBe(
      'RES-004',
    );
    await http().post(`${portalApi}/refresh`).set(csrf).set('Cookie', cookie).expect(401);
    await login(email).expect(401);
    await login(email, OTHER_PASSWORD).expect(200);
  });
});
