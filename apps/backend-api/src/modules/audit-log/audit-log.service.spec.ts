import { StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import { auditCsv, BOM, csvCell } from './audit-csv';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService, EXPORT_MAX_ROWS, toEntry } from './audit-log.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';

const ID = '01920000-0000-7000-8000-0000000000a1';
const row = (extra: object = {}) =>
  ({
    id: ID,
    occurredAt: new Date('2026-11-11T08:00:00.000Z'),
    userId: null,
    platformAdminId: null,
    clientUserId: null,
    action: 'UPDATE',
    entityType: 'Task',
    entityId: null,
    oldValues: null,
    newValues: null,
    user: null,
    ...extra,
  }) as never;

describe('audit CSV and entries (D-180)', () => {
  it('should quote every cell and defuse formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('-1')).toBe(`"'-1"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
  });

  it('should name each kind of actor and list the changed fields', () => {
    expect(toEntry(row({ userId: ID, user: { fullName: 'Omar' } })).actor).toEqual({
      type: 'USER',
      id: ID,
      name: 'Omar',
    });
    expect(toEntry(row({ platformAdminId: ID })).actor.type).toBe('PLATFORM_ADMIN');
    expect(toEntry(row({ clientUserId: ID })).actor).toEqual({
      type: 'CLIENT',
      id: ID,
      name: null,
    });
    expect(toEntry(row()).actor.type).toBe('SYSTEM');
    expect(toEntry(row({ oldValues: { a: 1 }, newValues: { a: 2, b: 'x' } })).changes).toEqual([
      { field: 'a', old: 1, new: 2 },
      { field: 'b', old: null, new: 'x' },
    ]);
    expect(toEntry(row({ newValues: ['not', 'an', 'object'] })).changes).toEqual([]);
  });

  it('should write a BOM, a header and office wall-clock times', () => {
    const csv = auditCsv([toEntry(row())], 'Asia/Hebron');
    expect(csv.startsWith(`${BOM}"occurredAt"`)).toBe(true);
    expect(csv).toContain('"2026-11-11 10:00","SYSTEM","","UPDATE","Task","",""');
  });
});

describe('AuditLogService (D-180)', () => {
  const FILE = '01920000-0000-7000-8000-0000000000f1';
  function setup(rows: unknown[] = [row(), row({ id: '01920000-0000-7000-8000-0000000000a2' })]) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const db = {
      auditLog: { findMany },
      legalFile: { findMany: jest.fn().mockResolvedValue([]) },
      task: { findMany: jest.fn().mockResolvedValue([{ id: 't1' }]) },
      document: { findMany: jest.fn().mockResolvedValue([]) },
      session: { findMany: jest.fn().mockResolvedValue([]) },
      fileNote: { findMany: jest.fn().mockResolvedValue([]) },
      timeEntry: { findMany: jest.fn().mockResolvedValue([]) },
      witness: { findMany: jest.fn().mockResolvedValue([]) },
      office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
    };
    const files = { assertFileAccess: jest.fn(), visibleWhere: () => ({ deletedAt: null }) };
    const audit = { log: jest.fn() };
    const service = new AuditLogService(
      { db } as unknown as PrismaService,
      files as unknown as CaseAccessService,
      audit as unknown as AuditService,
      { run: (work: (tx: unknown) => unknown) => work({}) } as unknown as UnitOfWork,
    );
    return { service, findMany, files, audit, db };
  }

  it('should apply every filter, office days and the cursor, and page by one extra row', async () => {
    const { service, findMany } = setup();
    const page = await service.list({
      limit: 1,
      cursor: ID,
      entityType: 'Task',
      entityId: ID,
      userId: ID,
      action: 'UPDATE',
      from: '2026-11-01',
      to: '2026-11-30',
    });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(ID);
    const args = findMany.mock.calls[0][0];
    expect(args).toMatchObject({ take: 2, skip: 1, cursor: { id: ID } });
    expect(args.where.AND[0]).toMatchObject({
      entityType: 'Task',
      entityId: ID,
      userId: ID,
      action: 'UPDATE',
    });
    // Hebron is UTC+2 in November: the office day starts at 22:00 UTC the day before.
    expect(args.where.AND[0].occurredAt.gte.toISOString()).toBe('2026-10-31T22:00:00.000Z');
    expect(args.where.AND[0].occurredAt.lt.toISOString()).toBe('2026-11-30T22:00:00.000Z');
    const open = await service.list({ limit: 5, from: '2026-11-01' });
    expect(open.nextCursor).toBeNull();
    expect(findMany.mock.calls[1][0].where.AND[0].occurredAt).toEqual({ gte: expect.any(Date) });
    await service.list({ limit: 5, to: '2026-11-01' });
    expect(findMany.mock.calls[2][0].where.AND[0].occurredAt).toEqual({ lt: expect.any(Date) });
  });

  it('should check the file and match its rows for a file audit', async () => {
    const { service, findMany, files } = setup([]);
    await service.list({ limit: 50 }, FILE);
    expect(files.assertFileAccess).toHaveBeenCalledWith(FILE, 'read');
    // The file, its task, and the two value matches.
    expect(findMany.mock.calls[0][0].where.AND[1].OR[0]).toEqual({
      entityId: { in: [FILE, 't1'] },
    });
    expect(findMany.mock.calls[0][0].where.AND[1].OR).toHaveLength(3);
  });

  it('should leave out the rows of files the caller may not see', async () => {
    const { service, findMany, db } = setup([]);
    db.legalFile.findMany.mockResolvedValueOnce([{ id: FILE }]).mockResolvedValueOnce([]);
    await service.list({ limit: 50 });
    expect(findMany.mock.calls[0][0].where.AND[1].OR[1]).toEqual({
      entityId: { notIn: [FILE, 't1'] },
    });
  });

  it('should export the rows and audit the export, refusing more than the cap', async () => {
    const { service, audit } = setup();
    // A dated export reads the office zone once and filters by its days.
    await service.exportCsv({ format: 'csv', from: '2026-11-01', to: '2026-11-02' }, {});
    const csv = await service.exportCsv({ format: 'csv', action: 'UPDATE' }, { ip: '127.0.0.1' });
    expect(csv.split('\r\n')).toHaveLength(4);
    expect(audit.log).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        action: 'EXPORT',
        newValues: { format: 'csv', filters: { action: 'UPDATE' }, rows: 2 },
      }),
      { ip: '127.0.0.1' },
    );
    const big = setup(Array.from({ length: EXPORT_MAX_ROWS + 1 }, () => row()));
    await expect(big.service.exportCsv({ format: 'csv' }, {})).rejects.toMatchObject({
      code: 'BIZ-025',
    });
  });

  it('should route the controller calls with or without a request context', async () => {
    const audit = {
      list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
      exportCsv: jest.fn().mockResolvedValue('csv'),
    };
    const make = (active: boolean) =>
      new AuditLogController(
        audit as unknown as AuditLogService,
        { isActive: () => active, getId: () => 'req-1' } as unknown as ClsService,
      );
    const req = { ip: '127.0.0.1', get: () => undefined } as unknown as Request;
    await make(true).list({ limit: 50 });
    await make(true).file(FILE, { limit: 50 });
    expect(audit.list).toHaveBeenLastCalledWith({ limit: 50 }, FILE);
    await expect(make(true).export({ format: 'csv' }, req)).resolves.toBeInstanceOf(StreamableFile);
    await make(false).export({ format: 'csv' }, req);
    expect(audit.exportCsv).toHaveBeenLastCalledWith(
      { format: 'csv' },
      expect.objectContaining({ requestId: null }),
    );
  });
});

describe('audit entry edges (D-180)', () => {
  it('should name no one for a user row without its user, and write the changes into the CSV', () => {
    expect(toEntry(row({ userId: ID, user: null })).actor).toEqual({
      type: 'USER',
      id: ID,
      name: null,
    });
    const csv = auditCsv([toEntry(row({ oldValues: { a: 1 }, newValues: { a: 2 } }))], 'UTC');
    expect(csv).toContain('""field"":""a""');
  });
});
