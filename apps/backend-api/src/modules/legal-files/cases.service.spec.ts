import { CaseQuerySchema, CreateCaseSchema } from '@nexlegtiq/shared-contracts';
import type { ClsService } from 'nestjs-cls';

import type { CaseAccessService } from './case-access.service';
import type { CasesRepository } from './cases.repository';
import { CasesService } from './cases.service';
import type { FileNumberService } from './file-number.service';
import type { RequestContext } from '../../common/context/request-context';
import { PermissionDeniedException, ValidationException } from '../../common/errors/app.exception';
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

function setup(
  context: Partial<RequestContext> = { officeId: OFFICE as never, userId: USER as never },
) {
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
      findFirstOrThrow: jest.fn().mockResolvedValue({ title: 'Old', courtCaseNumber: '1/2026' }),
      update: jest.fn().mockResolvedValue({}),
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
    get: jest.fn().mockResolvedValue({ id: 'f1' }),
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

  it('should check access before reading, editing and deleting, and audit the old and new values', async () => {
    const { service, tx, access } = setup();
    await service.get('f1');
    expect(access.assertFileAccess).toHaveBeenLastCalledWith('f1', 'read');

    await service.update('f1', { title: 'New', courtCaseNumber: null }, CLIENT_INFO);
    expect(access.assertFileAccess).toHaveBeenLastCalledWith('f1', 'write');
    expect(tx.legalFile.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 'f1' },
      select: { title: true, courtCaseNumber: true },
    });
    expect(tx.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE',
        oldValues: { title: 'Old', courtCaseNumber: '1/2026' },
        newValues: { title: 'New', courtCaseNumber: null },
      }),
    });

    await service.remove('f1', CLIENT_INFO);
    expect(access.assertFileAccess).toHaveBeenLastCalledWith('f1', 'write');
    expect(tx.legalFile.update).toHaveBeenLastCalledWith({
      where: { id: 'f1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: 'DELETE' }),
    });
  });

  it('should fail closed without a caller or office in the context', async () => {
    await expect(setup({}).service.create(input(), CLIENT_INFO)).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    await expect(
      setup({ userId: USER as never }).service.create(input(), CLIENT_INFO),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
  });
});
