import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

import { RealtimePublisher } from './realtime.publisher';
import { useRealtimeAdapter } from './redis-io.adapter';
import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../modules/auth/auth.constants';
import { liveSubscription } from '../../modules/subscriptions/subscription.test-helper';
import { TenantRunner } from '../tenancy/tenant-runner';

type Person = { userId: string; officeId: string; role: string };

const FILE = '01900000-0000-7000-8000-00000000f11e';

/** D-129: the gateway authenticates like the HTTP API, and an event reaches only its own office's users. */
describe('Realtime gateway and publisher (real Redis)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let url: string;
  let publisher: RealtimePublisher;
  let tenant: TenantRunner;
  let a1: Person;
  let a2: Person;
  let b1: Person;
  const sockets: Socket[] = [];
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  async function seedOffice(name: string): Promise<[Person, Person]> {
    const office = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(office.id);
    const people: Person[] = [];
    for (const role of ['OFFICE_MANAGER', 'LAWYER'] as const) {
      const user = await raw.user.create({
        data: {
          officeId: office.id,
          fullName: role,
          email: `rt-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      people.push({ userId: user.id, officeId: office.id, role });
    }
    return people as [Person, Person];
  }

  function token(person: Person, expiresIn = 900): string {
    return app
      .get(JwtService)
      .sign(
        { sub: person.userId, officeId: person.officeId, role: person.role, sid: 'rt' },
        { expiresIn, issuer: JWT_ISSUER, audience: JWT_AUDIENCE, algorithm: 'HS256' },
      );
  }

  function open(auth: Record<string, unknown>): Socket {
    const socket = io(`${url}/ws`, { auth, transports: ['websocket'], reconnection: false });
    sockets.push(socket);
    return socket;
  }

  /** Connects and records every event the socket receives. */
  async function connect(person: Person): Promise<{ socket: Socket; seen: string[] }> {
    const socket = open({ token: token(person) });
    const seen: string[] = [];
    socket.onAny((event: string, payload: unknown) =>
      seen.push(`${event} ${JSON.stringify(payload)}`),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return { socket, seen };
  }

  function refusal(auth: Record<string, unknown>): Promise<unknown> {
    const socket = open(auth);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => reject(new Error('connected')));
      socket.once('connect_error', (error: Error & { data?: unknown }) => resolve(error.data));
    });
  }

  const next = (socket: Socket, event: string): Promise<unknown> =>
    new Promise((resolve) => socket.once(event, resolve));

  beforeAll(async () => {
    Object.assign(
      process.env,
      integrationEnv({ BULLMQ_PREFIX: `rt-${randomUUID().slice(0, 8)}` }),
      {
        EMAIL_VERIFICATION_ENFORCED: 'false',
      },
    );
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestExpressApplication>({ bufferLogs: true });
    configureApp(app);
    await useRealtimeAdapter(app);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    // unscoped: fixtures for two offices.
    raw = app.get(PrismaService).unscoped();
    publisher = app.get(RealtimePublisher);
    tenant = app.get(TenantRunner);
    [a1, a2] = await seedOffice('Realtime A');
    [b1] = await seedOffice('Realtime B');
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    if (raw) {
      const where = { officeId: { in: officeIds } };
      await raw.subscription.deleteMany({ where });
      await raw.officeSettings.deleteMany({ where });
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should deliver office and user events only inside their own office', async () => {
    const [ma, la, mb] = await Promise.all([connect(a1), connect(a2), connect(b1)]);

    const officeEvent = Promise.all([
      next(ma.socket, 'session.scheduled'),
      next(la.socket, 'session.scheduled'),
    ]);
    await tenant.run({ officeId: a1.officeId as OfficeId }, async () =>
      publisher.toOffice('session.scheduled', { sessionId: FILE, fileId: FILE }),
    );
    await officeEvent;

    const userEvent = next(la.socket, 'notification');
    publisher.toUser(a2.userId, 'notification', { notificationId: FILE });
    await userEvent;

    // A sentinel to B's user: the earlier events travelled on the same channel, so anything meant for B is in by now.
    const sentinel = next(mb.socket, 'task.updated');
    publisher.toUser(b1.userId, 'task.updated', { taskId: FILE, fileId: null });
    await sentinel;

    expect(mb.seen).toEqual([`task.updated ${JSON.stringify({ taskId: FILE, fileId: null })}`]);
    expect(ma.seen).toEqual([
      `session.scheduled ${JSON.stringify({ sessionId: FILE, fileId: FILE })}`,
    ]);
    expect(la.seen).toHaveLength(2);
  });

  it('should refuse a connection without a valid, live token with its error code', async () => {
    await expect(refusal({})).resolves.toEqual({ code: 'AUTH-003' });
    await expect(refusal({ token: 'not-a-jwt' })).resolves.toEqual({ code: 'AUTH-003' });
    await expect(refusal({ token: token(a1, -10) })).resolves.toEqual({ code: 'AUTH-002' });
    const ghost = { ...a1, userId: randomUUID() };
    await expect(refusal({ token: token(ghost) })).resolves.toEqual({ code: 'AUTH-003' });
  });

  it('should refuse an inactive user', async () => {
    const [, idle] = await seedOffice('Realtime C');
    await raw.user.update({ where: { id: idle.userId }, data: { isActive: false } });
    await expect(refusal({ token: token(idle) })).resolves.toEqual({ code: 'AUTH-006' });
  });

  it('should disconnect a socket when its access token expires', async () => {
    const socket = open({ token: token(a1, 2) });
    await next(socket, 'connect');
    await expect(next(socket, 'disconnect')).resolves.toBe('io server disconnect');
  });

  it('should refuse a payload outside the contract (programming error, never sent)', () => {
    expect(() => publisher.toUser(a1.userId, 'notification', { notificationId: 'x' })).toThrow();
    expect(() => publisher.toOffice('notification', { notificationId: FILE })).toThrow(
      'No office in the context',
    );
  });
});
