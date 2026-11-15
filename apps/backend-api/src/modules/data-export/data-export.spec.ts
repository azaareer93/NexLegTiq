import { StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';
import { csvCell, csvTable } from './export-csv';
import { OfficeExportBuilder } from './office-export.builder';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { MailService } from '../../common/mail/mail.service';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { StorageService } from '../../common/storage/storage.service';
import type { AppConfig } from '../../config/app-config';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';

const ID = '01920000-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-11-15T10:00:00.000Z');
const row = (extra: object = {}) => ({
  id: ID,
  status: 'QUEUED',
  sizeBytes: null,
  checksum: null,
  errorCode: null,
  expiresAt: null,
  createdAt: NOW,
  completedAt: null,
  requestedBy: { id: ID, fullName: 'Layla' },
  ...extra,
});
const cls = (store: Partial<RequestContext> = { officeId: 'o1' as never, userId: 'u1' as never }) =>
  ({ get: (k: keyof RequestContext) => store[k] }) as unknown as ClsService<RequestContext>;

function service(db: object, storage: object = {}) {
  const after: (() => unknown)[] = [];
  const audit = { log: jest.fn() };
  const queues = { enqueue: jest.fn() };
  const svc = new DataExportService(
    { db } as unknown as PrismaService,
    {
      run: async (work: (tx: unknown, a: (fn: () => unknown) => void) => unknown) => {
        const out = await work(db, (fn) => after.push(fn));
        for (const fn of after) await fn();
        return out;
      },
    } as unknown as UnitOfWork,
    queues as unknown as QueueProducer,
    audit as unknown as AuditService,
    storage as unknown as StorageService,
    cls(),
  );
  return { svc, audit, queues };
}

describe('DataExportService (D-184)', () => {
  it('should answer with the export being prepared, else create, audit and queue one', async () => {
    const running = service({ officeExport: { findFirst: jest.fn().mockResolvedValue(row()) } });
    await expect(running.svc.request({})).resolves.toMatchObject({ id: ID, status: 'QUEUED' });
    expect(running.queues.enqueue).not.toHaveBeenCalled();
    const fresh = service({
      officeExport: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(row()),
      },
    });
    await fresh.svc.request({ ip: '1.2.3.4' });
    expect(fresh.audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'EXPORT', entityType: 'OfficeExport' }),
      { ip: '1.2.3.4' },
    );
    expect(fresh.queues.enqueue).toHaveBeenCalledWith('report', 'office-export', { exportId: ID });
  });

  it('should list, and link only a ready unexpired export', async () => {
    const ready = row({
      status: 'READY',
      storageKey: 'o1/exports/x.zip',
      sizeBytes: 10n,
      expiresAt: new Date(Date.now() + 60_000),
      completedAt: NOW,
    });
    const findFirst = jest.fn().mockResolvedValue(ready);
    const presigned = jest.fn().mockResolvedValue('https://s3.test/x');
    const { svc, audit } = service(
      { officeExport: { findFirst, findMany: jest.fn().mockResolvedValue([ready]) } },
      { presignedGetUrl: presigned },
    );
    await expect(svc.list()).resolves.toEqual([expect.objectContaining({ sizeBytes: '10' })]);
    await expect(svc.download(ID, {})).resolves.toEqual({
      downloadUrl: 'https://s3.test/x',
      expiresIn: 900,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'DOWNLOAD' }),
      {},
    );
    findFirst.mockResolvedValueOnce({ ...ready, expiresAt: new Date(Date.now() - 1) });
    await expect(svc.download(ID, {})).rejects.toMatchObject({ code: 'BIZ-026' });
    findFirst.mockResolvedValueOnce({ ...ready, status: 'FAILED' });
    await expect(svc.download(ID, {})).rejects.toMatchObject({ code: 'BIZ-026' });
    findFirst.mockResolvedValueOnce(null);
    await expect(svc.download(ID, {})).rejects.toMatchObject({ code: 'RES-001' });
  });

  it("should export the user's own data, audited", async () => {
    const { svc, audit } = service({
      user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'u1', fullName: 'Omar' }) },
      task: { findMany: jest.fn().mockResolvedValue([{ id: 't1', big: 5n }]) },
      timeEntry: { findMany: jest.fn().mockResolvedValue([]) },
      fileNote: { findMany: jest.fn().mockResolvedValue([]) },
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
    });
    const text = await svc.userExport({});
    expect(JSON.parse(text)).toMatchObject({
      profile: { fullName: 'Omar' },
      tasks: [{ big: '5' }],
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityType: 'User' }),
      {},
    );
  });

  it('should hand calls to the service with or without a request context', async () => {
    const exports = {
      request: jest.fn().mockResolvedValue(row()),
      list: jest.fn().mockResolvedValue([]),
      download: jest.fn().mockResolvedValue({}),
      userExport: jest.fn().mockResolvedValue('{}'),
    };
    const make = (active: boolean) =>
      new DataExportController(
        exports as unknown as DataExportService,
        { isActive: () => active, getId: () => 'r1' } as unknown as ClsService,
      );
    const req = { ip: '127.0.0.1', get: () => undefined } as unknown as Request;
    await make(true).request(req);
    await make(false).list();
    await make(true).download(ID, req);
    await expect(make(false).userExport(req)).resolves.toBeInstanceOf(StreamableFile);
    expect(exports.request).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'r1' }));
  });
});

describe('export CSV', () => {
  it('should quote, defuse formulas and write dates and objects as text', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell(NOW)).toBe('"2026-11-15T10:00:00.000Z"');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('""');
    expect(csvTable(['a'], [{ a: 'x' }]).endsWith('"a"\r\n"x"\r\n')).toBe(true);
  });
});

describe('OfficeExportBuilder runs (D-184)', () => {
  function builder(found: object | null, build: () => Promise<unknown>) {
    const update = jest.fn().mockResolvedValue({
      requestedBy: { fullName: 'Layla', email: 'l@example.test', uiLanguage: 'EN' },
    });
    const db = {
      officeExport: { findFirst: jest.fn().mockResolvedValue(found), update },
      office: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const mail = { send: jest.fn().mockRejectedValue(new Error('smtp down')) };
    const logger = { setContext: jest.fn(), warn: jest.fn() };
    const b = new OfficeExportBuilder(
      { db } as unknown as PrismaService,
      {} as StorageService,
      mail as unknown as MailService,
      { mail: { officeAppUrl: 'https://app.test' } } as unknown as AppConfig,
      cls(),
      logger as unknown as PinoLogger,
    );
    jest
      .spyOn(b as unknown as { build: () => Promise<unknown> }, 'build')
      .mockImplementation(build);
    return { b, update, mail, logger };
  }

  it('should skip a missing or finished export', async () => {
    await expect(builder(null, jest.fn()).b.run({ exportId: ID })).resolves.toEqual({ skipped: 1 });
    await expect(builder({ status: 'READY' }, jest.fn()).b.run({ exportId: ID })).resolves.toEqual({
      skipped: 1,
    });
  });

  it('should mark it ready and email the requester, a lost email only logged', async () => {
    const { b, update, mail, logger } = builder({ status: 'QUEUED' }, () =>
      Promise.resolve({ key: 'o1/exports/x.zip', bytes: 12, checksum: 'a'.repeat(64) }),
    );
    await expect(b.run({ exportId: ID })).resolves.toEqual({ exportId: ID, bytes: 12 });
    expect(update.mock.calls[1][0].data).toMatchObject({ status: 'READY', sizeBytes: 12n });
    expect(mail.send).toHaveBeenCalledWith(
      'l@example.test',
      'export-ready',
      'EN',
      expect.objectContaining({
        link: `https://app.test/settings?export=${ID}`,
        officeName: 'NexLegTiq',
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('should mark it failed and let the job retry', async () => {
    const { b, update } = builder({ status: 'QUEUED' }, () =>
      Promise.reject(new Error('storage down')),
    );
    await expect(b.run({ exportId: ID })).rejects.toThrow('storage down');
    expect(update.mock.calls.at(-1)?.[0].data).toEqual({ status: 'FAILED', errorCode: 'SYS-001' });
  });
});

describe('OfficeExportBuilder build (D-184)', () => {
  it('should zip every entity, the CSVs and the documents under their folders, to the office storage key', async () => {
    const { Readable } = await import('node:stream');
    const list = (rows: unknown[] = []) => ({ findMany: jest.fn().mockResolvedValue(rows) });
    const db = {
      officeExport: {
        findFirst: jest.fn().mockResolvedValue({ status: 'QUEUED' }),
        update: jest.fn().mockResolvedValue({
          requestedBy: { fullName: 'Layla', email: 'l@example.test', uiLanguage: 'AR' },
        }),
      },
      office: {
        findMany: jest.fn().mockResolvedValue([{ id: 'o1' }]),
        findFirst: jest.fn().mockResolvedValue({ name: 'Haddad' }),
      },
      officeSettings: list(),
      user: list([{ id: 'u1', fullName: 'Layla' }]),
      client: list([{ displayName: '=cmd', size: 3n }]),
      legalFile: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'f1', fileNumber: '2026/LIT/1', title: 'Rent' }])
          .mockResolvedValueOnce([{ id: 'f1', fileNumber: '2026/LIT/1' }]),
      },
      fileClient: list(),
      fileTeamMember: list(),
      fileParty: list(),
      session: list(),
      task: list(),
      documentFolder: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { id: 'p', parentId: null, name: null, systemKey: 'EVIDENCE' },
            { id: 'c', parentId: 'p', name: 'Photos: day 1', systemKey: null },
          ]),
      },
      document: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            {
              id: 'd1aaaaaaaa',
              fileId: 'f1',
              folderId: 'c',
              originalFilename: 'a\u0001b?.pdf',
              storageKey: 'o1/f1/d1',
              checksumSha256: 'c'.repeat(64),
              sizeBytes: 4n,
            },
            {
              id: 'd2bbbbbbbb',
              fileId: 'gone',
              folderId: null,
              originalFilename: '',
              storageKey: 'o1/f1/d2',
              checksumSha256: 'd'.repeat(64),
              sizeBytes: 2n,
            },
          ]),
      },
      fileNote: list(),
      timeEntry: list(),
      invoice: list(),
      invoiceLineItem: list(),
      retainerEntry: list(),
      witness: list(),
      witnessStatement: list(),
      caseTimelineEvent: list(),
      auditLog: list(),
    };
    let zipped = Buffer.alloc(0);
    const storage = {
      keyFor: (...parts: string[]) => ['o1', ...parts].join('/'),
      getStream: jest
        .fn()
        .mockImplementation(() => Promise.resolve(Readable.from([Buffer.from('PDF')]))),
      put: jest.fn().mockImplementation(async (_key: string, body: NodeJS.ReadableStream) => {
        const chunks: Buffer[] = [];
        for await (const c of body) chunks.push(c as Buffer);
        zipped = Buffer.concat(chunks);
      }),
    };
    const b = new OfficeExportBuilder(
      { db } as unknown as PrismaService,
      storage as unknown as StorageService,
      { send: jest.fn().mockResolvedValue(undefined) } as unknown as MailService,
      { mail: { officeAppUrl: 'https://app.test' } } as unknown as AppConfig,
      cls(),
      { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger,
    );
    const done = await b.run({ exportId: ID });
    expect(storage.put).toHaveBeenCalledWith(`o1/exports/${ID}.zip`, expect.anything(), {
      contentType: 'application/zip',
    });
    expect(done).toMatchObject({ exportId: ID, bytes: zipped.length });
    const names = zipped.toString('latin1');
    expect(names).toContain('data/clients.json');
    expect(names).toContain('csv/invoices.csv');
    expect(names).toContain('documents/2026_LIT_1/EVIDENCE/Photos_ day 1/d1aaaaaa-a_b_.pdf');
    expect(names).toContain('documents/gone/d2bbbbbb-_');
    expect(storage.getStream).toHaveBeenCalledTimes(2);
  });

  it('should refuse to run without an office in the context', async () => {
    const b = new OfficeExportBuilder(
      { db: {} } as unknown as PrismaService,
      {} as StorageService,
      {} as MailService,
      {} as AppConfig,
      cls({}),
      { setContext: jest.fn() } as unknown as PinoLogger,
    );
    await expect(b.datasets()).rejects.toThrow('No office');
  });
});

describe('DataExportService without a caller', () => {
  it('should refuse to start or export without an office user in the context', async () => {
    const db = {
      officeExport: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      user: { findUniqueOrThrow: jest.fn() },
    };
    const svc = new DataExportService(
      { db } as unknown as PrismaService,
      {
        run: (work: (tx: unknown, a: () => void) => unknown) => work(db, () => undefined),
      } as unknown as UnitOfWork,
      {} as QueueProducer,
      { log: jest.fn() } as unknown as AuditService,
      {} as StorageService,
      cls({}),
    );
    await expect(svc.request({})).rejects.toThrow('No office');
    await expect(svc.userExport({})).rejects.toThrow('No user');
  });
});
