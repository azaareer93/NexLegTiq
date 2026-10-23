import type { ClsService } from 'nestjs-cls';

import type { ConflictsService } from './conflicts.service';
import { PartiesService } from './parties.service';
import { PartyRegistry } from './party-registry';
import type { RequestContext } from '../../common/context/request-context';
import { FieldCipher } from '../../common/crypto/field-cipher';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import type { CaseAccessService } from '../legal-files/case-access.service';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const FILE = '01920000-0000-7000-8000-0000000000f1';
const client: ClientInfo = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const cipher = new FieldCipher(new AppConfig(parseEnv(testEnv())));

const partyRow = (extra: object = {}) => ({
  id: 'p1',
  isIndividual: true,
  fullName: 'Omar',
  companyName: null,
  phone: null,
  email: null,
  nationalId: null,
  taxId: null,
  address: null,
  legalRepresentative: null,
  notes: null,
  nationalIdIndex: null,
  taxIdIndex: null,
  ...extra,
});

function setup({
  existing = partyRow() as object | null,
  filePartyBefore = { partyType: 'THIRD_PARTY', roleLabel: null, party: partyRow() } as
    object | null,
  remaining = 0,
} = {}) {
  const fileParty = {
    id: 'fp1',
    partyType: 'DEFENDANT',
    roleLabel: null,
    joinedAt: new Date('2026-10-23T10:00:00Z'),
    party: partyRow({ companyName: 'Org', fullName: null, taxId: 'plain-123' }),
  };
  const tx = {
    party: {
      findFirst: jest.fn().mockResolvedValue(existing),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) => Promise.resolve(partyRow(data))),
    },
    fileParty: {
      create: jest.fn().mockResolvedValue({ id: 'fp1' }),
      findFirst: jest.fn().mockResolvedValue(filePartyBefore),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(remaining),
    },
    conflictOfInterest: { findFirst: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
    caseTimelineEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const db = {
    ...tx,
    fileParty: { ...tx.fileParty, findFirst: jest.fn().mockResolvedValue(fileParty) },
    party: { findMany: jest.fn().mockResolvedValue([partyRow()]) },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'p1' }, { id: 'gone' }]),
  };
  const uow = {
    run: (work: (t: typeof tx) => unknown) => work(tx),
  } as unknown as UnitOfWork;
  const cls = {
    get: (key: string) => ({ userId: 'u1', officeId: OFFICE })[key],
  } as unknown as ClsService<RequestContext>;
  const access = { assertFileAccess: jest.fn() };
  const conflicts = { openFor: jest.fn().mockResolvedValue([]) };
  const prisma = { db } as unknown as PrismaService;
  const registry = new PartyRegistry(prisma, cls, cipher);
  const service = new PartiesService(
    prisma,
    uow,
    registry,
    access as unknown as CaseAccessService,
    conflicts as unknown as ConflictsService,
  );
  return { service, registry, tx, db, access };
}

describe('PartiesService (D-135)', () => {
  it('should search by name and blind indexes, keeping the SQL order and dropping vanished rows', async () => {
    const { registry, db } = setup();
    await expect(registry.search({ search: '٤٠١', limit: 20 })).resolves.toEqual([
      expect.objectContaining({ id: 'p1', name: 'Omar' }),
    ]);
    expect(db.$queryRaw).toHaveBeenCalled();
    await registry.search({ search: ' ', limit: 5 });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('should create a new party with encrypted fields and blind indexes, and present a plaintext tax id as is', async () => {
    const { service, tx } = setup();
    const result = await service.add(
      FILE,
      {
        party: { isIndividual: true, fullName: 'Omar', nationalId: '401', taxId: '9', notes: 'n' },
        partyType: 'DEFENDANT',
      },
      client,
    );
    const data = (tx.party.create.mock.calls[0]?.[0] as { data: Record<string, unknown> }).data;
    expect(data['nationalId']).toMatch(/^v1:/);
    expect(data['notes']).toMatch(/^v1:/);
    expect(data['nationalIdIndex']).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fileParty.party).toMatchObject({ name: 'Org', taxId: 'plain-123' });
    expect(tx.caseTimelineEvent.create).toHaveBeenCalled();
  });

  it('should refuse an unknown existing party', async () => {
    await expect(
      setup({ existing: null }).service.add(FILE, { partyId: 'x', partyType: 'PLAINTIFF' }, client),
    ).rejects.toMatchObject({ code: 'VAL-001' });
  });

  it('should write nothing for an unchanged update, and re-check conflicts on a new type', async () => {
    const same = setup();
    await same.service.update(FILE, 'fp1', { partyType: 'THIRD_PARTY' }, client);
    expect(same.tx.fileParty.update).not.toHaveBeenCalled();

    const retyped = setup();
    await retyped.service.update(FILE, 'fp1', { partyType: 'DEFENDANT' }, client);
    expect(retyped.tx.fileParty.update).toHaveBeenCalled();
    expect(retyped.tx.$queryRaw).toHaveBeenCalled();

    await expect(
      setup({ filePartyBefore: null }).service.update(FILE, 'x', { roleLabel: 'a' }, client),
    ).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should drop open conflicts only when the party has left the file', async () => {
    const gone = setup({ filePartyBefore: { partyId: 'p1', partyType: 'DEFENDANT' } });
    await gone.service.remove(FILE, 'fp1', client);
    expect(gone.tx.conflictOfInterest.deleteMany).toHaveBeenCalled();

    const stays = setup({
      filePartyBefore: { partyId: 'p1', partyType: 'DEFENDANT' },
      remaining: 1,
    });
    await stays.service.remove(FILE, 'fp1', client);
    expect(stays.tx.conflictOfInterest.deleteMany).not.toHaveBeenCalled();

    await expect(
      setup({ filePartyBefore: null }).service.remove(FILE, 'x', client),
    ).rejects.toMatchObject({
      code: 'RES-001',
    });
  });
});
