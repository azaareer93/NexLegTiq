import { Readable } from 'node:stream';

import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { DocumentScan } from './document-scan';
import type { ClamavScanner, ScanResult } from './upload/clamav-scanner';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { StorageService } from '../../common/storage/storage.service';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';

const JOB = { documentId: '01920000-0000-7000-8000-0000000000d1', versionNumber: 2 };
const VERSION = {
  storageKey: 'o1/f1/d1/v2.pdf',
  createdById: 'u1',
  document: { name: 'عقد.pdf', fileId: 'f1' },
};

function setup(
  result: ScanResult,
  { version = VERSION as typeof VERSION | null, updated = 1, office = 'o1' as string | null } = {},
) {
  const tasks: (() => Promise<unknown>)[] = [];
  const db = {
    documentVersion: { findFirst: jest.fn().mockResolvedValue(version) },
    document: { updateMany: jest.fn().mockResolvedValue({ count: updated }) },
    auditLog: { create: jest.fn() },
  };
  const uow = {
    run: (
      work: (tx: typeof db, after: (task: () => Promise<unknown>) => void) => Promise<unknown>,
    ) => work(db, (task) => tasks.push(task)),
  };
  const storage = {
    getStream: jest.fn().mockResolvedValue(Readable.from(['data'])),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const queues = { enqueue: jest.fn().mockResolvedValue({}) };
  const scanner = { scan: jest.fn().mockResolvedValue(result) };
  const scan = new DocumentScan(
    { get: () => office ?? undefined } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    uow as unknown as UnitOfWork,
    storage as unknown as StorageService,
    scanner as unknown as ClamavScanner,
    queues as unknown as QueueProducer,
    { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger,
  );
  return { scan, db, storage, queues, tasks };
}

const signal = new AbortController().signal;

describe('DocumentScan', () => {
  it('should move a clean version to PROCESSING and queue its text extraction', async () => {
    const { scan, db, queues } = setup({ infected: false });
    await expect(scan.run(JOB, signal)).resolves.toBe('CLEAN');
    expect(db.document.updateMany).toHaveBeenCalledWith({
      where: { id: JOB.documentId, currentVersion: 2, status: 'SCANNING' },
      data: { status: 'PROCESSING' },
    });
    expect(queues.enqueue).toHaveBeenCalledWith('ocr', 'process-document', JOB, {
      jobId: `process-${JOB.documentId}-v2`,
    });
  });

  it('should change nothing for a version that was replaced or no longer exists', async () => {
    const replaced = setup({ infected: false }, { updated: 0 });
    await expect(replaced.scan.run(JOB, signal)).resolves.toBe('SUPERSEDED');
    expect(replaced.queues.enqueue).not.toHaveBeenCalled();
    const gone = setup({ infected: false }, { version: null });
    await expect(gone.scan.run(JOB, signal)).resolves.toBe('SUPERSEDED');
    expect(gone.storage.getStream).not.toHaveBeenCalled();
  });

  it('should quarantine an infected version, audit it, delete the object and notify the uploader', async () => {
    const { scan, db, storage, queues, tasks } = setup({ infected: true, signature: 'Eicar' });
    await expect(scan.run(JOB, signal)).resolves.toBe('QUARANTINED');
    expect(db.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'QUARANTINED' } }),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        officeId: 'o1',
        action: 'SECURITY',
        newValues: { event: 'MALWARE_DETECTED', versionNumber: 2, signature: 'Eicar' },
      }),
    });
    for (const task of tasks) await task();
    expect(storage.delete).toHaveBeenCalledWith(VERSION.storageKey);
    expect(queues.enqueue).toHaveBeenCalledWith(
      'notification',
      'create-notification',
      expect.objectContaining({
        userId: 'u1',
        titleKey: 'shell.notifications.documentQuarantined',
        link: '/cases/f1?tab=documents',
      }),
      { jobId: `scan-${JOB.documentId}-v2-quarantined` },
    );
  });

  it('should mark a version that could not be scanned FAILED, and need an office', async () => {
    const { scan, db } = setup({ infected: false });
    await scan.markFailed(JOB);
    expect(db.document.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'FAILED' } }),
    );
    const noOffice = setup({ infected: true, signature: 'x' }, { office: null });
    await expect(noOffice.scan.run(JOB, signal)).rejects.toThrow('No office');
  });
});
