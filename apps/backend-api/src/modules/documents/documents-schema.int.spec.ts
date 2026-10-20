import { randomUUID } from 'node:crypto';

import { FOLDER_SYSTEM_KEYS } from '@nexlegtiq/shared-types';

import { LegalFilesTestDb } from '../legal-files/legal-files.test-helper';
import type { TestOffice } from '../legal-files/legal-files.test-helper';
import { StorageUsageService } from '../subscriptions/storage-usage.service';

/** Prisma's code and the error text that names the constraint (it sits in the message or the driver cause). */
async function violation(write: Promise<unknown>): Promise<{ code: unknown; text: string }> {
  try {
    await write;
  } catch (error) {
    const { code } = error as { code?: unknown };
    const text =
      JSON.stringify(error, Object.getOwnPropertyNames(error)) + String((error as Error).message);
    return { code, text };
  }
  throw new Error('expected the write to be refused');
}

/** The documents schema of MVP-71 (D-119) on real PostgreSQL: integrity, search trigger and storage use. */
describe('documents schema (real PostgreSQL)', () => {
  let db: LegalFilesTestDb;
  let a: TestOffice;
  let b: TestOffice;

  beforeAll(async () => {
    db = new LegalFilesTestDb();
    [a, b] = [await db.newOffice(), await db.newOffice()];
  });

  afterAll(() => db?.cleanUp());

  const file = (office: TestOffice) =>
    db.raw.legalFile.create({ data: db.fileData(office, `D-${randomUUID()}`) });
  const folder = (office: TestOffice, fileId: string, extra: object = {}) =>
    db.raw.documentFolder.create({
      data: { officeId: office.officeId, fileId, name: `F-${randomUUID()}`, ...extra },
    });
  const stored = (office: TestOffice, fileId: string, sizeBytes = 100n) => ({
    originalFilename: 'مذكرة دفاع.pdf',
    mimeType: 'application/pdf',
    sizeBytes,
    checksumSha256: 'c'.repeat(64),
    storageKey: `${office.officeId}/${fileId}/${randomUUID()}.pdf`,
  });
  const document = (office: TestOffice, fileId: string, extra: object = {}) =>
    db.raw.document.create({
      data: {
        officeId: office.officeId,
        fileId,
        name: 'Document',
        ...stored(office, fileId),
        uploadedById: office.userId,
        ...extra,
      },
    });
  const version = (
    office: TestOffice,
    documentId: string,
    fileId: string,
    versionNumber: number,
    sizeBytes: bigint,
  ) =>
    db.raw.documentVersion.create({
      data: {
        officeId: office.officeId,
        documentId,
        versionNumber,
        createdById: office.userId,
        ...stored(office, fileId, sizeBytes),
      },
    });

  it('should keep a folder, its parent and a document in one file of one office', async () => {
    const [fileA, otherFileA, fileB] = [await file(a), await file(a), await file(b)];
    const parentElsewhere = await folder(a, otherFileA.id);
    expect(await violation(folder(a, fileA.id, { parentId: parentElsewhere.id }))).toMatchObject({
      code: 'P2003',
    });
    const folderB = await folder(b, fileB.id);
    expect(await violation(document(a, fileA.id, { folderId: folderB.id }))).toMatchObject({
      code: 'P2003',
    });
    expect(await violation(document(a, fileA.id, { folderId: parentElsewhere.id }))).toMatchObject({
      code: 'P2003',
    });
    const session = await db.raw.session.create({
      data: {
        officeId: a.officeId,
        fileId: otherFileA.id,
        startsAt: new Date(),
        attendingLawyerId: a.userId,
        createdById: a.userId,
        reminderDays: [],
      },
    });
    expect(await violation(document(a, fileA.id, { sessionId: session.id }))).toMatchObject({
      code: 'P2003',
    });
    await expect(document(a, otherFileA.id, { sessionId: session.id })).resolves.toBeDefined();
  });

  it('should refuse a storage key outside the office and a malformed checksum', async () => {
    const fileA = await file(a);
    expect(
      (await violation(document(a, fileA.id, { storageKey: `${b.officeId}/${fileA.id}/x.pdf` })))
        .text,
    ).toContain('documents_storage_key_office_check');
    expect(
      (await violation(document(a, fileA.id, { checksumSha256: 'Z'.repeat(64) }))).text,
    ).toContain('documents_checksum_check');
  });

  it('should keep system folders at the root without a name, and sibling names unique', async () => {
    const fileA = await file(a);
    const root = await folder(a, fileA.id, { name: 'Evidence 1' });
    expect(
      (
        await violation(
          folder(a, fileA.id, { name: null, systemKey: 'EVIDENCE', parentId: root.id }),
        )
      ).text,
    ).toContain('document_folders_system_at_root_check');
    expect(
      (await violation(folder(a, fileA.id, { name: 'Named', systemKey: 'CONTRACTS' }))).text,
    ).toContain('document_folders_name_or_system_check');
    // A file gets its default folders from the database when it is inserted, whoever inserts it.
    expect(
      await db.raw.documentFolder.findMany({
        where: { fileId: fileA.id, systemKey: { not: null } },
        select: { systemKey: true, parentId: true, name: true },
        orderBy: { systemKey: 'asc' },
      }),
    ).toEqual(FOLDER_SYSTEM_KEYS.map((systemKey) => ({ systemKey, parentId: null, name: null })));
    expect(
      await violation(folder(a, fileA.id, { name: null, systemKey: 'CONTRACTS' })),
    ).toMatchObject({ code: 'P2002' });
    await folder(a, fileA.id, { name: 'مُرَاسَلَات' });
    expect(await violation(folder(a, fileA.id, { name: 'مراسلات' }))).toMatchObject({
      code: 'P2002',
    });
    await expect(
      folder(a, fileA.id, { name: 'مراسلات', parentId: root.id }),
    ).resolves.toBeDefined();
  });

  it('should make Arabic and English text searchable when it is inserted', async () => {
    const fileA = await file(a);
    const doc = await document(a, fileA.id);
    await version(a, doc.id, fileA.id, 1, 100n);
    await db.raw.documentText.create({
      data: {
        officeId: a.officeId,
        documentId: doc.id,
        versionNumber: 1,
        // Tashkeel and hamza forms are folded, so a plain query finds them.
        text: 'قَرَّرَت المحكمة تأجيلَ الجلسة إلى موعدٍ لاحق. The hearings were adjourned.',
      },
    });
    const found = async (sql: 'simple' | 'english', query: string) =>
      db.asOffice(a, async () => {
        const rows =
          sql === 'simple'
            ? await db.prisma.db.$queryRaw<{ id: string }[]>`
                SELECT id FROM document_texts
                WHERE office_id = ${a.officeId}::uuid
                  AND search_vector_simple @@ plainto_tsquery('simple', nlq_normalize_ar(${query}))`
            : await db.prisma.db.$queryRaw<{ id: string }[]>`
                SELECT id FROM document_texts
                WHERE office_id = ${a.officeId}::uuid
                  AND search_vector_english @@ plainto_tsquery('english', ${query})`;
        return rows.length;
      });
    expect(await found('simple', 'قررت المحكمة تاجيل')).toBe(1);
    expect(await found('english', 'hearing adjourn')).toBe(1);
    expect(await found('simple', 'استئناف')).toBe(0);
    // Re-extracted text replaces the old vectors.
    await db.raw.documentText.updateMany({
      where: { documentId: doc.id },
      data: { text: 'تم تقديم الاستئناف' },
    });
    expect(await found('simple', 'استئناف')).toBe(0); // the bare word, not الاستئناف: simple has no stemming
    expect(await found('simple', 'الاستئناف')).toBe(1);
    expect(await found('simple', 'المحكمة')).toBe(0);
  });

  it('should sum the stored versions of the current office only', async () => {
    const service = new StorageUsageService(db.prisma);
    const before = await db.asOffice(a, () => service.usedBytes());
    const fileA = await file(a);
    const doc = await document(a, fileA.id);
    await version(a, doc.id, fileA.id, 1, 1_000n);
    await version(a, doc.id, fileA.id, 2, 2_500n);
    const fileB = await file(b);
    const docB = await document(b, fileB.id);
    await version(b, docB.id, fileB.id, 1, 9_999n);
    expect(await db.asOffice(a, () => service.usedBytes())).toBe(before + 3_500n);
    // A soft-deleted document still occupies storage until it is purged; sizes past 2^31 stay exact.
    await db.raw.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
    await version(a, doc.id, fileA.id, 3, 5_000_000_000n);
    expect(await db.asOffice(a, () => service.usedBytes())).toBe(before + 5_000_003_500n);
  });

  it('should take folders, documents, versions and text with a purged file', async () => {
    const fileA = await file(a);
    const parent = await folder(a, fileA.id);
    const child = await folder(a, fileA.id, { parentId: parent.id });
    const doc = await document(a, fileA.id, { folderId: child.id });
    await version(a, doc.id, fileA.id, 1, 10n);
    await db.raw.documentText.create({
      data: { officeId: a.officeId, documentId: doc.id, versionNumber: 1, text: 'x' },
    });
    await db.raw.legalFile.delete({ where: { id: fileA.id } });
    expect(await db.raw.documentFolder.count({ where: { fileId: fileA.id } })).toBe(0);
    expect(await db.raw.document.count({ where: { fileId: fileA.id } })).toBe(0);
    expect(await db.raw.documentVersion.count({ where: { documentId: doc.id } })).toBe(0);
    expect(await db.raw.documentText.count({ where: { documentId: doc.id } })).toBe(0);
  });
});
