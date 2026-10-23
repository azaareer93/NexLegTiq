import type { ClsService } from 'nestjs-cls';

import { AuditRetentionProcessor, PURGE_AUDIT_LOGS_JOB } from './audit-retention.processor';
import { AuditService, auditRow, redact } from './audit.service';
import type { PrismaService } from '../../database/prisma.service';
import type { RequestContext } from '../context/request-context';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';

function cls(store: Partial<RequestContext> | null, id = 'req-12345678') {
  return {
    isActive: () => store !== null,
    get: (key?: keyof RequestContext) => (key === undefined ? (store ?? {}) : store?.[key]),
    getId: () => id,
  } as unknown as ClsService<RequestContext>;
}

describe('redact (D-136)', () => {
  it('should hide encrypted identifiers and credentials and keep everything else as JSON', () => {
    expect(
      redact({
        nationalId: '401',
        taxId: null,
        passwordHash: 'h',
        token: 't',
        name: 'Omar',
        at: new Date('2026-10-23T10:00:00Z'),
        missing: undefined,
      }),
    ).toEqual({
      nationalId: '[encrypted]',
      taxId: null,
      passwordHash: '[redacted]',
      token: '[redacted]',
      name: 'Omar',
      at: '2026-10-23T10:00:00.000Z',
      missing: null,
    });
    expect(redact(null)).toBeUndefined();
  });
});

describe('auditRow / AuditService.row (D-136)', () => {
  it('should cap the user agent and null missing request facts', () => {
    const row = auditRow(
      { officeId: OFFICE, userId: null, entityType: 'X', action: 'CREATE' },
      { userAgent: 'a'.repeat(600) },
    );
    expect(row).toMatchObject({ entityId: null, ipAddress: null, requestId: null });
    expect(row.userAgent).toHaveLength(512);
    expect(row).not.toHaveProperty('oldValues');
  });

  it('should take office, user and request facts from the context, and let explicit values win', () => {
    const service = new AuditService(
      cls({ officeId: OFFICE as never, userId: USER as never, ip: '10.0.0.1', userAgent: 'ua' }),
      {} as PrismaService,
    );
    expect(
      service.row({ entityType: 'X', entityId: USER, action: 'UPDATE', newValues: { a: 1 } }),
    ).toEqual({
      officeId: OFFICE,
      userId: USER,
      entityType: 'X',
      entityId: USER,
      action: 'UPDATE',
      newValues: { a: 1 },
      ipAddress: '10.0.0.1',
      userAgent: 'ua',
      requestId: 'req-12345678',
    });
    expect(
      service.row(
        { entityType: 'X', action: 'SECURITY', userId: null },
        { ip: null, requestId: 'r-1' },
      ),
    ).toMatchObject({ userId: null, ipAddress: null, requestId: 'r-1' });
  });

  it('should refuse a row without an office', () => {
    const service = new AuditService(cls(null), {} as PrismaService);
    expect(() => service.row({ entityType: 'X', action: 'CREATE' })).toThrow('No office');
  });
});

describe('AuditService.view (D-136)', () => {
  function setup(recent: object | null, userId: string | null = USER) {
    const auditLog = {
      findFirst: jest.fn().mockResolvedValue(recent),
      create: jest.fn(),
    };
    const service = new AuditService(
      cls({ officeId: OFFICE as never, ...(userId && { userId: userId as never }) }),
      { db: { auditLog } } as unknown as PrismaService,
    );
    return { service, auditLog };
  }

  it('should write one VIEW per user and entity in the window', async () => {
    const fresh = setup(null);
    await expect(fresh.service.view('LegalFile', 'f1')).resolves.toBe(true);
    expect(fresh.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: 'LegalFile', entityId: 'f1', action: 'VIEW' }),
    });
    const throttled = setup({ id: 'a' });
    await expect(throttled.service.view('Document', 'd1')).resolves.toBe(false);
    expect(throttled.auditLog.create).not.toHaveBeenCalled();
    await expect(setup(null, null).service.view('Document', 'd1')).resolves.toBe(false);
  });
});

describe('AuditRetentionProcessor (D-136)', () => {
  it('should purge every office and report how many rows went', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ removed: 3 }]);
    const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
    const processor = new AuditRetentionProcessor(
      {} as never,
      { unscoped: () => ({ $queryRaw: queryRaw }) } as unknown as PrismaService,
      logger as never,
      {
        get: () => ({ upsertJobScheduler: jest.fn().mockRejectedValue(new Error('redis down')) }),
      } as never,
    );
    await expect(
      processor.process({ name: PURGE_AUDIT_LOGS_JOB, data: {} } as never),
    ).resolves.toEqual({
      removed: 3,
    });
    queryRaw.mockResolvedValueOnce([]);
    await expect(processor.purge()).resolves.toEqual({ removed: 0 });
    await processor.onApplicationBootstrap();
    expect(logger.warn).toHaveBeenCalled();
  });
});
