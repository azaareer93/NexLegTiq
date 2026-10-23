import { randomUUID } from 'node:crypto';

import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { AddFilePartyResult, Conflict, FileParty, Party } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import request from 'supertest';

import { AppModule } from '../../app/app.module';
import { configureApp } from '../../app/configure-app';
import { FieldCipher } from '../../common/crypto/field-cipher';
import { integrationEnv } from '../../config/env.fixture';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../database/tenant-models';
import type { PrismaClient } from '../../generated/prisma/client';
import { bearerFor } from '../auth/auth.test-helper';
import { liveSubscription } from '../subscriptions/subscription.test-helper';

type Delegate = { deleteMany(args: unknown): Promise<unknown> };
type ErrorBody = { error: { code: string; details?: { field: string; message: string }[] } };
interface Seeded {
  readonly userId: string;
  readonly officeId: string;
  readonly role: Role;
}

/** Parties and conflicts of interest (MVP-62, W9, D-135) through HTTP on real PostgreSQL. */
describe('parties and conflicts (HTTP + PostgreSQL)', () => {
  let app: NestExpressApplication;
  let raw: PrismaClient;
  let jwt: JwtService;
  const officeIds: string[] = [];
  const savedEnv = { ...process.env };
  const http = () => request(app.getHttpServer());

  async function office() {
    const created = await raw.office.create({
      data: { name: 'Party office', settings: { create: {} }, subscriptions: liveSubscription() },
    });
    officeIds.push(created.id);
    return { officeId: created.id, manager: await user(created.id, 'OFFICE_MANAGER') };
  }

  async function user(officeId: string, role: Role): Promise<Seeded> {
    const row = await raw.user.create({
      data: {
        officeId,
        fullName: role,
        email: `party-${randomUUID()}@example.test`,
        passwordHash: '!',
        role,
      },
    });
    return { userId: row.id, officeId, role };
  }

  async function file(
    lawyer: Seeded,
    extra: {
      status?: 'OPEN' | 'CLOSED' | 'SUSPENDED' | 'ARCHIVED';
      isConfidential?: boolean;
      clientName?: string;
      deletedAt?: Date;
    } = {},
  ) {
    const created = await raw.legalFile.create({
      data: {
        officeId: lawyer.officeId,
        fileNumber: `P-${randomUUID().slice(0, 8)}`,
        title: 'Party file',
        fileType: 'LITIGATION',
        status: extra.status ?? 'OPEN',
        isConfidential: extra.isConfidential ?? false,
        deletedAt: extra.deletedAt ?? null,
        responsibleLawyerId: lawyer.userId,
        jurisdiction: 'PALESTINE',
        currency: 'ILS',
      },
    });
    await raw.fileTeamMember.create({
      data: {
        officeId: lawyer.officeId,
        fileId: created.id,
        userId: lawyer.userId,
        role: 'RESPONSIBLE_LAWYER',
      },
    });
    if (extra.clientName) {
      const client = await raw.client.create({
        data: {
          officeId: lawyer.officeId,
          clientType: 'INDIVIDUAL',
          displayName: extra.clientName,
        },
      });
      await raw.fileClient.create({
        data: {
          officeId: lawyer.officeId,
          fileId: created.id,
          clientId: client.id,
          isPrimary: true,
        },
      });
    }
    return created;
  }

  const add = (who: Seeded, fileId: string, body: object) =>
    http().post(`/api/v1/cases/${fileId}/parties`).set(bearerFor(jwt, who)).send(body);
  const person = (fullName: string, extra: object = {}) => ({
    isIndividual: true,
    fullName,
    ...extra,
  });

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv(), { EMAIL_VERIFICATION_ENFORCED: 'false' });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerGuard)
      .useValue({ canActivate: () => true })
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
    }
    await app?.close();
    process.env = savedEnv;
  });

  it('should add a new party with encrypted ids and notes, a timeline event, and find it again by name or id', async () => {
    const { manager } = await office();
    const target = await file(manager);
    const res = await add(manager, target.id, {
      party: person('أحمد الخطيب', { nationalId: '401234567', notes: 'سري' }),
      partyType: 'DEFENDANT',
      roleLabel: 'Tenant',
    }).expect(201);
    const { fileParty, conflicts } = (res.body as { data: AddFilePartyResult }).data;
    expect(conflicts).toEqual([]);
    expect(fileParty).toMatchObject({
      partyType: 'DEFENDANT',
      roleLabel: 'Tenant',
      party: { name: 'أحمد الخطيب', nationalId: '401234567', notes: 'سري' },
    });

    const stored = await raw.party.findUniqueOrThrow({ where: { id: fileParty.party.id } });
    expect(stored.nationalId).toMatch(/^v1:/);
    expect(stored.notes).toMatch(/^v1:/);
    expect(stored.nationalIdIndex).toBe(
      app.get(FieldCipher).blindIndex('401234567', `national_id:${manager.officeId}`),
    );
    expect(
      await raw.caseTimelineEvent.count({ where: { fileId: target.id, eventType: 'PARTY_ADDED' } }),
    ).toBe(1);
    const audit = await raw.auditLog.findFirstOrThrow({
      where: { entityType: 'Party', entityId: fileParty.party.id },
    });
    expect(JSON.stringify(audit.newValues)).not.toContain('401234567');

    // Arabic normalisation (hamza on alef) and identifiers typed with Arabic-Indic digits and spaces.
    for (const search of ['احمد', 'الخطيب', '٤٠١ ٢٣٤ ٥٦٧']) {
      const found = await http()
        .get('/api/v1/parties')
        .query({ search })
        .set(bearerFor(jwt, manager))
        .expect(200);
      expect((found.body as { data: Party[] }).data.map((p) => p.id)).toEqual([fileParty.party.id]);
    }
    const listed = await http()
      .get(`/api/v1/cases/${target.id}/parties`)
      .set(bearerFor(jwt, manager))
      .expect(200);
    expect((listed.body as { data: FileParty[] }).data).toHaveLength(1);
  });

  it('should flag a party adverse on another open file, and its client on another open file, but not closed files or neutral roles', async () => {
    const { manager } = await office();
    const first = await file(manager);
    const created = await add(manager, first.id, {
      party: person('سامي ناصر'),
      partyType: 'PLAINTIFF',
    }).expect(201);
    const partyId = (created.body as { data: AddFilePartyResult }).data.fileParty.party.id;

    // Same party on a second open file → conflict (adverse elsewhere), whatever its role here.
    const second = await file(manager);
    const again = await add(manager, second.id, { partyId, partyType: 'THIRD_PARTY' }).expect(201);
    const conflicts = (again.body as { data: AddFilePartyResult }).data.conflicts;
    expect(conflicts).toMatchObject([
      {
        reason: 'ADVERSE_ON_OTHER_FILE',
        party: { id: partyId },
        file: { id: second.id },
        otherFile: { id: first.id },
      },
    ]);

    // Our client elsewhere (matched by normalised name: إ → ا) while adverse here → conflict; as a witness → none.
    const clientFile = await file(manager, { clientName: 'إياد حماد' });
    const third = await file(manager);
    const adverse = await add(manager, third.id, {
      party: person('اياد حماد'),
      partyType: 'DEFENDANT',
    }).expect(201);
    expect((adverse.body as { data: AddFilePartyResult }).data.conflicts).toMatchObject([
      { reason: 'CLIENT_ON_OTHER_FILE', otherFile: { id: clientFile.id } },
    ]);
    const fourth = await file(manager);
    const neutral = await add(manager, fourth.id, {
      party: person('إياد حماد'),
      partyType: 'INTERESTED_PARTY',
    }).expect(201);
    expect((neutral.body as { data: AddFilePartyResult }).data.conflicts).toEqual([]);

    // A closed matter raises nothing.
    const closed = await file(manager, { status: 'CLOSED' });
    await add(manager, closed.id, { party: person('ليلى عمر'), partyType: 'PLAINTIFF' }).expect(
      201,
    );
    const lailaId = (
      await raw.party.findFirstOrThrow({
        where: { fullName: 'ليلى عمر', officeId: manager.officeId },
      })
    ).id;
    const fifth = await file(manager);
    const none = await add(manager, fifth.id, { partyId: lailaId, partyType: 'DEFENDANT' }).expect(
      201,
    );
    expect((none.body as { data: AddFilePartyResult }).data.conflicts).toEqual([]);
  });

  it('should match a client by national id, hide a confidential file, and resolve a conflict once', async () => {
    const { manager, officeId } = await office();
    const lawyer = await user(officeId, 'LAWYER');
    const secret = await file(manager, { isConfidential: true });
    const cipher = app.get(FieldCipher);
    const client = await raw.client.create({
      data: {
        officeId,
        clientType: 'INDIVIDUAL',
        displayName: 'Some Name',
        nationalIdIndex: cipher.blindIndex('987654321', `national_id:${officeId}`),
      },
    });
    await raw.fileClient.create({
      data: { officeId, fileId: secret.id, clientId: client.id, isPrimary: true },
    });
    const mine = await file(lawyer);
    const res = await add(lawyer, mine.id, {
      party: person('Totally Different', { nationalId: '987-654-321' }),
      partyType: 'RESPONDENT',
    }).expect(201);
    const [conflict] = (res.body as { data: AddFilePartyResult }).data.conflicts;
    // The lawyer cannot open the confidential file: only that a conflict exists is shown.
    expect(conflict).toMatchObject({
      reason: 'CLIENT_ON_OTHER_FILE',
      file: { id: mine.id },
      otherFile: null,
    });

    const listed = await http()
      .get('/api/v1/conflicts')
      .query({ resolved: 'false' })
      .set(bearerFor(jwt, lawyer))
      .expect(200);
    expect((listed.body as { data: Conflict[] }).data.map((c) => c.id)).toEqual([conflict?.id]);

    const resolved = await http()
      .patch(`/api/v1/conflicts/${conflict?.id}/resolve`)
      .set(bearerFor(jwt, lawyer))
      .send({ notes: 'Different person, checked the ID card' })
      .expect(200);
    // The note may describe the confidential matter: only a reader of both files sees it.
    expect((resolved.body as { data: Conflict }).data).toMatchObject({
      resolved: true,
      resolutionNotes: null,
    });
    const asManager = await http()
      .get('/api/v1/conflicts')
      .query({ resolved: 'true' })
      .set(bearerFor(jwt, manager))
      .expect(200);
    expect((asManager.body as { data: Conflict[] }).data[0]?.resolutionNotes).toBe(
      'Different person, checked the ID card',
    );
    const twice = await http()
      .patch(`/api/v1/conflicts/${conflict?.id}/resolve`)
      .set(bearerFor(jwt, lawyer))
      .send({ notes: 'again' })
      .expect(422);
    expect((twice.body as ErrorBody).error.code).toBe('BIZ-017');
  });

  it('should edit, retype (re-checking conflicts) and remove a file party', async () => {
    const { manager } = await office();
    await file(manager, { clientName: 'Rami Saleh' });
    const target = await file(manager);
    const created = await add(manager, target.id, {
      party: person('Rami Saleh'),
      partyType: 'THIRD_PARTY',
    }).expect(201);
    const { fileParty, conflicts } = (created.body as { data: AddFilePartyResult }).data;
    expect(conflicts).toEqual([]);

    const retyped = await http()
      .patch(`/api/v1/cases/${target.id}/parties/${fileParty.id}`)
      .set(bearerFor(jwt, manager))
      .send({ partyType: 'DEFENDANT', roleLabel: null })
      .expect(200);
    expect((retyped.body as { data: AddFilePartyResult }).data.conflicts).toHaveLength(1);

    await http()
      .delete(`/api/v1/cases/${target.id}/parties/${fileParty.id}`)
      .set(bearerFor(jwt, manager))
      .expect(204);
    expect(await raw.conflictOfInterest.count({ where: { fileIdA: target.id } })).toBe(0);
    await http()
      .delete(`/api/v1/cases/${target.id}/parties/${fileParty.id}`)
      .set(bearerFor(jwt, manager))
      .expect(404);
  });

  it('should refuse bad bodies, roles without edit rights, unknown parties and other offices', async () => {
    const { manager, officeId } = await office();
    const target = await file(manager);
    const both = await add(manager, target.id, {
      partyId: randomUUID(),
      party: person('X'),
      partyType: 'PLAINTIFF',
    }).expect(400);
    expect((both.body as ErrorBody).error.details?.[0]?.message).toBe('validation.partyChoice');
    const unknown = await add(manager, target.id, {
      partyId: randomUUID(),
      partyType: 'PLAINTIFF',
    }).expect(400);
    expect((unknown.body as ErrorBody).error.details?.[0]?.message).toBe('validation.unknownParty');

    const trainee = await user(officeId, 'TRAINEE');
    await add(trainee, target.id, { party: person('Y'), partyType: 'PLAINTIFF' }).expect(403);

    const other = await office();
    await add(other.manager, target.id, { party: person('Z'), partyType: 'PLAINTIFF' }).expect(404);
    await http()
      .get(`/api/v1/cases/${target.id}/parties`)
      .set(bearerFor(jwt, other.manager))
      .expect(404);
    const created = await add(manager, target.id, {
      party: person('Hidden'),
      partyType: 'PLAINTIFF',
    });
    const partyId = (created.body as { data: AddFilePartyResult }).data.fileParty.party.id;
    // Another office can neither find nor reuse this office's party.
    const search = await http()
      .get('/api/v1/parties')
      .query({ search: 'Hidden' })
      .set(bearerFor(jwt, other.manager))
      .expect(200);
    expect((search.body as { data: Party[] }).data).toEqual([]);
    const otherFile = await file(other.manager);
    await add(other.manager, otherFile.id, { partyId, partyType: 'PLAINTIFF' }).expect(400);
  });
  const partyIdOf = (res: { body: unknown }) =>
    (res.body as { data: AddFilePartyResult }).data.fileParty.party.id;
  const conflictsOf = (res: { body: unknown }) =>
    (res.body as { data: AddFilePartyResult }).data.conflicts;

  it('should find the conflict whichever role came first, on suspended files, but not on deleted ones', async () => {
    const { manager } = await office();
    const witnessFile = await file(manager, { status: 'SUSPENDED' });
    const first = await add(manager, witnessFile.id, {
      party: person('Nabil Witness'),
      partyType: 'THIRD_PARTY',
    }).expect(201);
    expect(conflictsOf(first)).toEqual([]);
    const partyId = partyIdOf(first);
    const adverseFile = await file(manager);
    const second = await add(manager, adverseFile.id, { partyId, partyType: 'DEFENDANT' }).expect(
      201,
    );
    expect(conflictsOf(second)).toMatchObject([
      { reason: 'ADVERSE_ON_OTHER_FILE', otherFile: { id: witnessFile.id } },
    ]);

    const deleted = await file(manager, { deletedAt: new Date() });
    await raw.fileParty.create({
      data: { officeId: manager.officeId, fileId: deleted.id, partyId, partyType: 'PLAINTIFF' },
    });
    const third = await file(manager);
    const again = await add(manager, third.id, { partyId, partyType: 'THIRD_PARTY' }).expect(201);
    // The suspended and the open file conflict (the party is a defendant there); the deleted one never does.
    expect(conflictsOf(again).map((c) => c.otherFile?.id)).toEqual([adverseFile.id]);
  });

  it('should record one conflict for two simultaneous adds of the same party', async () => {
    const { manager } = await office();
    const seed = await file(manager);
    const created = await add(manager, seed.id, {
      party: person('Racing Party'),
      partyType: 'THIRD_PARTY',
    }).expect(201);
    const partyId = partyIdOf(created);
    const [x, y] = [await file(manager), await file(manager)];
    await Promise.all([
      add(manager, x.id, { partyId, partyType: 'DEFENDANT' }).expect(201),
      add(manager, y.id, { partyId, partyType: 'PLAINTIFF' }).expect(201),
    ]);
    const rows = await raw.conflictOfInterest.findMany({ where: { partyId } });
    const pairs = rows.map((row) => [row.fileIdA, row.fileIdB].sort().join());
    // seed–x, seed–y and x–y, each once.
    expect(new Set(pairs).size).toBe(3);
    expect(rows).toHaveLength(3);
  });

  it('should match a client created through the API by its id, and drop the conflict when the role becomes neutral', async () => {
    const { manager } = await office();
    const clientFile = await file(manager);
    const createdClient = await http()
      .post('/api/v1/clients')
      .set(bearerFor(jwt, manager))
      .send({ clientType: 'INDIVIDUAL', displayName: 'Huda Client', nationalId: '٨٨٨ ٧٧٧ ٦٦٦' })
      .expect(201);
    const clientId = (createdClient.body as { data: { id: string } }).data.id;
    expect((await raw.client.findUniqueOrThrow({ where: { id: clientId } })).nationalIdIndex).toBe(
      app.get(FieldCipher).blindIndex('888777666', `national_id:${manager.officeId}`),
    );
    await raw.fileClient.create({
      data: { officeId: manager.officeId, fileId: clientFile.id, clientId, isPrimary: true },
    });
    const target = await file(manager);
    const res = await add(manager, target.id, {
      party: person('Someone Else', { nationalId: '888-777-666' }),
      partyType: 'APPELLANT',
    }).expect(201);
    expect(conflictsOf(res)).toMatchObject([{ reason: 'CLIENT_ON_OTHER_FILE' }]);
    const filePartyId = (res.body as { data: AddFilePartyResult }).data.fileParty.id;
    const neutral = await http()
      .patch(`/api/v1/cases/${target.id}/parties/${filePartyId}`)
      .set(bearerFor(jwt, manager))
      .send({ partyType: 'INTERESTED_PARTY' })
      .expect(200);
    expect(conflictsOf(neutral)).toEqual([]);
    expect(
      await raw.auditLog.count({ where: { entityType: 'ConflictOfInterest', action: 'DELETE' } }),
    ).toBeGreaterThan(0);

    // The same identifier in another office matches nothing there.
    const other = await office();
    const found = await http()
      .get('/api/v1/parties')
      .query({ search: '888777666' })
      .set(bearerFor(jwt, other.manager))
      .expect(200);
    expect((found.body as { data: Party[] }).data).toEqual([]);
  });

  it('should refuse a duplicate role, an archived file, other offices on conflicts, and the registry to trainees', async () => {
    const { manager, officeId } = await office();
    const target = await file(manager);
    const created = await add(manager, target.id, {
      party: person('Twice'),
      partyType: 'PLAINTIFF',
    }).expect(201);
    const twice = await add(manager, target.id, {
      partyId: partyIdOf(created),
      partyType: 'PLAINTIFF',
    }).expect(409);
    expect((twice.body as ErrorBody).error.code).toBe('RES-002');
    const archived = await file(manager, { status: 'ARCHIVED' });
    const refused = await add(manager, archived.id, {
      party: person('Late'),
      partyType: 'PLAINTIFF',
    }).expect(422);
    expect((refused.body as ErrorBody).error.code).toBe('BIZ-007');

    const trainee = await user(officeId, 'TRAINEE');
    await http().get('/api/v1/parties').set(bearerFor(jwt, trainee)).expect(403);

    const second = await file(manager);
    const conflict = await add(manager, second.id, {
      partyId: partyIdOf(created),
      partyType: 'DEFENDANT',
    }).expect(201);
    const [found] = conflictsOf(conflict);
    const other = await office();
    await http()
      .patch(`/api/v1/conflicts/${found?.id}/resolve`)
      .set(bearerFor(jwt, other.manager))
      .send({ notes: 'no' })
      .expect(404);
    await http()
      .get('/api/v1/conflicts')
      .query({ fileId: target.id })
      .set(bearerFor(jwt, other.manager))
      .expect(404);
  });
});
