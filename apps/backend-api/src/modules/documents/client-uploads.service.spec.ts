import type { ClsService } from 'nestjs-cls';

import { ClientUploadsService } from './client-uploads.service';
import type { UploadIntake } from './upload/upload-intake';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { StorageService } from '../../common/storage/storage.service';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';
import type { TimelineService } from '../timeline/timeline.service';

const NO_CLIENT = { ip: '127.0.0.1', userAgent: null, requestId: null };
const when = new Date('2026-11-16T10:00:00Z');
const row = (status: string) => ({
  id: 'u1',
  fileId: 'f1',
  originalFilename: 'scan.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 10n,
  checksumSha256: 'a'.repeat(64),
  storageKey: 'o1/f1/u1/x.pdf',
  status,
  rejectionReason: null,
  createdAt: when,
  reviewedAt: null,
  documentId: null,
  client: { id: 'c1', displayName: 'Layla' },
  clientUser: { fullName: 'Layla' },
  reviewedBy: null,
});

function setup(status = 'PENDING_REVIEW') {
  const after: (() => Promise<unknown>)[] = [];
  const tx = {
    $queryRaw: jest.fn(),
    clientUpload: { findFirstOrThrow: jest.fn().mockResolvedValue(row(status)), update: jest.fn() },
    documentFolder: { findFirstOrThrow: jest.fn().mockResolvedValue({ id: 'folder-cu' }) },
    document: { create: jest.fn() },
    documentVersion: { create: jest.fn() },
    auditLog: { create: jest.fn(), createMany: jest.fn() },
  };
  const db = {
    clientUpload: {
      findMany: jest.fn().mockResolvedValue([row(status)]),
      findFirst: jest.fn().mockResolvedValue(row(status)),
    },
    auditLog: { create: jest.fn() },
  };
  const files = { assertFileAccess: jest.fn() };
  const intake = { recheck: jest.fn() };
  const storage = {
    presignedGetUrl: jest.fn().mockResolvedValue('https://s3/x'),
    delete: jest.fn(),
  };
  const queues = { enqueue: jest.fn() };
  const timeline = { record: jest.fn() };
  const context: Record<string, string> = { officeId: 'o1', userId: 'lawyer' };
  const service = new ClientUploadsService(
    { get: (key: string) => context[key] } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    {
      run: async (
        work: (t: typeof tx, a: (f: () => Promise<unknown>) => void) => Promise<void>,
      ) => {
        await work(tx, (f) => after.push(f));
        for (const f of after) await f();
      },
    } as unknown as UnitOfWork,
    files as unknown as CaseAccessService,
    intake as unknown as UploadIntake,
    storage as unknown as StorageService,
    queues as unknown as QueueProducer,
    timeline as unknown as TimelineService,
  );
  return { service, tx, db, files, intake, storage, queues, timeline, context };
}

describe('ClientUploadsService (D-187)', () => {
  it("should list a file's uploads for anyone who may read the file", async () => {
    const { service, files } = setup();
    await expect(service.list('f1')).resolves.toEqual([
      expect.objectContaining({
        id: 'u1',
        uploaderName: 'Layla',
        sizeBytes: '10',
        reviewedAt: null,
      }),
    ]);
    expect(files.assertFileAccess).toHaveBeenCalledWith('f1', 'read');
  });

  it('should give a link to an upload under review only, audited', async () => {
    const { service, db } = setup();
    await expect(service.download('u1', NO_CLIENT)).resolves.toEqual({
      downloadUrl: 'https://s3/x',
      expiresIn: expect.any(Number),
    });
    expect(db.auditLog.create.mock.calls[0][0].data).toMatchObject({ action: 'DOWNLOAD' });
    await expect(setup('REJECTED').service.download('u1', NO_CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should accept into the Client Uploads folder as a processing document, with timeline, audit and extraction', async () => {
    const { service, tx, files, intake, queues, timeline } = setup();
    await service.accept('u1', { documentType: 'EVIDENCE' }, NO_CLIENT);
    expect(files.assertFileAccess).toHaveBeenCalledWith('f1', 'contribute');
    expect(intake.recheck).toHaveBeenCalledWith(tx, { fileId: 'f1', folderId: 'folder-cu' });
    const created = tx.document.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      fileId: 'f1',
      folderId: 'folder-cu',
      name: 'scan.pdf',
      status: 'PROCESSING',
      uploadedById: 'lawyer',
      storageKey: 'o1/f1/u1/x.pdf',
    });
    expect(tx.clientUpload.update.mock.calls[0][0].data).toMatchObject({
      status: 'ACCEPTED',
      reviewedById: 'lawyer',
      documentId: created.id,
    });
    expect(timeline.record.mock.calls[0][1]).toMatchObject({ eventType: 'DOCUMENT_UPLOADED' });
    expect(tx.auditLog.createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(queues.enqueue).toHaveBeenCalledWith(
      'ocr',
      'process-document',
      { documentId: created.id, versionNumber: 1 },
      expect.anything(),
    );
  });

  it('should take a chosen folder and name on accept', async () => {
    const { service, tx } = setup();
    await service.accept(
      'u1',
      { documentType: 'OTHER', folderId: 'folder-x', name: 'Lease' },
      NO_CLIENT,
    );
    expect(tx.documentFolder.findFirstOrThrow).not.toHaveBeenCalled();
    expect(tx.document.create.mock.calls[0][0].data).toMatchObject({
      folderId: 'folder-x',
      name: 'Lease',
    });
  });

  it('should reject with the reason, audit it and delete the object', async () => {
    const { service, tx, storage } = setup();
    await service.reject('u1', { reason: 'Unsigned' }, NO_CLIENT);
    expect(tx.clientUpload.update.mock.calls[0][0].data).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'Unsigned',
    });
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledWith('o1/f1/u1/x.pdf');
  });

  it('should decide once (BIZ-028), never before a clean scan (BIZ-015), and 404 an unknown upload', async () => {
    for (const status of ['ACCEPTED', 'REJECTED']) {
      await expect(
        setup(status).service.reject('u1', { reason: 'x' }, NO_CLIENT),
      ).rejects.toMatchObject({ code: 'BIZ-028' });
    }
    for (const status of ['SCANNING', 'QUARANTINED', 'FAILED']) {
      await expect(
        setup(status).service.accept('u1', { documentType: 'OTHER' }, NO_CLIENT),
      ).rejects.toMatchObject({ code: 'BIZ-015' });
    }
    const missing = setup();
    missing.db.clientUpload.findFirst.mockResolvedValue(null);
    await expect(missing.service.reject('u1', { reason: 'x' }, NO_CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
    const gone = setup();
    gone.db.clientUpload.findFirst
      .mockResolvedValueOnce(row('PENDING_REVIEW'))
      .mockResolvedValueOnce(null);
    await expect(gone.service.reject('u1', { reason: 'x' }, NO_CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should need an office caller', async () => {
    const { service, context } = setup();
    delete context['userId'];
    await expect(service.accept('u1', { documentType: 'OTHER' }, NO_CLIENT)).rejects.toThrow(
      'No user in the request context',
    );
    delete context['officeId'];
    await expect(service.download('u1', NO_CLIENT)).rejects.toThrow(
      'No office in the request context',
    );
  });
});
