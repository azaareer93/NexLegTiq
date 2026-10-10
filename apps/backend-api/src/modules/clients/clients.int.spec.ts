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
interface SeededUser {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}
type Body<T = Record<string, unknown>> = { data: T };

/** MVP-53 through HTTP on real PostgreSQL: clients, contact persons, search, soft delete, encryption and audit. */
describe('clients API (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const users: Record<string, SeededUser> = {};
  let other: SeededUser;

  const http = () => request(app.getHttpServer());
  const as = (user: SeededUser | undefined) => bearerFor(jwt, user as SeededUser);
  const manager = () => users['manager'];

  async function seedUser(officeId: string, role: Role, isActive = true): Promise<SeededUser> {
    const user = await raw.user.create({
      data: {
        officeId,
        fullName: `${role} ${randomUUID().slice(0, 4)}`,
        email: `clients-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
        isActive,
      },
    });
    return { userId: user.id, officeId, role };
  }

  async function seedOffice(name: string): Promise<string> {
    const office = await raw.office.create({ data: { name, settings: { create: {} } } });
    officeIds.push(office.id);
    return office.id;
  }

  async function createClient(body: Record<string, unknown>, user = manager()) {
    const res = await http()
      .post('/api/v1/clients')
      .set(as(user))
      .send({ clientType: 'INDIVIDUAL', ...body })
      .expect(201);
    return (res.body as Body<{ id: string }>).data.id;
  }

  async function linkFile(clientId: string, status: 'OPEN' | 'SUSPENDED' | 'CLOSED' | 'ARCHIVED') {
    const officeId = manager()?.officeId as string;
    const file = await raw.legalFile.create({
      data: {
        officeId,
        fileNumber: `CL-${randomUUID()}`,
        title: 'File',
        fileType: 'LITIGATION',
        status,
        responsibleLawyerId: users['lawyer']?.userId as string,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    await raw.fileClient.create({ data: { officeId, fileId: file.id, clientId } });
    return file.id;
  }

  const listIds = async (query: string) =>
    (
      (await http().get(`/api/v1/clients${query}`).set(as(manager())).expect(200)).body as Body<
        { id: string }[]
      >
    ).data.map((row) => row.id);

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
    const officeId = await seedOffice('Clients office');
    for (const role of ['OFFICE_MANAGER', 'LAWYER', 'PARALEGAL', 'TRAINEE'] as const) {
      users[role === 'OFFICE_MANAGER' ? 'manager' : role.toLowerCase()] = await seedUser(
        officeId,
        role,
      );
    }
    users['formerLawyer'] = await seedUser(officeId, 'LAWYER', false);
    other = await seedUser(await seedOffice('Other office'), 'OFFICE_MANAGER');
  }, 60_000);

  afterAll(async () => {
    if (raw) {
      const where = { officeId: { in: officeIds } };
      for (const model of [...TENANT_MODELS].filter((name) => name !== 'User').reverse()) {
        const name = model.charAt(0).toLowerCase() + model.slice(1);
        await (raw as unknown as Record<string, Delegate>)[name]?.deleteMany({ where });
      }
      await raw.user.deleteMany({ where });
      await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    }
    await app?.close();
    process.env = savedEnv;
  });

  describe('create, get and update', () => {
    it('should store the national and tax ids encrypted, return them decrypted and audit without them', async () => {
      const id = await createClient({
        displayName: 'أحمد حداد',
        fullName: 'أحمد محمود حداد',
        nationalId: '401234567',
        taxId: '562233445',
        phone: '+970 59 123 4567',
        email: 'Ahmad@Example.test',
        primaryLawyerId: users['lawyer']?.userId,
      });
      const stored = await raw.client.findUniqueOrThrow({ where: { id } });
      expect(stored.nationalId).toMatch(/^v1:/);
      expect(stored.taxId).toMatch(/^v1:/);
      expect(stored.nationalId).not.toContain('401234567');

      const res = await http().get(`/api/v1/clients/${id}`).set(as(users['paralegal'])).expect(200);
      expect((res.body as Body).data).toMatchObject({
        id,
        clientType: 'INDIVIDUAL',
        displayName: 'أحمد حداد',
        nationalId: '401234567',
        taxId: '562233445',
        email: 'ahmad@example.test',
        isActive: true,
        primaryLawyer: { id: users['lawyer']?.userId },
        openFiles: 0,
        closedFiles: 0,
        contacts: [],
      });

      const audit = await raw.auditLog.findFirstOrThrow({
        where: { entityType: 'Client', entityId: id, action: 'CREATE' },
      });
      expect(JSON.stringify(audit.newValues)).not.toContain('401234567');
      expect(audit.newValues).toMatchObject({
        nationalId: '[encrypted]',
        displayName: 'أحمد حداد',
      });
    });

    it('should update only changed fields, re-encrypt a new id and clear one with null', async () => {
      const id = await createClient({ displayName: 'Old name', nationalId: '111111111' });
      const res = await http()
        .patch(`/api/v1/clients/${id}`)
        .set(as(manager()))
        .send({ displayName: 'New name', nationalId: '222222222', taxId: null, isActive: false })
        .expect(200);
      expect((res.body as Body).data).toMatchObject({
        displayName: 'New name',
        nationalId: '222222222',
        taxId: null,
        isActive: false,
      });
      const audit = await raw.auditLog.findFirstOrThrow({
        where: { entityType: 'Client', entityId: id, action: 'UPDATE' },
      });
      expect(audit.oldValues).toEqual({
        displayName: 'Old name',
        nationalId: '[encrypted]',
        isActive: true,
      });
      expect(audit.newValues).toEqual({
        displayName: 'New name',
        nationalId: '[encrypted]',
        isActive: false,
      });
    });

    it('should refuse an inactive or unknown primary lawyer and invalid input with VAL-001', async () => {
      for (const primaryLawyerId of [users['formerLawyer']?.userId, other.userId]) {
        const res = await http()
          .post('/api/v1/clients')
          .set(as(manager()))
          .send({ clientType: 'NGO', displayName: 'Charity', primaryLawyerId })
          .expect(400);
        expect(res.body).toMatchObject({
          error: {
            code: 'VAL-001',
            details: [{ field: 'primaryLawyerId', message: 'validation.primaryLawyer' }],
          },
        });
      }
      await http()
        .post('/api/v1/clients')
        .set(as(manager()))
        .send({ clientType: 'NGO', displayName: 'x', email: 'nope' })
        .expect(400);
    });
  });

  describe('GET /clients', () => {
    it('should search Arabic and Latin names, filter and sort by open files', async () => {
      const tag = randomUUID().slice(0, 8);
      const busy = await createClient({
        displayName: `شركة القدس ${tag}`,
        clientType: 'CORPORATION',
      });
      const idle = await createClient({ displayName: `Haddad ${tag}`, fullName: 'Sami Haddad' });
      const gone = await createClient({ displayName: `القدس محذوف ${tag}` });
      await linkFile(busy, 'OPEN');
      await linkFile(busy, 'SUSPENDED');
      await linkFile(busy, 'CLOSED');
      await http().delete(`/api/v1/clients/${gone}`).set(as(manager())).expect(204);

      expect(await listIds(`?search=${encodeURIComponent(`القدس ${tag}`)}`)).toEqual([busy]);
      expect(await listIds(`?search=${encodeURIComponent('sami had')}`)).toContain(idle);
      expect(await listIds(`?search=${tag}&clientType=CORPORATION`)).toEqual([busy]);
      expect(await listIds(`?search=${tag}&sort=openFiles:desc`)).toEqual([busy, idle]);
      expect(await listIds(`?search=${tag}&sort=openFiles:asc`)).toEqual([idle, busy]);
      expect(await listIds(`?search=${encodeURIComponent('100%')}`)).toEqual([]);

      const res = await http()
        .get(`/api/v1/clients?search=${tag}&sort=name&limit=1&page=2`)
        .set(as(manager()))
        .expect(200);
      const body = res.body as Body<{ id: string; openFiles: number }[]> & {
        meta: { pagination: { total: number } };
      };
      expect(body.meta.pagination.total).toBe(2);
      expect(body.data).toHaveLength(1);

      const detail = await http().get(`/api/v1/clients/${busy}`).set(as(manager())).expect(200);
      expect((detail.body as Body).data).toMatchObject({ openFiles: 2, closedFiles: 1 });
    });

    it('should filter by isActive and refuse unknown sort fields', async () => {
      const tag = randomUUID().slice(0, 8);
      const inactive = await createClient({ displayName: `Inactive ${tag}` });
      await http()
        .patch(`/api/v1/clients/${inactive}`)
        .set(as(manager()))
        .send({ isActive: false })
        .expect(200);
      expect(await listIds(`?search=${tag}&isActive=true`)).toEqual([]);
      expect(await listIds(`?search=${tag}&isActive=false`)).toEqual([inactive]);
      await http().get('/api/v1/clients?sort=nationalId').set(as(manager())).expect(400);
    });
  });

  describe('DELETE /clients/:id', () => {
    it('should refuse with 422 BIZ-010 while a file is open, then soft-delete once it is closed', async () => {
      const id = await createClient({ displayName: 'Busy client' });
      const fileId = await linkFile(id, 'OPEN');
      const refused = await http().delete(`/api/v1/clients/${id}`).set(as(manager())).expect(422);
      expect(refused.body).toMatchObject({ error: { code: 'BIZ-010' } });

      await raw.legalFile.update({ where: { id: fileId }, data: { status: 'CLOSED' } });
      await http().delete(`/api/v1/clients/${id}`).set(as(manager())).expect(204);
      expect((await raw.client.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
      await http().get(`/api/v1/clients/${id}`).set(as(manager())).expect(404);
      await http().delete(`/api/v1/clients/${id}`).set(as(manager())).expect(404);
      expect(
        await raw.auditLog.count({
          where: { entityType: 'Client', entityId: id, action: 'DELETE' },
        }),
      ).toBe(1);
    });
  });

  describe('contact persons', () => {
    const contacts = (clientId: string) => `/api/v1/clients/${clientId}/contacts`;
    const addContact = async (clientId: string, body: Record<string, unknown>) =>
      (
        (await http().post(contacts(clientId)).set(as(manager())).send(body).expect(201))
          .body as Body<{ id: string; isPrimary: boolean }>
      ).data;
    const primaries = async (clientId: string) =>
      (
        (await http().get(contacts(clientId)).set(as(manager())).expect(200)).body as Body<
          { id: string; isPrimary: boolean }[]
        >
      ).data
        .filter((contact) => contact.isPrimary)
        .map((contact) => contact.id);

    it('should keep exactly one primary through create, promote and delete', async () => {
      const clientId = await createClient({
        displayName: 'Company with contacts',
        clientType: 'CORPORATION',
      });
      const first = await addContact(clientId, { fullName: 'سارة' });
      expect(first.isPrimary).toBe(true);
      const second = await addContact(clientId, { fullName: 'Omar', position: 'CFO' });
      expect(second.isPrimary).toBe(false);
      const third = await addContact(clientId, { fullName: 'Lina', isPrimary: true });
      expect(await primaries(clientId)).toEqual([third.id]);

      await http()
        .patch(`${contacts(clientId)}/${second.id}`)
        .set(as(manager()))
        .send({ isPrimary: true })
        .expect(200);
      expect(await primaries(clientId)).toEqual([second.id]);
      await http()
        .patch(`${contacts(clientId)}/${second.id}`)
        .set(as(manager()))
        .send({ isPrimary: false })
        .expect(400);

      await http()
        .delete(`${contacts(clientId)}/${second.id}`)
        .set(as(manager()))
        .expect(204);
      expect(await primaries(clientId)).toEqual([first.id]);

      const detail = await http().get(`/api/v1/clients/${clientId}`).set(as(manager())).expect(200);
      expect(
        (detail.body as Body<{ contacts: { id: string }[] }>).data.contacts.map((c) => c.id),
      ).toEqual([first.id, third.id]);
    });

    it('should keep one primary when contacts are added concurrently', async () => {
      const clientId = await createClient({ displayName: 'Concurrent contacts' });
      await Promise.all(
        Array.from({ length: 5 }, (_, i) => addContact(clientId, { fullName: `Contact ${i}` })),
      );
      expect(await primaries(clientId)).toHaveLength(1);
    });

    it("should answer 404 for another client's contact and another office's client", async () => {
      const mine = await createClient({ displayName: 'Mine' });
      const yours = await createClient({ displayName: 'Yours' });
      const contact = await addContact(yours, { fullName: 'Someone' });
      await http()
        .patch(`${contacts(mine)}/${contact.id}`)
        .set(as(manager()))
        .send({ fullName: 'Hacked' })
        .expect(404);

      for (const call of [
        () => http().get(contacts(yours)).set(as(other)),
        () => http().post(contacts(yours)).set(as(other)).send({ fullName: 'Intruder' }),
        () =>
          http()
            .patch(`${contacts(yours)}/${contact.id}`)
            .set(as(other))
            .send({ fullName: 'X' }),
        () =>
          http()
            .delete(`${contacts(yours)}/${contact.id}`)
            .set(as(other)),
        () => http().get(contacts('not-a-uuid')).set(as(manager())),
      ]) {
        const res = await call();
        expect({ status: res.status, body: res.body as unknown }).toMatchObject({
          status: 404,
          body: { error: { code: 'RES-001' } },
        });
      }
      expect(
        await raw.contactPerson.findUniqueOrThrow({ where: { id: contact.id } }),
      ).toMatchObject({
        fullName: 'Someone',
      });
    });
  });

  it('should refuse a TRAINEE every route with 403 AUTH-100', async () => {
    const id = await createClient({ displayName: 'Hidden from trainees' });
    const trainee = users['trainee'];
    for (const call of [
      () => http().get('/api/v1/clients').set(as(trainee)),
      () => http().get(`/api/v1/clients/${id}`).set(as(trainee)),
      () =>
        http()
          .post('/api/v1/clients')
          .set(as(trainee))
          .send({ clientType: 'NGO', displayName: 'X' }),
      () => http().patch(`/api/v1/clients/${id}`).set(as(trainee)).send({ phone: '0599000000' }),
      () => http().delete(`/api/v1/clients/${id}`).set(as(trainee)),
      () => http().get(`/api/v1/clients/${id}/contacts`).set(as(trainee)),
      () => http().post(`/api/v1/clients/${id}/contacts`).set(as(trainee)).send({ fullName: 'X' }),
    ]) {
      const res = await call();
      expect({ status: res.status, body: res.body as unknown }).toMatchObject({
        status: 403,
        body: { error: { code: 'AUTH-100' } },
      });
    }
  });
});
