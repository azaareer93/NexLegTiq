import { randomUUID } from 'node:crypto';

import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { FileNumberService } from './file-number.service';
import type { RequestContext } from '../../common/context/request-context';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { PrismaClient } from '../../generated/prisma/client';
import type { FileType } from '../../generated/prisma/enums';
import { ReadinessRegistry } from '../../health/readiness.registry';

interface Office {
  readonly officeId: string;
  readonly userId: string;
}

/** File numbering (D-031, D-095) and the legal-file schema constraints (MVP-56) on real PostgreSQL. */
describe('legal files: numbering and schema (real PostgreSQL)', () => {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const runner = new TenantRunner(cls);
  const numbers = new FileNumberService(cls);
  let prisma: PrismaService;
  let raw: PrismaClient;
  const offices: Office[] = [];

  async function newOffice(fileNumberFormat?: string): Promise<Office> {
    const office = await raw.office.create({
      data: { name: 'Numbering test', settings: { create: { fileNumberFormat } } },
    });
    const user = await raw.user.create({
      data: {
        officeId: office.id,
        fullName: 'Lawyer',
        email: `numbering-${office.id}@example.test`,
        passwordHash: '!',
        role: 'LAWYER',
      },
    });
    const created = { officeId: office.id, userId: user.id };
    offices.push(created);
    return created;
  }

  const fileData = (office: Office, fileNumber: string) => ({
    officeId: office.officeId,
    fileNumber,
    title: 'Test file',
    fileType: 'LITIGATION' as const,
    responsibleLawyerId: office.userId,
    jurisdiction: 'PALESTINE' as const,
    currency: 'ILS',
  });

  /** Creates a file the way the API will: number and row in one transaction of the scoped client. */
  function createFile(
    office: Office,
    fileType: FileType = 'LITIGATION',
    year = 2026,
    beforeCommit?: (tx: ScopedTransaction) => Promise<void>,
  ): Promise<string> {
    return runner.run({ officeId: office.officeId as OfficeId }, () =>
      prisma.db.$transaction(
        async (tx) => {
          const fileNumber = await numbers.next(tx, fileType, year);
          await tx.legalFile.create({ data: { ...fileData(office, fileNumber), fileType } });
          await beforeCommit?.(tx);
          return fileNumber;
        },
        // 50 concurrent creates queue for the pool and then for the counter row.
        { maxWait: 30_000, timeout: 30_000 },
      ),
    );
  }

  beforeAll(() => {
    const config = new AppConfig(
      parseEnv(testEnv({ DATABASE_URL: process.env['DATABASE_URL'], NODE_ENV: 'test' })),
    );
    prisma = new PrismaService(
      config,
      new ReadinessRegistry({ setContext: () => undefined } as unknown as PinoLogger),
      cls,
    );
    // unscoped: test setup creates offices and checks constraints across them.
    raw = prisma.unscoped();
  });

  afterAll(async () => {
    if (!raw) return;
    const where = { officeId: { in: offices.map((office) => office.officeId) } };
    await raw.fileNote.deleteMany({ where });
    await raw.conflictOfInterest.deleteMany({ where });
    await raw.fileParty.deleteMany({ where });
    await raw.party.deleteMany({ where });
    await raw.fileClient.deleteMany({ where });
    await raw.legalFile.deleteMany({ where });
    await raw.client.deleteMany({ where });
    await raw.fileNumberSequence.deleteMany({ where });
    await raw.user.deleteMany({ where });
    await raw.officeSettings.deleteMany({ where });
    await raw.office.deleteMany({ where: { id: { in: where.officeId.in } } });
    await prisma.onModuleDestroy();
  });

  describe('FileNumberService', () => {
    it('should count per year and type with the default format', async () => {
      const office = await newOffice();
      expect(await createFile(office)).toBe('2026-LIT-00001');
      expect(await createFile(office)).toBe('2026-LIT-00002');
      expect(await createFile(office, 'CONTRACT_DRAFTING')).toBe('2026-CON-00001');
      expect(await createFile(office, 'LITIGATION', 2027)).toBe('2027-LIT-00001');
    });

    it('should share one counter when the format shows neither year nor type', async () => {
      const office = await newOffice('F-{SEQ:4}');
      expect(await createFile(office, 'LITIGATION')).toBe('F-0001');
      expect(await createFile(office, 'CRIMINAL', 2027)).toBe('F-0002');
    });

    it('should number each office on its own', async () => {
      const [a, b] = [await newOffice(), await newOffice()];
      expect(await createFile(a)).toBe('2026-LIT-00001');
      expect(await createFile(b)).toBe('2026-LIT-00001');
    });

    it('should give a number back when its transaction rolls back (gap-free)', async () => {
      const office = await newOffice();
      const failure = new Error('rollback');
      await expect(
        createFile(office, 'LITIGATION', 2026, () => Promise.reject(failure)),
      ).rejects.toBe(failure);
      expect(await createFile(office)).toBe('2026-LIT-00001');
    });

    it('should issue 50 unique, gap-free numbers to 50 parallel creates', async () => {
      const office = await newOffice('{SEQ}');
      const issued = await Promise.all(Array.from({ length: 50 }, () => createFile(office)));
      expect(issued.map(Number).sort((x, y) => x - y)).toEqual(
        Array.from({ length: 50 }, (_, index) => index + 1),
      );
    }, 60_000);

    it('should refuse to run outside an office context', async () => {
      await expect(
        prisma.db.$transaction((tx) => numbers.next(tx, 'LITIGATION', 2026)),
      ).rejects.toThrow('file number');
    });
  });

  describe('schema constraints', () => {
    let a: Office;
    let b: Office;

    beforeAll(async () => {
      [a, b] = [await newOffice(), await newOffice()];
    });

    const client = (office: Office) =>
      raw.client.create({
        data: { officeId: office.officeId, clientType: 'INDIVIDUAL', displayName: 'Client' },
      });
    const file = (office: Office) =>
      raw.legalFile.create({ data: fileData(office, `T-${randomUUID()}`) });
    const party = (office: Office) =>
      raw.party.create({ data: { officeId: office.officeId, isIndividual: true, fullName: 'P' } });

    it('should keep file numbers unique per office only', async () => {
      await raw.legalFile.create({ data: fileData(a, 'SAME-1') });
      await expect(raw.legalFile.create({ data: fileData(a, 'SAME-1') })).rejects.toThrow();
      await expect(raw.legalFile.create({ data: fileData(b, 'SAME-1') })).resolves.toBeDefined();
    });

    it("should refuse to link a file to another office's client, party or user (composite FKs)", async () => {
      const [fileA, clientB, partyB] = [await file(a), await client(b), await party(b)];
      await expect(
        raw.fileClient.create({
          data: { officeId: a.officeId, fileId: fileA.id, clientId: clientB.id },
        }),
      ).rejects.toThrow();
      await expect(
        raw.fileParty.create({
          data: {
            officeId: a.officeId,
            fileId: fileA.id,
            partyId: partyB.id,
            partyType: 'DEFENDANT',
          },
        }),
      ).rejects.toThrow();
      await expect(
        raw.legalFile.create({
          data: { ...fileData(a, `T-${randomUUID()}`), responsibleLawyerId: b.userId },
        }),
      ).rejects.toThrow();
    });

    it('should allow one primary client per file', async () => {
      const fileA = await file(a);
      const link = async (isPrimary: boolean) =>
        raw.fileClient.create({
          data: {
            officeId: a.officeId,
            fileId: fileA.id,
            clientId: (await client(a)).id,
            isPrimary,
          },
        });
      await link(true);
      await link(false);
      await expect(link(true)).rejects.toThrow();
    });

    it.each([
      [
        'a party without its name',
        () =>
          raw.party.create({ data: { officeId: a.officeId, isIndividual: false, fullName: 'X' } }),
      ],
      [
        'a closing date before the opening date',
        () =>
          raw.legalFile.create({
            data: {
              ...fileData(a, `T-${randomUUID()}`),
              openingDate: new Date('2026-05-02'),
              closingDate: new Date('2026-05-01'),
            },
          }),
      ],
      [
        'a negative hourly rate',
        () =>
          raw.legalFile.create({ data: { ...fileData(a, `T-${randomUUID()}`), hourlyRate: '-1' } }),
      ],
      [
        'a note on neither a file nor a client',
        () =>
          raw.fileNote.create({ data: { officeId: a.officeId, authorId: a.userId, body: 'x' } }),
      ],
      [
        'a conflict between a file and itself',
        async () => {
          const [fileA, partyA] = [await file(a), await party(a)];
          return raw.conflictOfInterest.create({
            data: {
              officeId: a.officeId,
              fileIdA: fileA.id,
              fileIdB: fileA.id,
              partyId: partyA.id,
              reason: 'x',
            },
          });
        },
      ],
    ])('should refuse %s (CHECK)', async (_case, create: () => Promise<unknown>) => {
      await expect(create()).rejects.toThrow();
    });
  });
});
