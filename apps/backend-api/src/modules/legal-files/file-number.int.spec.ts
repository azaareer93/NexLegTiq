import { FileNumberService } from './file-number.service';
import { LegalFilesTestDb } from './legal-files.test-helper';
import type { TestOffice } from './legal-files.test-helper';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import type { FileType } from '../../generated/prisma/enums';

/** File numbering (D-031, D-095) on real PostgreSQL: the counter, its lock and its rollback. */
describe('FileNumberService (real PostgreSQL)', () => {
  let db: LegalFilesTestDb;
  let numbers: FileNumberService;

  beforeAll(() => {
    db = new LegalFilesTestDb();
    numbers = new FileNumberService(db.cls);
  });

  afterAll(() => db?.cleanUp());

  /** Creates a file the way the API will: number and row in one transaction of the scoped client. */
  function createFile(
    office: TestOffice,
    fileType: FileType = 'LITIGATION',
    year = 2026,
    fail = false,
  ): Promise<string> {
    return db.asOffice(office, () =>
      db.prisma.db.$transaction(
        async (tx) => {
          const fileNumber = await numbers.next(tx, fileType, year);
          await tx.legalFile.create({ data: { ...db.fileData(office, fileNumber), fileType } });
          if (fail) throw new Error(`rollback ${fileNumber}`);
          return fileNumber;
        },
        // Concurrent creates queue for the pool and then for the counter row.
        { maxWait: 30_000, timeout: 30_000 },
      ),
    );
  }

  const counter = (office: TestOffice) =>
    db.raw.fileNumberSequence.findMany({
      where: { officeId: office.officeId },
      select: { year: true, typeCode: true, lastValue: true },
      orderBy: [{ year: 'asc' }, { typeCode: 'asc' }],
    });

  it('should count per year and type with the default format', async () => {
    const office = await db.newOffice();
    expect(await createFile(office)).toBe('2026-LIT-00001');
    expect(await createFile(office)).toBe('2026-LIT-00002');
    expect(await createFile(office, 'CRIMINAL')).toBe('2026-CRM-00001');
    expect(await createFile(office, 'LITIGATION', 2027)).toBe('2027-LIT-00001');
    expect(await counter(office)).toEqual([
      { year: 2026, typeCode: 'CRM', lastValue: 1 },
      { year: 2026, typeCode: 'LIT', lastValue: 2 },
      { year: 2027, typeCode: 'LIT', lastValue: 1 },
    ]);
  });

  it('should share one counter when the format shows neither year nor type', async () => {
    const office = await db.newOffice('F-{SEQ:4}');
    expect(await createFile(office, 'LITIGATION')).toBe('F-0001');
    expect(await createFile(office, 'CRIMINAL', 2027)).toBe('F-0002');
    expect(await counter(office)).toEqual([{ year: 0, typeCode: '', lastValue: 2 }]);
  });

  it('should number each office on its own', async () => {
    const [a, b] = [await db.newOffice(), await db.newOffice()];
    expect(await createFile(a)).toBe('2026-LIT-00001');
    expect(await createFile(b)).toBe('2026-LIT-00001');
  });

  it('should give a number back when its transaction rolls back', async () => {
    const office = await db.newOffice();
    await expect(createFile(office, 'LITIGATION', 2026, true)).rejects.toThrow(
      'rollback 2026-LIT-00001',
    );
    expect(await createFile(office)).toBe('2026-LIT-00001');
  });

  it('should issue 50 unique, gap-free numbers to 50 parallel creates and store them', async () => {
    const office = await db.newOffice('{SEQ}');
    const issued = await Promise.all(Array.from({ length: 50 }, () => createFile(office)));
    const expected = Array.from({ length: 50 }, (_, index) => String(index + 1));
    expect([...issued].sort((x, y) => Number(x) - Number(y))).toEqual(expected);
    const stored = await db.raw.legalFile.findMany({
      where: { officeId: office.officeId },
      select: { fileNumber: true },
    });
    expect(stored.map((file) => file.fileNumber).sort((x, y) => Number(x) - Number(y))).toEqual(
      expected,
    );
    expect(await counter(office)).toEqual([{ year: 0, typeCode: '', lastValue: 50 }]);
  }, 60_000);

  it('should stay gap-free when parallel creates roll back, per type and year', async () => {
    const office = await db.newOffice();
    const runs = (['LITIGATION', 'CRIMINAL'] as const).flatMap((type) =>
      [2026, 2027].flatMap((year) =>
        Array.from({ length: 9 }, (_, index) => ({ type, year, fail: index % 3 === 0 })),
      ),
    );
    const results = await Promise.allSettled(
      runs.map(({ type, year, fail }) => createFile(office, type, year, fail)),
    );
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(12);
    for (const prefix of ['2026-LIT', '2027-LIT', '2026-CRM', '2027-CRM']) {
      const stored = await db.raw.legalFile.findMany({
        where: { officeId: office.officeId, fileNumber: { startsWith: prefix } },
        select: { fileNumber: true },
        orderBy: { fileNumber: 'asc' },
      });
      expect(stored.map((file) => file.fileNumber)).toEqual(
        Array.from({ length: 6 }, (_, index) => `${prefix}-0000${index + 1}`),
      );
    }
  }, 60_000);

  it('should never reuse the number of a soft-deleted file', async () => {
    const office = await db.newOffice();
    const first = await createFile(office);
    await db.raw.legalFile.updateMany({
      where: { officeId: office.officeId, fileNumber: first },
      data: { deletedAt: new Date() },
    });
    expect(await createFile(office)).toBe('2026-LIT-00002');
  });

  it('should skip a number a file already has instead of failing for good', async () => {
    const office = await db.newOffice();
    await db.raw.legalFile.create({ data: db.fileData(office, '2026-LIT-00001') });
    expect(await createFile(office)).toBe('2026-LIT-00002');
    expect(await createFile(office)).toBe('2026-LIT-00003');
  });

  it('should refuse to run outside an office context', async () => {
    await expect(
      db.prisma.db.$transaction((tx) => numbers.next(tx, 'LITIGATION', 2026)),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
  });

  it.each([0, 99, 10_000, 2026.5])('should refuse the year %p', async (year) => {
    const office = await db.newOffice();
    await expect(createFile(office, 'LITIGATION', year)).rejects.toThrow(/four digits/);
  });

  it('should fail, and write nothing, when the stored format is invalid', async () => {
    const office = await db.newOffice();
    await db.raw.officeSettings.update({
      where: { officeId: office.officeId },
      data: { fileNumberFormat: '{YEAR}-{TYPE}' },
    });
    await expect(createFile(office)).rejects.toThrow(/exactly one \{SEQ\}/);
    expect(await counter(office)).toEqual([]);
  });

  it('should fail with a plain error (500, not 404) when the office has no settings', async () => {
    const office = await db.newOffice();
    await db.raw.officeSettings.delete({ where: { officeId: office.officeId } });
    await expect(createFile(office)).rejects.toThrow('Office settings missing');
  });
});
