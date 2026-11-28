import { LegalFileTypesService } from './legal-file-types.service';
import { PlatformFileTypesService } from './platform-file-types.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { PlatformAuditService } from '../platform-auth/platform-audit.service';

const ADMIN = '01920000-0000-7000-8000-0000000000a1';
const CLIENT = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const AT = new Date('2026-11-28T10:00:00Z');
const TYPE = {
  id: '01920000-0000-7000-8000-0000000000c1',
  jurisdiction: 'KUWAIT',
  code: 'FAMILY',
  numberCode: 'FAM',
  nameAr: 'أحوال',
  nameEn: 'Family',
  sortOrder: 0,
  isActive: true,
  createdAt: AT,
  updatedAt: AT,
};
const SUB = {
  id: '01920000-0000-7000-8000-0000000000c2',
  jurisdiction: 'KUWAIT',
  typeCode: 'FAMILY',
  nameAr: 'طلاق',
  nameEn: 'Divorce',
  sortOrder: 0,
  isActive: true,
  createdAt: AT,
  updatedAt: AT,
};

function setup() {
  const tx = {
    legalFileType: {
      create: jest.fn().mockResolvedValue(TYPE),
      findUnique: jest.fn().mockResolvedValue(TYPE),
      update: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ ...TYPE, subTypes: [SUB] }),
    },
    legalFileSubType: {
      create: jest.fn().mockResolvedValue(SUB),
      findUnique: jest.fn().mockResolvedValue({ ...SUB, type: TYPE }),
      update: jest.fn(),
    },
    $executeRaw: jest.fn(),
  };
  const unscoped = {
    legalFileType: { findMany: jest.fn().mockResolvedValue([{ ...TYPE, subTypes: [SUB] }]) },
    $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
  };
  const prisma = { unscoped: () => unscoped } as unknown as PrismaService;
  const audit = { log: jest.fn() };
  const service = new PlatformFileTypesService(prisma, audit as unknown as PlatformAuditService);
  return { service, tx, unscoped, audit };
}

describe('PlatformFileTypesService (D-261)', () => {
  it("should list a country's types with their sub-types", async () => {
    const { service, unscoped } = setup();
    const [row] = await service.list({ jurisdiction: 'KUWAIT' });
    expect(row).toMatchObject({ code: 'FAMILY', numberCode: 'FAM', updatedAt: AT.toISOString() });
    expect(row?.subTypes).toEqual([
      {
        id: SUB.id,
        nameAr: 'طلاق',
        nameEn: 'Divorce',
        sortOrder: 0,
        isActive: true,
        updatedAt: AT.toISOString(),
      },
    ]);
    expect(unscoped.legalFileType.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jurisdiction: 'KUWAIT' } }),
    );
  });

  it('should create a type and audit it', async () => {
    const { service, audit } = setup();
    const body = {
      jurisdiction: 'KUWAIT' as const,
      code: 'FAMILY',
      numberCode: 'FAM',
      nameAr: 'أحوال',
      nameEn: 'Family',
      sortOrder: 0,
      isActive: true,
    };
    await service.create(body, ADMIN, CLIENT);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'FILE_TYPE_CREATED',
        entityType: 'LegalFileType',
        newValues: body,
      }),
      CLIENT,
      expect.anything(),
    );
  });

  it('should update only what changed, audit it, and skip a no-op', async () => {
    const { service, tx, audit } = setup();
    await service.update(TYPE.id, { isActive: false, nameEn: 'Family' }, ADMIN, CLIENT);
    expect(tx.legalFileType.update).toHaveBeenCalledWith({
      where: { id: TYPE.id },
      data: { isActive: false },
    });
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ oldValues: { isActive: true }, newValues: { isActive: false } }),
      CLIENT,
      expect.anything(),
    );
    audit.log.mockClear();
    tx.legalFileType.update.mockClear();
    await service.update(TYPE.id, { nameEn: 'Family' }, ADMIN, CLIENT);
    expect(tx.legalFileType.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('should answer 404 for an unknown type or sub-type', async () => {
    const { service, tx } = setup();
    tx.legalFileType.findUnique.mockResolvedValue(null);
    tx.legalFileSubType.findUnique.mockResolvedValue(null);
    await expect(
      service.update(TYPE.id, { isActive: false }, ADMIN, CLIENT),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
    await expect(
      service.createSubType(TYPE.id, { nameAr: 'أ', nameEn: 'A' }, ADMIN, CLIENT),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
    await expect(
      service.updateSubType(SUB.id, { isActive: false }, ADMIN, CLIENT),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it("should add a sub-type under the type's country and code, audited with both", async () => {
    const { service, tx, audit } = setup();
    await service.createSubType(TYPE.id, { nameAr: 'طلاق', nameEn: 'Divorce' }, ADMIN, CLIENT);
    expect(tx.legalFileSubType.create).toHaveBeenCalledWith({
      data: { nameAr: 'طلاق', nameEn: 'Divorce', jurisdiction: 'KUWAIT', typeCode: 'FAMILY' },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'FILE_SUB_TYPE_CREATED',
        entityType: 'LegalFileSubType',
        newValues: expect.objectContaining({ jurisdiction: 'KUWAIT', typeCode: 'FAMILY' }),
      }),
      CLIENT,
      expect.anything(),
    );
  });

  it('should re-index the files of a renamed sub-type, not of one only reordered', async () => {
    const { service, tx } = setup();
    await service.updateSubType(SUB.id, { sortOrder: 3 }, ADMIN, CLIENT);
    expect(tx.legalFileSubType.update).toHaveBeenCalledWith({
      where: { id: SUB.id },
      data: { sortOrder: 3 },
    });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    await service.updateSubType(SUB.id, { nameAr: 'خلع' }, ADMIN, CLIENT);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    await service.updateSubType(SUB.id, { nameEn: 'Separation' }, ADMIN, CLIENT);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    tx.legalFileSubType.update.mockClear();
    await service.updateSubType(SUB.id, { nameEn: 'Divorce' }, ADMIN, CLIENT);
    expect(tx.legalFileSubType.update).not.toHaveBeenCalled();
  });
});

describe('LegalFileTypesService (D-261)', () => {
  it("should list the active types of the office's country", async () => {
    const db = {
      office: { findFirstOrThrow: jest.fn().mockResolvedValue({ jurisdiction: 'JORDAN' }) },
      legalFileType: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new LegalFileTypesService({ db } as unknown as PrismaService);
    await expect(service.list()).resolves.toEqual([]);
    expect(db.legalFileType.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jurisdiction: 'JORDAN', isActive: true } }),
    );
  });
});
