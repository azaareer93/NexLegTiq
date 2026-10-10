import { CaseQuerySchema } from '@nexlegtiq/shared-contracts';

import { CasesRepository } from './cases.repository';
import type { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';

const LAWYER = { id: 'u1', fullName: 'Lina Lawyer' };
const ROW = {
  id: 'f1',
  fileNumber: '2026-LIT-00001',
  title: 'Land dispute',
  fileType: 'LITIGATION',
  status: 'OPEN',
  priority: 'MEDIUM',
  openingDate: new Date('2026-10-08T00:00:00Z'),
  isConfidential: false,
  updatedAt: new Date('2026-10-08T10:00:00Z'),
  responsibleLawyer: LAWYER,
  clients: [{ client: { id: 'c1', displayName: 'Ahmad' } }],
};

function repository() {
  const legalFile = {
    findMany: jest.fn().mockResolvedValue([ROW, { ...ROW, id: 'f2', clients: [] }]),
    count: jest.fn().mockResolvedValue(42),
    findFirstOrThrow: jest.fn(),
  };
  const prisma = { db: { legalFile } } as unknown as PrismaService;
  return { repo: new CasesRepository(prisma), legalFile };
}

describe('CasesRepository', () => {
  it('should combine access, filters, search, sort and paging, and map list rows', async () => {
    const { repo, legalFile } = repository();
    const query = CaseQuerySchema.parse({
      status: 'OPEN',
      fileType: 'LITIGATION',
      priority: 'HIGH',
      search: 'land',
      clientId: '01920000-0000-7000-8000-0000000000c1',
      responsibleLawyerId: '01920000-0000-7000-8000-0000000000a1',
      sort: 'title:asc,priority:desc',
      page: '3',
      limit: '10',
    });
    const result = await repo.list({ deletedAt: null }, query);

    const args = legalFile.findMany.mock.calls[0]?.[0] as Prisma.LegalFileFindManyArgs;
    expect(args).toMatchObject({
      where: {
        AND: [
          { deletedAt: null },
          {
            status: 'OPEN',
            fileType: { in: ['LITIGATION'] },
            priority: 'HIGH',
            responsibleLawyerId: '01920000-0000-7000-8000-0000000000a1',
            clients: { some: { clientId: '01920000-0000-7000-8000-0000000000c1' } },
            OR: expect.arrayContaining([{ title: { contains: 'land', mode: 'insensitive' } }]),
          },
        ],
      },
      orderBy: [{ title: 'asc' }, { priority: 'desc' }, { id: 'asc' }],
      skip: 20,
      take: 10,
    });
    expect(legalFile.count).toHaveBeenCalledWith({ where: args.where });
    expect(result.total).toBe(42);
    expect(result.items).toEqual([
      {
        id: 'f1',
        fileNumber: '2026-LIT-00001',
        title: 'Land dispute',
        fileType: 'LITIGATION',
        status: 'OPEN',
        priority: 'MEDIUM',
        openingDate: '2026-10-08',
        isConfidential: false,
        primaryClient: { id: 'c1', displayName: 'Ahmad' },
        responsibleLawyer: LAWYER,
        updatedAt: '2026-10-08T10:00:00.000Z',
      },
      expect.objectContaining({ id: 'f2', primaryClient: null }),
    ]);
  });

  it('should add no filter for an empty query', async () => {
    const { repo, legalFile } = repository();
    await repo.list({}, CaseQuerySchema.parse({}));
    expect(legalFile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{}, {}] },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: 0,
        take: 20,
      }),
    );
  });

  it('should map a file with money as 2-decimal strings, dates as calendar dates and its team', async () => {
    const { repo, legalFile } = repository();
    legalFile.findFirstOrThrow.mockResolvedValue({
      ...ROW,
      description: null,
      subType: null,
      closingDate: new Date('2026-12-31T00:00:00Z'),
      courtCaseNumber: '12/2026',
      jurisdiction: 'PALESTINE',
      billingMethod: 'HOURLY',
      hourlyRate: new Prisma.Decimal('150'),
      fixedFee: null,
      retainerBalance: new Prisma.Decimal('0'),
      currency: 'ILS',
      createdAt: new Date('2026-10-08T09:00:00Z'),
      responsibleParalegal: null,
      clients: [
        { isPrimary: false, client: { id: 'c2', displayName: 'B', clientType: 'CORPORATION' } },
        { isPrimary: true, client: { id: 'c1', displayName: 'A', clientType: 'INDIVIDUAL' } },
      ],
      teamMembers: [{ role: 'RESPONSIBLE_LAWYER', user: LAWYER }],
      _count: { parties: 2, notes: 1 },
    });
    await expect(repo.get('f1')).resolves.toMatchObject({
      primaryClient: { id: 'c1', displayName: 'A' },
      closingDate: '2026-12-31',
      hourlyRate: '150.00',
      fixedFee: null,
      retainerBalance: '0.00',
      clients: [
        { id: 'c2', displayName: 'B', clientType: 'CORPORATION', isPrimary: false },
        { id: 'c1', displayName: 'A', clientType: 'INDIVIDUAL', isPrimary: true },
      ],
      team: [{ ...LAWYER, role: 'RESPONSIBLE_LAWYER' }],
      counts: { parties: 2, notes: 1 },
      createdAt: '2026-10-08T09:00:00.000Z',
    });
  });
});
