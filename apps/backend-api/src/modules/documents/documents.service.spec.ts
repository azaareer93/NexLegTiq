import { Readable } from 'node:stream';

import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import type { DocumentAccessService } from './document-access.service';
import { DocumentsService } from './documents.service';
import { discardBody, readUpload } from './upload/multipart';
import type { UploadIntake } from './upload/upload-intake';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';

jest.mock('./upload/multipart', () => ({
  readUpload: jest.fn(),
  discardBody: jest.fn().mockResolvedValue(undefined),
}));

const CLIENT = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const FILE_ID = 'f1';
const STORED = {
  key: 'o1/f1/d/x.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 9,
  checksumSha256: 'a'.repeat(64),
};
const incoming = () => ({
  filename: 'عقد.pdf',
  stream: Readable.from(['x']),
  truncated: () => false,
});
const prismaError = (code: string) =>
  Object.assign(new Error(code), { name: 'PrismaClientKnownRequestError', code });

type Existing = { id: string; status: string; currentVersion: number } | null;

function setup({ existing = null as Existing, current = 1 } = {}) {
  const tasks: (() => Promise<unknown>)[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    document: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(
        current
          ? {
              currentVersion: current,
              status: 'READY',
              isConfidential: true,
              originalFilename: 'old.pdf',
              mimeType: 'application/pdf',
              checksumSha256: 'b'.repeat(64),
            }
          : null,
      ),
    },
    documentVersion: { create: jest.fn() },
    caseTimelineEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const db = {
    document: { findFirst: jest.fn().mockResolvedValue(existing) },
    documentVersion: {
      findMany: jest.fn().mockResolvedValue([
        {
          versionNumber: 1,
          originalFilename: 'a.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 9n,
          checksumSha256: 'a'.repeat(64),
          changeNote: null,
          createdAt: new Date('2026-10-20T10:00:00Z'),
          createdBy: { id: 'u1', fullName: 'Lawyer' },
        },
      ]),
    },
  };
  const uow = {
    run: jest.fn(
      (work: (t: typeof tx, after: (task: () => Promise<unknown>) => void) => Promise<unknown>) =>
        work(tx, (task) => tasks.push(task)),
    ),
  };
  const intake = {
    beforeStoring: jest.fn((_file: unknown, checks: () => Promise<unknown>) => checks()),
    assertTargets: jest.fn().mockResolvedValue(undefined),
    recheck: jest.fn().mockResolvedValue(undefined),
    store: jest.fn().mockResolvedValue(STORED),
    discard: jest.fn().mockResolvedValue(undefined),
  };
  const documents = {
    assertDocumentAccess: jest
      .fn()
      .mockResolvedValue({ id: 'd1', fileId: FILE_ID, uploadedById: 'u1' }),
    assertMayReplace: jest.fn().mockResolvedValue(undefined),
    visibleWhere: () => ({}),
  };
  const queues = { enqueue: jest.fn().mockResolvedValue({}) };
  const context: Partial<RequestContext> = { officeId: 'o1' as never, userId: 'u1' as never };
  const service = new DocumentsService(
    { get: (key: keyof RequestContext) => context[key] } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    uow as unknown as UnitOfWork,
    documents as unknown as DocumentAccessService,
    intake as unknown as UploadIntake,
    queues as unknown as QueueProducer,
  );
  return { service, tx, db, uow, intake, queues, tasks, documents };
}

const req = () => ({ resume: jest.fn() }) as unknown as Request & { resume: jest.Mock };

describe('DocumentsService.upload', () => {
  beforeEach(() => {
    jest.mocked(readUpload).mockResolvedValue({
      fields: { fileId: FILE_ID, documentType: 'PLEADING' },
      file: incoming(),
    } as never);
  });

  it('should record the document, its first version, the timeline and audit, then queue the scan', async () => {
    const { service, tx, intake, queues, tasks } = setup();
    const result = await service.upload(req(), undefined, CLIENT);
    expect(result).toEqual({
      documentId: expect.any(String),
      versionNumber: 1,
      status: 'SCANNING',
    });
    expect(intake.assertTargets).toHaveBeenCalledWith({
      fileId: FILE_ID,
      documentType: 'PLEADING',
    });
    expect(tx.document.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: result.documentId,
        name: 'عقد.pdf',
        storageKey: STORED.key,
        status: 'SCANNING',
        isConfidential: false,
        idempotencyKey: null,
      }),
    });
    expect(tx.documentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ versionNumber: 1, changeNote: null }),
    });
    expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'DOCUMENT_UPLOADED' }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityType: 'Document', action: 'CREATE' }),
    });
    for (const task of tasks) await task();
    expect(queues.enqueue).toHaveBeenCalledWith(
      'ocr',
      'scan-document',
      { documentId: result.documentId, versionNumber: 1 },
      { jobId: `scan-${result.documentId}-v1` },
    );
  });

  it('should refuse a malformed or spent Idempotency-Key and replay a known one without reading the body', async () => {
    jest.mocked(readUpload).mockClear();
    await expect(setup().service.upload(req(), 'short', CLIENT)).rejects.toMatchObject({
      code: 'VAL-001',
      details: [{ field: 'Idempotency-Key' }],
    });
    expect(discardBody).toHaveBeenCalled();
    const { service } = setup({ existing: { id: 'd0', status: 'READY', currentVersion: 3 } });
    await expect(service.upload(req(), 'retry-key-1', CLIENT)).resolves.toEqual({
      documentId: 'd0',
      versionNumber: 3,
      status: 'READY',
    });
    expect(readUpload).not.toHaveBeenCalled();
    const spent = setup();
    spent.db.document.findFirst.mockResolvedValueOnce({ id: 'd0' }).mockResolvedValueOnce(null);
    await expect(spent.service.upload(req(), 'retry-key-2', CLIENT)).rejects.toMatchObject({
      code: 'RES-002',
    });
  });

  it('should delete the stored object when recording fails, and answer the winner of a key race', async () => {
    const { service, tx, intake, db } = setup();
    tx.document.create.mockRejectedValueOnce(new Error('db down'));
    await expect(service.upload(req(), undefined, CLIENT)).rejects.toThrow('db down');
    expect(intake.discard).toHaveBeenCalledWith(STORED.key);

    tx.document.create.mockRejectedValueOnce(prismaError('P2002'));
    db.document.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'winner' })
      .mockResolvedValueOnce({ currentVersion: 1, status: 'SCANNING' });
    await expect(service.upload(req(), 'race-key-1', CLIENT)).resolves.toMatchObject({
      documentId: 'winner',
    });

    tx.document.create.mockRejectedValueOnce(prismaError('P2002'));
    db.document.findFirst.mockResolvedValue(null);
    await expect(service.upload(req(), 'race-key-2', CLIENT)).rejects.toThrow('P2002');
  });
});

describe('DocumentsService versions', () => {
  beforeEach(() => {
    jest.mocked(readUpload).mockResolvedValue({
      fields: { changeNote: 'Signed' },
      file: incoming(),
    } as never);
  });

  it('should add version n + 1 under a lock, mirror it on the document and queue its scan', async () => {
    const { service, tx, documents } = setup({ current: 3 });
    await expect(service.addVersion('d1', req(), CLIENT)).resolves.toEqual({
      documentId: 'd1',
      versionNumber: 4,
      status: 'SCANNING',
    });
    expect(documents.assertDocumentAccess).toHaveBeenCalledWith('d1', 'contribute');
    expect(documents.assertMayReplace).toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.document.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({
        currentVersion: 4,
        status: 'SCANNING',
        ocrStatus: 'PENDING',
      }),
    });
    expect(tx.documentVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ versionNumber: 4, changeNote: 'Signed' }),
    });
  });

  it('should answer 404 for a document deleted meanwhile and remove the stored object', async () => {
    const { service, intake } = setup({ current: 0 });
    await expect(service.addVersion('d1', req(), CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
    expect(intake.discard).toHaveBeenCalledWith(STORED.key);
  });

  it('should list versions with plain numbers and ISO dates', async () => {
    const { service } = setup();
    await expect(service.versions('d1')).resolves.toEqual([
      expect.objectContaining({ sizeBytes: 9, createdAt: '2026-10-20T10:00:00.000Z' }),
    ]);
  });

  it('should need a user and an office in the request context', async () => {
    const { service } = setup();
    Object.assign(service, { cls: { get: () => undefined } });
    await expect(service.upload(req(), 'valid-key-1', CLIENT)).rejects.toThrow('No user');
  });
});
