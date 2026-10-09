import { CaseQuerySchema, CreateCaseSchema } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import type { CaseAccessService } from './case-access.service';
import type { CasesRepository } from './cases.repository';
import { CasesService } from './cases.service';
import type { FileNumberService } from './file-number.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  PermissionDeniedException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { assignedFilesWhere } from '../../common/rbac/case-scope';
import type { UnitOfWork } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';

const OFFICE = '01920000-0000-7000-8000-0000000000aa';
const USER = '01920000-0000-7000-8000-000000000001';
const LAWYER = '01920000-0000-7000-8000-000000000002';
const PARALEGAL = '01920000-0000-7000-8000-000000000003';
const CLIENT = '01920000-0000-7000-8000-0000000000c1';
const CLIENT_2 = '01920000-0000-7000-8000-0000000000c2';
const CLIENT_INFO = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };

const caller = (role: Role, userId = USER): Partial<RequestContext> => ({
  officeId: OFFICE as never,
  userId: userId as never,
  role,
  permissions: permissionsFor(role),
});

function setup(context: Partial<RequestContext> = caller('OFFICE_MANAGER')) {
  const tx = {
    office: {
      findFirstOrThrow: jest
        .fn()
        .mockResolvedValue({ currency: 'ILS', jurisdiction: 'PALESTINE', timezone: 'Asia/Hebron' }),
    },
    officeSettings: {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        defaultBillingMethod: 'HOURLY',
        defaultBillingRate: new Prisma.Decimal('120'),
      }),
    },
    client: {
      count: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.length),
      ),
    },
    user: { count: jest.fn().mockResolvedValue(1) },
    legalFile: {
      create: jest.fn().mockResolvedValue({ id: 'f1' }),
      findFirst: jest.fn().mockResolvedValue({
        title: 'Old',
        description: null,
        priority: 'MEDIUM',
        hourlyRate: new Prisma.Decimal('120'),
        courtCaseNumber: '1/2026',
        isConfidential: false,
        responsibleLawyerId: LAWYER,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    fileClient: { createMany: jest.fn() },
    fileTeamMember: { createMany: jest.fn() },
    caseTimelineEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const uow = {
    run: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
  } as unknown as UnitOfWork;
  const cls = {
    get: (key: keyof RequestContext) => context[key],
  } as unknown as ClsService<RequestContext>;
  const access = {
    visibleWhere: jest.fn().mockReturnValue({ deletedAt: null }),
    assertFileAccess: jest.fn().mockResolvedValue({ id: 'f1' }),
  } as unknown as CaseAccessService;
  const numbers = {
    next: jest.fn().mockResolvedValue('2026-LIT-00007'),
  } as unknown as FileNumberService;
  const cases = {
    get: jest.fn().mockResolvedValue({
      id: 'f1',
      billingMethod: 'HOURLY',
      hourlyRate: '120.00',
      fixedFee: null,
      retainerBalance: '0.00',
    }),
    list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  } as unknown as CasesRepository;
  return {
    service: new CasesService(cls, uow, access, numbers, cases),
    tx,
    access,
    numbers,
    cases,
  };
}

const input = (overrides: Record<string, unknown> = {}) =>
  CreateCaseSchema.parse({
    title: 'Land dispute',
    fileType: 'LITIGATION',
    clientIds: [CLIENT, CLIENT_2],
    primaryClientId: CLIENT_2,
    responsibleLawyerId: LAWYER,
    ...overrides,
  });

describe('CasesService', () => {
  beforeAll(() => jest.useFakeTimers({ now: new Date('2026-12-31T22:30:00Z') }));
  afterAll(() => jest.useRealTimers());

  it("should open a file in the office's calendar year with defaults, links, team, timeline and audit", async () => {
    const { service, tx, numbers } = setup();
    await service.create(
      input({ responsibleParalegalId: PARALEGAL, description: '' }),
      CLIENT_INFO,
    );

    // 22:30 UTC on 31 December is already 1 January in Hebron (UTC+2).
    expect(numbers.next).toHaveBeenCalledWith(tx, 'LITIGATION', 2027);
    expect(tx.legalFile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        officeId: OFFICE,
        fileNumber: '2026-LIT-00007',
        description: null,
        openingDate: new Date('2027-01-01T00:00:00Z'),
        billingMethod: 'HOURLY',
        hourlyRate: '120.00',
        fixedFee: null,
        currency: 'ILS',
        jurisdiction: 'PALESTINE',
        responsibleParalegalId: PARALEGAL,
      }),
      select: { id: true },
    });
    expect(tx.fileClient.createMany).toHaveBeenCalledWith({
      data: [
        { officeId: OFFICE, fileId: 'f1', clientId: CLIENT, isPrimary: false },
        { officeId: OFFICE, fileId: 'f1', clientId: CLIENT_2, isPrimary: true },
      ],
    });
    expect(tx.fileTeamMember.createMany).toHaveBeenCalledWith({
      data: [
        { officeId: OFFICE, fileId: 'f1', userId: LAWYER, role: 'RESPONSIBLE_LAWYER' },
        { officeId: OFFICE, fileId: 'f1', userId: PARALEGAL, role: 'PARALEGAL' },
      ],
    });
    expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'FILE_OPENED',
        actorId: USER,
        payload: { fileNumber: '2026-LIT-00007' },
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'CREATE',
        entityType: 'LegalFile',
        entityId: 'f1',
        requestId: 'req-12345678',
      }),
    });
  });

  it('should take no default rate for a fixed-fee file, and keep a given rate', async () => {
    const { service, tx } = setup();
    await service.create(input({ billingMethod: 'FIXED_FEE', fixedFee: '900' }), CLIENT_INFO);
    expect(tx.legalFile.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hourlyRate: null, fixedFee: '900' }),
      }),
    );
    await service.create(input({ hourlyRate: '99.5' }), CLIENT_INFO);
    expect(tx.legalFile.create).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hourlyRate: '99.5' }) }),
    );
  });

  it('should report every unknown participant on its field and write nothing', async () => {
    const { service, tx } = setup();
    tx.client.count.mockResolvedValue(1); // one of the two clients is unknown
    tx.user.count.mockResolvedValue(0);
    const error = await service
      .create(input({ responsibleParalegalId: PARALEGAL }), CLIENT_INFO)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationException);
    expect((error as ValidationException).details).toEqual([
      { field: 'clientIds', message: 'validation.unknownClient' },
      { field: 'responsibleLawyerId', message: 'validation.responsibleLawyer' },
      { field: 'responsibleParalegalId', message: 'validation.responsibleParalegal' },
    ]);
    expect(tx.legalFile.create).not.toHaveBeenCalled();
  });

  it('should narrow the list to assigned files for scope=mine and page it', async () => {
    const { service, cases } = setup();
    const result = await service.list(CaseQuerySchema.parse({ scope: 'mine', page: '2' }));
    expect(cases.list).toHaveBeenCalledWith(
      { AND: [{ deletedAt: null }, assignedFilesWhere(USER as never)] },
      expect.objectContaining({ page: 2 }),
    );
    expect(result.pagination).toEqual({
      page: 2,
      limit: 20,
      total: 0,
      totalPages: 0,
      hasMore: false,
    });
    await service.list(CaseQuerySchema.parse({}));
    expect(cases.list).toHaveBeenLastCalledWith({ deletedAt: null }, expect.anything());
  });

  it('should check access before reading, editing and deleting, and audit only real changes', async () => {
    const { service, tx, access } = setup();
    await service.get('f1');
    expect(access.assertFileAccess).toHaveBeenLastCalledWith('f1', 'read');

    await service.update(
      'f1',
      {
        title: 'New',
        courtCaseNumber: null,
        priority: 'MEDIUM',
        hourlyRate: '120',
        description: '',
      },
      CLIENT_INFO,
    );
    expect(access.assertFileAccess).toHaveBeenLastCalledWith('f1', 'write');
    // Unchanged priority, rate (120 = 120.00) and description ('' is stored as null) are neither written nor audited.
    expect(tx.legalFile.updateMany).toHaveBeenCalledWith({
      where: { id: 'f1', deletedAt: null, status: { not: 'ARCHIVED' } },
      data: { title: 'New', courtCaseNumber: null },
    });
    expect(tx.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE',
        oldValues: { title: 'Old', courtCaseNumber: '1/2026' },
        newValues: { title: 'New', courtCaseNumber: null },
      }),
    });

    await service.update('f1', { hourlyRate: '99.50' }, CLIENT_INFO);
    expect(tx.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        oldValues: { hourlyRate: '120.00' },
        newValues: { hourlyRate: '99.50' },
      }),
    });

    await service.remove('f1', CLIENT_INFO);
    expect(access.assertFileAccess).toHaveBeenLastCalledWith('f1', 'write');
    expect(tx.legalFile.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'f1', deletedAt: null, status: { not: 'ARCHIVED' } },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: 'DELETE' }),
    });
  });

  it('should write nothing for a change that changes nothing', async () => {
    const { service, tx } = setup();
    await service.update('f1', { title: 'Old', isConfidential: false }, CLIENT_INFO);
    expect(tx.legalFile.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('should refuse a write to a file deleted or archived after the access check (404, no audit)', async () => {
    const { service, tx } = setup();
    tx.legalFile.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.update('f1', { title: 'New' }, CLIENT_INFO)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    await expect(service.remove('f1', CLIENT_INFO)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    tx.legalFile.findFirst.mockResolvedValue(null);
    await expect(service.update('f1', { title: 'New' }, CLIENT_INFO)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('should let only the manager or the responsible lawyer change confidentiality', async () => {
    await expect(
      setup().service.update('f1', { isConfidential: true }, CLIENT_INFO),
    ).resolves.toBeDefined();
    await expect(
      setup(caller('LAWYER', LAWYER)).service.update('f1', { isConfidential: true }, CLIENT_INFO),
    ).resolves.toBeDefined();
    for (const role of ['SENIOR_LAWYER', 'PARALEGAL'] as const) {
      const { service, tx } = setup(caller(role));
      await expect(
        service.update('f1', { isConfidential: true }, CLIENT_INFO),
      ).rejects.toBeInstanceOf(PermissionDeniedException);
      await expect(
        service.create(input({ isConfidential: true }), CLIENT_INFO),
      ).rejects.toBeInstanceOf(PermissionDeniedException);
      expect(tx.legalFile.updateMany).not.toHaveBeenCalled();
    }
  });

  it('should keep billing terms to invoice permissions', async () => {
    const paralegal = setup(caller('PARALEGAL'));
    await expect(
      paralegal.service.update('f1', { hourlyRate: '1' }, CLIENT_INFO),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(
      paralegal.service.create(input({ billingMethod: 'FIXED_FEE' }), CLIENT_INFO),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(paralegal.service.get('f1')).resolves.toMatchObject({ hourlyRate: '120.00' });

    await expect(setup(caller('TRAINEE')).service.get('f1')).resolves.toEqual({
      id: 'f1',
      billingMethod: null,
      hourlyRate: null,
      fixedFee: null,
      retainerBalance: null,
    });
  });

  it('should fail loudly (500) without a caller or office in the context', async () => {
    await expect(setup({}).service.create(input(), CLIENT_INFO)).rejects.toThrow('No caller');
    await expect(
      setup({
        userId: USER as never,
        permissions: permissionsFor('OFFICE_MANAGER'),
      }).service.create(input(), CLIENT_INFO),
    ).rejects.toThrow('No office');
  });
});
