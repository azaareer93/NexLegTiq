import { randomUUID } from 'node:crypto';

import { LegalFilesTestDb } from './legal-files.test-helper';
import type { TestOffice } from './legal-files.test-helper';

/** What a refused write reports: Prisma's code and everything that names the constraint. */
async function violation(write: Promise<unknown>): Promise<{ code: unknown; text: string }> {
  try {
    await write;
  } catch (error) {
    const { code } = error as { code?: unknown };
    // The constraint name is in the message, `meta` or the driver error's cause depending on the operation.
    const text =
      JSON.stringify(error, Object.getOwnPropertyNames(error)) + String((error as Error).message);
    return { code, text };
  }
  throw new Error('expected the write to be refused');
}

/** The legal-file schema constraints of MVP-56 (D-095) on real PostgreSQL. */
describe('legal-file schema constraints (real PostgreSQL)', () => {
  let db: LegalFilesTestDb;
  let a: TestOffice;
  let b: TestOffice;

  beforeAll(async () => {
    db = new LegalFilesTestDb();
    [a, b] = [await db.newOffice(), await db.newOffice()];
  });

  afterAll(() => db?.cleanUp());

  const client = (office: TestOffice, clientType: 'INDIVIDUAL' | 'CORPORATION' = 'INDIVIDUAL') =>
    db.raw.client.create({
      data: { officeId: office.officeId, clientType, displayName: 'Client' },
    });
  const file = (office: TestOffice) =>
    db.raw.legalFile.create({ data: db.fileData(office, `T-${randomUUID()}`) });
  const party = (office: TestOffice) =>
    db.raw.party.create({
      data: { officeId: office.officeId, isIndividual: true, fullName: 'Party' },
    });

  it('should keep file numbers unique per office only', async () => {
    await db.raw.legalFile.create({ data: db.fileData(a, 'SAME-1') });
    expect(
      await violation(db.raw.legalFile.create({ data: db.fileData(a, 'SAME-1') })),
    ).toMatchObject({
      code: 'P2002',
    });
    await expect(
      db.raw.legalFile.create({ data: db.fileData(b, 'SAME-1') }),
    ).resolves.toBeDefined();
  });

  // Each case links a row of office A to the target of `office`; A's own target must work (positive control).
  it.each([
    [
      'a file to a client',
      async (o: TestOffice) =>
        db.raw.fileClient.create({
          data: {
            officeId: a.officeId,
            fileId: (await file(a)).id,
            clientId: (await client(o)).id,
          },
        }),
    ],
    [
      'a file to a party',
      async (o: TestOffice) =>
        db.raw.fileParty.create({
          data: {
            officeId: a.officeId,
            fileId: (await file(a)).id,
            partyId: (await party(o)).id,
            partyType: 'DEFENDANT',
          },
        }),
    ],
    [
      'a file to a team member',
      async (o: TestOffice) =>
        db.raw.fileTeamMember.create({
          data: { officeId: a.officeId, fileId: (await file(a)).id, userId: o.userId },
        }),
    ],
    [
      'a file to its responsible lawyer',
      async (o: TestOffice) =>
        db.raw.legalFile.create({
          data: { ...db.fileData(a, `T-${randomUUID()}`), responsibleLawyerId: o.userId },
        }),
    ],
    [
      'a note to its author',
      async (o: TestOffice) =>
        db.raw.fileNote.create({
          data: { officeId: a.officeId, fileId: (await file(a)).id, authorId: o.userId, body: 'x' },
        }),
    ],
    [
      'a note to a client',
      async (o: TestOffice) =>
        db.raw.fileNote.create({
          data: {
            officeId: a.officeId,
            clientId: (await client(o)).id,
            authorId: a.userId,
            body: 'x',
          },
        }),
    ],
    [
      'a timeline event to its file',
      async (o: TestOffice) =>
        db.raw.caseTimelineEvent.create({
          data: { officeId: a.officeId, fileId: (await file(o)).id, eventType: 'FILE_OPENED' },
        }),
    ],
    [
      'a conflict to a party',
      async (o: TestOffice) =>
        db.raw.conflictOfInterest.create({
          data: {
            officeId: a.officeId,
            fileIdA: (await file(a)).id,
            fileIdB: (await file(a)).id,
            partyId: (await party(o)).id,
            reason: 'x',
          },
        }),
    ],
    [
      'a client to its primary lawyer',
      async (o: TestOffice) =>
        db.raw.client.create({
          data: {
            officeId: a.officeId,
            clientType: 'CORPORATION',
            displayName: 'C',
            primaryLawyerId: o.userId,
          },
        }),
    ],
  ])('should link %s of the same office only (composite FK)', async (_case, link) => {
    await expect(link(a)).resolves.toBeDefined();
    expect(await violation(link(b))).toMatchObject({ code: 'P2003' });
  });

  it('should refuse to move a user with files to another office (no FK update cascade)', async () => {
    const user = await db.newUser(a);
    await db.raw.legalFile.create({
      data: { ...db.fileData(a, `T-${randomUUID()}`), responsibleLawyerId: user.id },
    });
    const moved = await violation(
      db.raw
        .$executeRaw`UPDATE users SET office_id = ${b.officeId}::uuid WHERE id = ${user.id}::uuid`,
    );
    expect(moved.text).toMatch(/legal_files_responsible_lawyer_id_office_id_fkey/);
  });

  it.each([
    [
      'primary client',
      'file_clients_one_primary_per_file',
      async (fileId: string) =>
        db.raw.fileClient.create({
          data: { officeId: a.officeId, fileId, clientId: (await client(a)).id, isPrimary: true },
        }),
    ],
    [
      'responsible lawyer',
      'file_team_members_one_responsible_per_file',
      async (fileId: string) =>
        db.raw.fileTeamMember.create({
          data: {
            officeId: a.officeId,
            fileId,
            userId: (await db.newUser(a)).id,
            role: 'RESPONSIBLE_LAWYER',
          },
        }),
    ],
  ])('should allow one %s per file', async (_case, index, add) => {
    const fileA = await file(a);
    await add(fileA.id);
    expect((await violation(add(fileA.id))).text).toMatch(new RegExp(index));
  });

  it('should keep one conflict row per files and party', async () => {
    const [fileA, fileB, partyA] = [await file(a), await file(a), await party(a)];
    const data = {
      officeId: a.officeId,
      fileIdA: fileA.id,
      fileIdB: fileB.id,
      partyId: partyA.id,
      reason: 'x',
    };
    await db.raw.conflictOfInterest.create({ data });
    expect(await violation(db.raw.conflictOfInterest.create({ data }))).toMatchObject({
      code: 'P2002',
    });
  });

  it.each([
    [
      'parties_name_check',
      'an organisation without its company name',
      () =>
        db.raw.party.create({ data: { officeId: a.officeId, isIndividual: false, fullName: 'X' } }),
    ],
    [
      'parties_name_check',
      'a person without a full name',
      () =>
        db.raw.party.create({
          data: { officeId: a.officeId, isIndividual: true, companyName: 'X' },
        }),
    ],
    [
      'legal_files_closing_after_opening_check',
      'a closing date before the opening date',
      () =>
        db.raw.legalFile.create({
          data: {
            ...db.fileData(a, `T-${randomUUID()}`),
            openingDate: new Date('2026-05-02'),
            closingDate: new Date('2026-05-01'),
          },
        }),
    ],
    [
      'legal_files_amounts_not_negative_check',
      'a negative hourly rate',
      () =>
        db.raw.legalFile.create({
          data: { ...db.fileData(a, `T-${randomUUID()}`), hourlyRate: '-1' },
        }),
    ],
    [
      'legal_files_amounts_not_negative_check',
      'a negative fixed fee',
      () =>
        db.raw.legalFile.create({
          data: { ...db.fileData(a, `T-${randomUUID()}`), fixedFee: '-0.01' },
        }),
    ],
    [
      'file_notes_subject_check',
      'a note on neither a file nor a client',
      () =>
        db.raw.fileNote.create({ data: { officeId: a.officeId, authorId: a.userId, body: 'x' } }),
    ],
    [
      'conflicts_of_interest_two_files_check',
      'a conflict between a file and itself',
      async () => {
        const [f, p] = [await file(a), await party(a)];
        return db.raw.conflictOfInterest.create({
          data: { officeId: a.officeId, fileIdA: f.id, fileIdB: f.id, partyId: p.id, reason: 'x' },
        });
      },
    ],
    [
      'file_number_sequences_last_value_check',
      'a negative counter',
      () =>
        db.raw.fileNumberSequence.create({
          data: { officeId: a.officeId, year: 2026, typeCode: 'NEG', lastValue: -1 },
        }),
    ],
    [
      'task_templates_due_days_check',
      'a task due before the file opens',
      () =>
        db.raw.taskTemplate.create({
          data: { officeId: a.officeId, name: 'x', defaultTitle: 'x', dueDaysAfterOpen: -1 },
        }),
    ],
    [
      'clients_national_id_encrypted_check',
      'a plaintext client national id',
      () =>
        db.raw.client.create({
          data: {
            officeId: a.officeId,
            clientType: 'INDIVIDUAL',
            displayName: 'C',
            nationalId: '123456789',
          },
        }),
    ],
    [
      'clients_individual_tax_id_encrypted_check',
      "a person's plaintext tax id",
      () =>
        db.raw.client.create({
          data: { officeId: a.officeId, clientType: 'INDIVIDUAL', displayName: 'C', taxId: '123' },
        }),
    ],
    [
      'parties_national_id_encrypted_check',
      'a plaintext party national id',
      () =>
        db.raw.party.create({
          data: { officeId: a.officeId, isIndividual: true, fullName: 'P', nationalId: '123' },
        }),
    ],
    [
      'parties_notes_encrypted_check',
      'plaintext party notes',
      () =>
        db.raw.party.create({
          data: { officeId: a.officeId, isIndividual: true, fullName: 'P', notes: 'secret' },
        }),
    ],
    [
      'file_notes_confidential_encrypted_check',
      'a plaintext confidential note',
      async () =>
        db.raw.fileNote.create({
          data: {
            officeId: a.officeId,
            fileId: (await file(a)).id,
            authorId: a.userId,
            body: 'secret',
            isConfidential: true,
          },
        }),
    ],
  ])('should refuse %s: %s', async (constraint, _case, create: () => Promise<unknown>) => {
    expect((await violation(create())).text).toMatch(new RegExp(constraint));
  });

  it('should accept the rows those checks allow', async () => {
    const cipher = 'v1:iv.tag.data';
    await expect(
      Promise.all([
        db.raw.client.create({
          data: {
            officeId: a.officeId,
            clientType: 'INDIVIDUAL',
            displayName: 'C',
            nationalId: cipher,
            taxId: cipher,
          },
        }),
        db.raw.client.create({
          data: {
            officeId: a.officeId,
            clientType: 'CORPORATION',
            displayName: 'C',
            taxId: '562000000',
          },
        }),
        db.raw.party.create({
          data: {
            officeId: a.officeId,
            isIndividual: false,
            companyName: 'Co',
            taxId: '562000000',
            notes: cipher,
          },
        }),
        db.raw.fileNote.create({
          data: {
            officeId: a.officeId,
            clientId: (await client(a)).id,
            authorId: a.userId,
            body: 'plain',
          },
        }),
        db.raw.fileNote.create({
          data: {
            officeId: a.officeId,
            fileId: (await file(a)).id,
            authorId: a.userId,
            body: cipher,
            isConfidential: true,
          },
        }),
      ]),
    ).resolves.toHaveLength(5);
  });

  it('should take join and history rows with a purged file, and refuse while it has notes', async () => {
    const fileA = await file(a);
    const other = await file(a);
    const partyA = await party(a);
    await db.raw.fileClient.create({
      data: { officeId: a.officeId, fileId: fileA.id, clientId: (await client(a)).id },
    });
    await db.raw.fileTeamMember.create({
      data: { officeId: a.officeId, fileId: fileA.id, userId: a.userId },
    });
    await db.raw.fileParty.create({
      data: { officeId: a.officeId, fileId: fileA.id, partyId: partyA.id, partyType: 'PLAINTIFF' },
    });
    await db.raw.conflictOfInterest.create({
      data: {
        officeId: a.officeId,
        fileIdA: other.id,
        fileIdB: fileA.id,
        partyId: partyA.id,
        reason: 'x',
      },
    });
    await db.raw.caseTimelineEvent.create({
      data: { officeId: a.officeId, fileId: fileA.id, eventType: 'FILE_OPENED' },
    });
    const note = await db.raw.fileNote.create({
      data: { officeId: a.officeId, fileId: fileA.id, authorId: a.userId, body: 'x' },
    });

    expect(await violation(db.raw.legalFile.delete({ where: { id: fileA.id } }))).toMatchObject({
      code: 'P2003',
    });
    await db.raw.fileNote.delete({ where: { id: note.id } });
    await db.raw.legalFile.delete({ where: { id: fileA.id } });

    const left = await Promise.all([
      db.raw.fileClient.count({ where: { fileId: fileA.id } }),
      db.raw.fileTeamMember.count({ where: { fileId: fileA.id } }),
      db.raw.fileParty.count({ where: { fileId: fileA.id } }),
      db.raw.conflictOfInterest.count({ where: { fileIdB: fileA.id } }),
      db.raw.caseTimelineEvent.count({ where: { fileId: fileA.id } }),
    ]);
    expect(left).toEqual([0, 0, 0, 0, 0]);
  });
});
