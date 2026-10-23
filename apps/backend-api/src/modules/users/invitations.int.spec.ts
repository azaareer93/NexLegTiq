import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AuthSession, Invitation, InvitePreview } from '@nexlegtiq/shared-contracts';
import type { OfficeId, Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import { QueueProducer } from '../../common/queue/queue-producer';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { REFRESH_COOKIE } from '../auth/refresh-token';
import { EntitlementsService } from '../subscriptions/entitlements.service';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
type ErrorBody = { error: { code: string; details?: { field: string; message: string }[] } };

const PASSWORD = 'Correct-Horse-42';

/** Team invitations (MVP-49, D-134) through HTTP on real PostgreSQL. */
describe('invitations (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const officeIds: string[] = [];
  const planIds: string[] = [];
  const savedEnv = { ...process.env };

  const http = () => request(app.getHttpServer());

  async function office(maxUsers: number | null = null) {
    let subscriptions: object = liveSubscription();
    if (maxUsers !== null) {
      const plan = await raw.plan.create({
        data: {
          code: `TEST_${randomUUID().slice(0, 8)}`,
          name: 'Small',
          market: 'GLOBAL',
          priceMonthly: '0',
          currency: 'USD',
          maxUsers,
          storageQuotaMb: 100,
        },
      });
      planIds.push(plan.id);
      subscriptions = {
        create: { status: 'ACTIVE', currentPeriodStart: new Date(), planId: plan.id },
      };
    }
    const created = await raw.office.create({
      data: { name: 'Invite office', settings: { create: {} }, subscriptions },
    });
    officeIds.push(created.id);
    return { officeId: created.id, manager: await seedUser(created.id, 'OFFICE_MANAGER') };
  }

  async function seedUser(officeId: string, role: Role) {
    const user = await raw.user.create({
      data: {
        officeId,
        fullName: `${role} person`,
        email: `inv-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: user.id, officeId, role, email: user.email };
  }

  /** The worker sends the link; here the test sets a known token, as InvitationLinks would. */
  async function linkFor(invitationId: string): Promise<string> {
    const token = randomUUID().replaceAll('-', '');
    await raw.officeInvitation.update({
      where: { id: invitationId },
      data: { tokenHash: hashOpaqueToken(token) },
    });
    return token;
  }

  function invite(manager: { userId: string; officeId: string; role: Role }, body: object) {
    return http().post('/api/v1/users/invite').set(bearerFor(jwt, manager)).send(body);
  }

  const accept = (token: string, extra: object = {}) =>
    http()
      .post('/api/v1/auth/accept-invite')
      .send({
        token,
        fullName: 'Nadia New',
        password: PASSWORD,
        acceptTerms: true,
        acceptPrivacy: true,
        ...extra,
      });

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
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
      await raw.plan.deleteMany({ where: { id: { in: planIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  beforeEach(() => enqueue.mockClear());

  it('should invite, list, preview and accept: the new user is verified, signed in and the manager notified', async () => {
    const { manager, officeId } = await office();
    const email = `Nadia-${randomUUID()}@Example.test`;
    const created = await invite(manager, {
      email,
      role: 'LAWYER',
      fullName: 'Nadia',
      message: 'Welcome aboard',
    }).expect(201);
    const invitation = (created.body as { data: Invitation }).data;
    expect(invitation).toMatchObject({
      email: email.toLowerCase(),
      role: 'LAWYER',
      fullName: 'Nadia',
      status: 'PENDING',
      invitedBy: { id: manager.userId },
    });
    expect(enqueue).toHaveBeenCalledWith('email', 'send-invitation', {
      invitationId: invitation.id,
    });

    const listed = await http()
      .get('/api/v1/users/invitations')
      .set(bearerFor(jwt, manager))
      .expect(200);
    expect((listed.body as { data: Invitation[] }).data.map((row) => row.id)).toEqual([
      invitation.id,
    ]);

    const token = await linkFor(invitation.id);
    const preview = await http().post('/api/v1/auth/invites/preview').send({ token }).expect(200);
    expect((preview.body as { data: InvitePreview }).data).toMatchObject({
      officeName: 'Invite office',
      inviterName: 'OFFICE_MANAGER person',
      email: email.toLowerCase(),
      role: 'LAWYER',
      fullName: 'Nadia',
    });

    const accepted = await accept(token, { phone: '+970 59 123 4567' }).expect(201);
    const session = (accepted.body as { data: AuthSession }).data;
    expect(session.user).toMatchObject({
      email: email.toLowerCase(),
      role: 'LAWYER',
      officeId,
      emailVerified: true,
    });
    expect(String(accepted.headers['set-cookie'])).toContain(`${REFRESH_COOKIE}=`);

    const user = await raw.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
    expect(user).toMatchObject({ fullName: 'Nadia New', phone: '+970 59 123 4567' });
    expect(await raw.officeInvitation.findUnique({ where: { id: invitation.id } })).toMatchObject({
      status: 'ACCEPTED',
    });
    expect(await raw.legalAcceptance.count({ where: { userId: user.id } })).toBe(2);
    expect(
      await raw.notification.findFirst({
        where: { userId: manager.userId, type: 'invitation.accepted' },
      }),
    ).toMatchObject({ link: '/team', params: { userId: user.id, name: 'Nadia New' } });
    expect(
      await raw.auditLog.count({
        where: { entityType: 'User', entityId: user.id, action: 'CREATE' },
      }),
    ).toBe(1);

    // Single use: the link is spent, and the list no longer shows it.
    expect(((await accept(token).expect(410)).body as ErrorBody).error.code).toBe('RES-004');
    await http().post('/api/v1/auth/invites/preview').send({ token }).expect(410);
    const after = await http().get('/api/v1/users/invitations').set(bearerFor(jwt, manager));
    expect((after.body as { data: Invitation[] }).data).toEqual([]);
  });

  it('should refuse a manager role, a taken email and a second pending invitation', async () => {
    const { manager } = await office();
    const other = await office();
    const email = `dup-${randomUUID()}@example.test`;

    const role = await invite(manager, { email, role: 'OFFICE_MANAGER' }).expect(400);
    expect((role.body as ErrorBody).error.details).toEqual([
      { field: 'role', message: 'validation.inviteRole' },
    ]);
    // A user of any office holds the address (D-032).
    await invite(manager, { email: other.manager.email, role: 'LAWYER' }).expect(409);
    await invite(manager, { email, role: 'LAWYER' }).expect(201);
    const again = await invite(manager, { email, role: 'PARALEGAL' }).expect(409);
    expect((again.body as ErrorBody).error.code).toBe('RES-002');
    // Another office may invite the same person; whoever accepts first wins.
    await invite(other.manager, { email, role: 'LAWYER' }).expect(201);
  });

  it('should count pending invitations as seats (BIZ-008) and free the seat on revoke', async () => {
    const { manager } = await office(2);
    const first = await invite(manager, {
      email: `a-${randomUUID()}@example.test`,
      role: 'LAWYER',
    });
    expect(first.status).toBe(201);
    const full = await invite(manager, { email: `b-${randomUUID()}@example.test`, role: 'LAWYER' });
    expect(full.status).toBe(422);
    expect((full.body as ErrorBody).error.code).toBe('BIZ-008');

    const id = (first.body as { data: Invitation }).data.id;
    await http().delete(`/api/v1/users/invitations/${id}`).set(bearerFor(jwt, manager)).expect(204);
    await http().delete(`/api/v1/users/invitations/${id}`).set(bearerFor(jwt, manager)).expect(404);
    await invite(manager, { email: `c-${randomUUID()}@example.test`, role: 'LAWYER' }).expect(201);
  });

  it('should refuse revoked, expired and same-as-email links, and renew an expired one on resend', async () => {
    const { manager } = await office();
    const local = `Exp9-${randomUUID().slice(0, 8)}`;
    const email = `${local.toLowerCase()}@example.test`;
    const created = await invite(manager, { email, role: 'PARALEGAL' }).expect(201);
    const id = (created.body as { data: Invitation }).data.id;
    let token = await linkFor(id);

    const same = await accept(token, { password: local }).expect(400);
    expect((same.body as ErrorBody).error.details).toEqual([
      { field: 'password', message: 'validation.password.sameAsEmail' },
    ]);

    await raw.officeInvitation.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000), updatedAt: new Date(Date.now() - 120_000) },
    });
    await accept(token).expect(410);
    const listed = await http().get('/api/v1/users/invitations').set(bearerFor(jwt, manager));
    expect((listed.body as { data: Invitation[] }).data[0]?.status).toBe('EXPIRED');

    const resent = await http()
      .post(`/api/v1/users/invitations/${id}/resend`)
      .set(bearerFor(jwt, manager))
      .expect(200);
    expect((resent.body as { data: Invitation }).data.status).toBe('PENDING');
    expect(enqueue).toHaveBeenLastCalledWith('email', 'send-invitation', { invitationId: id });
    // The resend rotated the link at once: the old token is dead even before the worker sends the new one.
    await accept(token).expect(410);
    // One email a minute per invitation.
    const again = await http()
      .post(`/api/v1/users/invitations/${id}/resend`)
      .set(bearerFor(jwt, manager))
      .expect(429);
    expect((again.body as ErrorBody).error.code).toBe('RATE-001');
    token = await linkFor(id);

    await http().delete(`/api/v1/users/invitations/${id}`).set(bearerFor(jwt, manager)).expect(204);
    await accept(token).expect(410);
    await http()
      .post('/api/v1/auth/invites/preview')
      .send({ token: 'x'.repeat(40) })
      .expect(410);
  });

  it('should give the last seat to one of two invitations sent at once', async () => {
    const { manager } = await office(2);
    const results = await Promise.all(
      ['p', 'q'].map((name) =>
        invite(manager, { email: `${name}-${randomUUID()}@example.test`, role: 'LAWYER' }),
      ),
    );
    expect(results.map((res) => res.status).sort()).toEqual([201, 422]);
  });

  it('should let only the first of two offices that invited the same person win (409 RES-002)', async () => {
    const first = await office();
    const second = await office();
    const email = `twice-${randomUUID()}@example.test`;
    const one = await invite(first.manager, { email, role: 'LAWYER' }).expect(201);
    const two = await invite(second.manager, { email, role: 'PARALEGAL' }).expect(201);
    const tokens = await Promise.all(
      [one, two].map((res) => linkFor((res.body as { data: Invitation }).data.id)),
    );
    const [a, b] = await Promise.all(tokens.map((token) => accept(token)));
    expect([a?.status, b?.status].sort()).toEqual([201, 409]);
    expect(await raw.user.count({ where: { email } })).toBe(1);
  });

  it('should refuse to add a user to an office whose subscription ended (AUTH-104)', async () => {
    const { manager, officeId } = await office();
    const created = await invite(manager, {
      email: `ro-${randomUUID()}@example.test`,
      role: 'LAWYER',
    }).expect(201);
    const token = await linkFor((created.body as { data: Invitation }).data.id);
    await raw.subscription.updateMany({ where: { officeId }, data: { status: 'CANCELLED' } });
    app.get(EntitlementsService).invalidate(officeId as OfficeId);
    expect(((await accept(token).expect(403)).body as ErrorBody).error.code).toBe('AUTH-104');
    await invite(manager, { email: `ro2-${randomUUID()}@example.test`, role: 'LAWYER' }).expect(
      403,
    );
  });

  it('should keep invitations to managers and inside the office', async () => {
    const { manager, officeId } = await office();
    const created = await invite(manager, {
      email: `x-${randomUUID()}@example.test`,
      role: 'LAWYER',
    }).expect(201);
    const id = (created.body as { data: Invitation }).data.id;

    const lawyer = await seedUser(officeId, 'SENIOR_LAWYER');
    await invite(lawyer, { email: `y-${randomUUID()}@example.test`, role: 'LAWYER' }).expect(403);
    await http().get('/api/v1/users/invitations').set(bearerFor(jwt, lawyer)).expect(403);

    const other = await office();
    await http()
      .delete(`/api/v1/users/invitations/${id}`)
      .set(bearerFor(jwt, other.manager))
      .expect(404);
    await http()
      .post(`/api/v1/users/invitations/${id}/resend`)
      .set(bearerFor(jwt, other.manager))
      .expect(404);
    const otherList = await http()
      .get('/api/v1/users/invitations')
      .set(bearerFor(jwt, other.manager));
    expect((otherList.body as { data: Invitation[] }).data).toEqual([]);
  });

  it('should refuse an invitation to a suspended office', async () => {
    const { manager, officeId } = await office();
    const created = await invite(manager, {
      email: `s-${randomUUID()}@example.test`,
      role: 'LAWYER',
    }).expect(201);
    const token = await linkFor((created.body as { data: Invitation }).data.id);
    await raw.office.update({ where: { id: officeId }, data: { isActive: false } });
    expect(((await accept(token).expect(403)).body as ErrorBody).error.code).toBe('AUTH-006');
  });
});
