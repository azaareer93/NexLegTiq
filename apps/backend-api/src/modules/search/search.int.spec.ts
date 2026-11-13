import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { SearchResults } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Person = { userId: string; officeId: string; role: Role };

/** D-167 on real PostgreSQL: `GET /search` returns only what each reader may open, never another office's rows. */
describe('global search (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  let manager: Person;
  let senior: Person;
  let lawyer: Person;
  let trainee: Person;
  let other: Person;
  const ids: Record<string, string> = {};
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };

  async function office(name: string) {
    const row = await raw.office.create({
      data: { name, settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(row.id);
    return async (role: Role): Promise<Person> => {
      const user = await raw.user.create({
        data: {
          officeId: row.id,
          fullName: role,
          email: `se-${randomUUID()}@example.test`,
          passwordHash: '!',
          role,
        },
      });
      return { userId: user.id, officeId: row.id, role };
    };
  }

  const file = (owner: Person, title: string, extra: object = {}) =>
    raw.legalFile.create({
      data: {
        officeId: owner.officeId,
        fileNumber: `SE-${randomUUID()}`,
        title,
        fileType: 'LITIGATION',
        responsibleLawyerId: owner.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
        ...extra,
      },
    });

  async function document(
    fileId: string,
    by: Person,
    name: string,
    text: string,
    extra: object = {},
  ) {
    const stored = {
      originalFilename: 'a.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10n,
      checksumSha256: 'a'.repeat(64),
      storageKey: `${by.officeId}/${fileId}/${randomUUID()}.pdf`,
    };
    const doc = await raw.document.create({
      data: {
        officeId: by.officeId,
        fileId,
        name,
        status: 'READY',
        documentType: 'PLEADING',
        uploadedById: by.userId,
        ...stored,
        ...extra,
      },
    });
    await raw.documentVersion.create({
      data: {
        officeId: by.officeId,
        documentId: doc.id,
        versionNumber: 1,
        createdById: by.userId,
        ...stored,
      },
    });
    await raw.documentText.create({
      data: { officeId: by.officeId, documentId: doc.id, versionNumber: 1, text },
    });
    return doc.id;
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
    // unscoped: fixtures for two offices and checks across them.
    raw = app.get(PrismaService).unscoped();
    jwt = app.get(JwtService);
    const inA = await office('Search office A');
    manager = await inA('OFFICE_MANAGER');
    senior = await inA('SENIOR_LAWYER');
    lawyer = await inA('LAWYER');
    trainee = await inA('TRAINEE');
    other = await (await office('Search office B'))('OFFICE_MANAGER');

    ids.mine = (await file(lawyer, 'Zaytoun rent claim')).id;
    await raw.fileTeamMember.create({
      data: { officeId: lawyer.officeId, fileId: ids.mine, userId: trainee.userId, role: 'MEMBER' },
    });
    ids.colleague = (await file(manager, 'Zaytoun land dispute')).id;
    ids.secret = (await file(manager, 'Zaytoun confidential matter', { isConfidential: true })).id;
    ids.deleted = (await file(manager, 'Zaytoun deleted', { deletedAt: new Date() })).id;
    ids.otherOffice = (await file(other, 'Zaytoun office B')).id;

    ids.doc = await document(
      ids.colleague,
      manager,
      'Claim',
      'The tenant of the Zaytoun orchard stopped paying rent.',
    );
    ids.hiddenDoc = await document(ids.colleague, manager, 'Memo', 'Zaytoun strategy notes', {
      isConfidential: true,
    });
    ids.otherDoc = await document(ids.otherOffice, other, 'B claim', 'Zaytoun in office B');
    ids.arabicDoc = await document(ids.colleague, manager, 'Lease', 'استأجر المستأجر أرض الزيتون');
    // Its current version has no text yet: the text that matched belongs to an older version.
    await document(ids.colleague, manager, 'Stale', 'Zaytoun superseded wording', {
      currentVersion: 2,
    });

    ids.client = (
      await raw.client.create({
        data: {
          officeId: manager.officeId,
          clientType: 'INDIVIDUAL',
          displayName: 'Zaytoun Haddad',
        },
      })
    ).id;
    ids.party = (
      await raw.party.create({
        data: { officeId: manager.officeId, isIndividual: true, fullName: 'Zaytoun Saleh' },
      })
    ).id;
    ids.personal = (
      await raw.task.create({
        data: {
          officeId: manager.officeId,
          title: 'Zaytoun personal reminder',
          assignedToId: manager.userId,
          createdById: manager.userId,
        },
      })
    ).id;
    ids.fileTask = (
      await raw.task.create({
        data: {
          officeId: manager.officeId,
          fileId: ids.mine,
          title: 'Zaytoun file the claim',
          assignedToId: lawyer.userId,
          createdById: lawyer.userId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await raw.task.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.documentText.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.documentVersion.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.document.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.fileTeamMember.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.legalFile.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.client.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.party.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.auditLog.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.user.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.subscription.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.officeSettings.deleteMany({ where: { officeId: { in: officeIds } } });
    await raw.office.deleteMany({ where: { id: { in: officeIds } } });
    await app.close();
    process.env = savedEnv;
  });

  async function search(person: Person, query = 'q=zaytoun&limit=20'): Promise<SearchResults> {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/search?${query}`)
      .set(bearerFor(jwt, person))
      .expect(200);
    return (res.body as { data: SearchResults }).data;
  }
  const idsOf = (group: { items: { id: string }[] }) => group.items.map((i) => i.id).sort();

  it('should give the office manager every live file, document and their own tasks, never office B or deleted rows', async () => {
    const found = await search(manager);
    expect(idsOf(found.cases)).toEqual([ids.mine, ids.colleague, ids.secret].sort());
    expect(idsOf(found.documents)).toEqual([ids.doc, ids.hiddenDoc].sort());
    expect(idsOf(found.tasks)).toEqual([ids.personal, ids.fileTask].sort());
    expect(idsOf(found.clients)).toEqual([ids.client]);
    expect(idsOf(found.parties)).toEqual([ids.party]);
  });

  it('should hide confidential files and documents from a senior lawyer who is not on them', async () => {
    const found = await search(senior);
    expect(idsOf(found.cases)).toEqual([ids.mine, ids.colleague].sort());
    expect(idsOf(found.documents)).toEqual([ids.doc]);
    expect(idsOf(found.tasks)).toEqual([ids.fileTask]);
  });

  it('should give a lawyer only their assigned files and never a colleague’s personal task', async () => {
    const found = await search(lawyer);
    expect(idsOf(found.cases)).toEqual([ids.mine]);
    expect(found.documents.items).toEqual([]);
    expect(idsOf(found.tasks)).toEqual([ids.fileTask]);
  });

  it('should give a trainee no clients or parties, and their assigned file', async () => {
    const found = await search(trainee);
    expect(idsOf(found.cases)).toEqual([ids.mine]);
    expect(found.clients.items).toEqual([]);
    expect(found.parties.items).toEqual([]);
  });

  it('should mark the matched words of a document snippet and name its file', async () => {
    const found = await search(senior, 'q=orchard&type=documents');
    const [hit] = found.documents.items;
    expect(hit?.file.id).toBe(ids.colleague);
    expect(hit?.snippet).toContainEqual({ text: 'orchard', match: true });
    expect(found.cases.items).toEqual([]);
  });

  it('should page each group with hasMore', async () => {
    const found = await search(manager, 'q=zaytoun&type=cases&limit=2');
    expect(found.cases.items).toHaveLength(2);
    expect(found.cases.hasMore).toBe(true);
  });

  it('should highlight an Arabic match found through a letter variant', async () => {
    const found = await search(manager, `q=${encodeURIComponent('استاجر')}&type=documents`);
    expect(idsOf(found.documents)).toEqual([ids.arabicDoc]);
    expect(found.documents.items[0]?.snippet).toContainEqual({ text: 'استاجر', match: true });
  });

  it('should give office B only its own rows', async () => {
    const found = await search(other);
    expect(idsOf(found.cases)).toEqual([ids.otherOffice]);
    expect(idsOf(found.documents)).toEqual([ids.otherDoc]);
    expect(found.clients.items).toEqual([]);
    expect(found.tasks.items).toEqual([]);
  });

  it.each(['q=z', 'q=zaytoun&limit=21', 'q=zaytoun&type=notes'])(
    'should refuse %s with VAL-001',
    async (query) => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/search?${query}`)
        .set(bearerFor(jwt, manager))
        .expect(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('VAL-001');
    },
  );
});
