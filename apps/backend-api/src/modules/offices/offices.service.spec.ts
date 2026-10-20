import { FileNumberFormatSchema } from '@nexlegtiq/shared-contracts';
import type { ClsService } from 'nestjs-cls';

import { changes, OfficesService } from './offices.service';
import type { RequestContext } from '../../common/context/request-context';
import { ValidationException } from '../../common/errors/app.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';
import { parseFileNumberFormat } from '../legal-files/file-number';

const CALLER = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const SETTINGS_ROW = {
  id: 's1',
  courtReminderDays: [7, 3, 1],
  taskReminderDays: [1],
  defaultBillingRate: null,
  defaultBillingMethod: 'HOURLY',
  taxRatePercent: new Prisma.Decimal(0),
  enableAi: true,
  enableOcr: true,
  fileNumberFormat: '{YEAR}-{TYPE}-{SEQ:5}',
  sessionIdleMinutes: 30,
  auditRetentionDays: 365,
};

function setup(context: Partial<RequestContext> = { officeId: 'o1', userId: 'u1' } as never) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    office: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'o1', name: 'Office', website: null }),
      update: jest.fn(),
    },
    officeSettings: {
      findFirst: jest.fn().mockResolvedValue(SETTINGS_ROW),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma = { db: tx } as unknown as PrismaService;
  const uow = {
    run: (work: (t: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as UnitOfWork;
  const cls = {
    get: (key: keyof RequestContext) => context[key],
  } as unknown as ClsService<RequestContext>;
  return { tx, service: new OfficesService(prisma, uow, cls) };
}

describe('OfficesService', () => {
  it('should present decimals as strings and leave out the row id', async () => {
    const { service } = setup();
    expect(await service.settings()).toEqual({
      ...SETTINGS_ROW,
      id: undefined,
      defaultBillingRate: null,
      taxRatePercent: '0.00',
    });
  });

  it('should write and audit nothing when nothing changes', async () => {
    const { service, tx } = setup();
    await service.updateProfile({ name: 'Office', website: null }, CALLER);
    await service.updateSettings({ courtReminderDays: [7, 3, 1], taxRatePercent: '0' }, CALLER);
    expect(tx.office.update).not.toHaveBeenCalled();
    expect(tx.officeSettings.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('should audit the old and new value of a changed field', async () => {
    const { service, tx } = setup();
    await service.updateSettings({ enableOcr: false }, CALLER);
    expect(tx.officeSettings.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { enableOcr: false },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: 'OfficeSettings',
        entityId: 's1',
        oldValues: { enableOcr: true },
        newValues: { enableOcr: false },
      }),
    });
  });

  it('should refuse a format the file-number parser refuses, and fail loudly without a settings row', async () => {
    const { service, tx } = setup();
    await expect(
      service.updateSettings({ fileNumberFormat: '{TYPE}' }, CALLER),
    ).rejects.toBeInstanceOf(ValidationException);
    tx.officeSettings.findFirst.mockResolvedValue(null);
    await expect(service.settings()).rejects.toThrow('Office settings row is missing');
  });

  it('should need an office and a caller in the request context', async () => {
    await expect(setup({}).service.updateSettings({ enableAi: false }, CALLER)).rejects.toThrow(
      'No office',
    );
    await expect(
      setup({ officeId: 'o1' } as never).service.updateSettings({ enableAi: false }, CALLER),
    ).rejects.toThrow('No user');
  });

  it('should compare decimals as numbers and arrays by their items', () => {
    const before = { rate: new Prisma.Decimal('150'), days: [7, 1], none: new Prisma.Decimal(1) };
    expect(changes(before, { rate: '150.00', days: [7, 1] })).toEqual({ old: {}, next: {} });
    expect(changes(before, { rate: '151', days: [7], none: null })).toEqual({
      old: { rate: '150.00', days: [7, 1], none: '1.00' },
      next: { rate: '151', days: [7], none: null },
    });
  });
});

/** The contract's format check and the parser that numbers files must agree (D-095, D-125). */
describe('fileNumberFormat contract vs parser', () => {
  it.each([
    '{YEAR}-{TYPE}-{SEQ:5}',
    'F/{SEQ:3}',
    '{SEQ}',
    'ملف {YEAR}#{SEQ:9}',
    '{YEAR}-{TYPE}',
    '{SEQ}{SEQ}',
    '{SEQ:0}',
    '{SEQ:10}',
    '{CLIENT}-{SEQ}',
    '<b>{SEQ}',
    '{SEQ}٣',
    '{ SEQ }',
    '{SEQ',
    `${'x'.repeat(60)}{SEQ}`,
  ])('should judge %j the same way', (format) => {
    let parsed = true;
    try {
      parseFileNumberFormat(format);
    } catch {
      parsed = false;
    }
    expect(FileNumberFormatSchema.safeParse(format).success).toBe(parsed);
  });
});
