import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { ClientUploadScan } from './client-upload-scan';
import type { ClamavScanner } from './upload/clamav-scanner';
import type { RequestContext } from '../../common/context/request-context';
import type { StorageService } from '../../common/storage/storage.service';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { NotificationService } from '../notifications/notification.service';

const UPLOAD = {
  storageKey: 'o1/f1/u1/x.pdf',
  originalFilename: 'عقد.pdf',
  fileId: 'f1',
  client: { displayName: 'Layla' },
  file: { responsibleLawyerId: 'lawyer' },
};

function setup(upload: object | null, infected: boolean, updated = 1) {
  const after: (() => Promise<unknown>)[] = [];
  const tx = {
    clientUpload: { updateMany: jest.fn().mockResolvedValue({ count: updated }) },
    auditLog: { create: jest.fn() },
  };
  const db = {
    clientUpload: {
      findFirst: jest.fn().mockResolvedValue(upload),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const storage = { getStream: jest.fn().mockResolvedValue('stream'), delete: jest.fn() };
  const notifications = { notify: jest.fn() };
  const scan = new ClientUploadScan(
    { get: () => 'o1' } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    {
      run: async (
        work: (t: typeof tx, a: (f: () => Promise<unknown>) => void) => Promise<void>,
      ) => {
        const result = await work(tx, (f) => after.push(f));
        for (const f of after) await f();
        return result;
      },
    } as unknown as UnitOfWork,
    storage as unknown as StorageService,
    {
      scan: jest.fn().mockResolvedValue(infected ? { infected, signature: 'Eicar' } : { infected }),
    } as unknown as ClamavScanner,
    notifications as unknown as NotificationService,
    { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger,
  );
  return { scan, tx, db, storage, notifications };
}

const signal = new AbortController().signal;

describe('ClientUploadScan (D-187)', () => {
  it('should put a clean upload up for review and tell the responsible lawyer', async () => {
    const { scan, tx, notifications } = setup(UPLOAD, false);
    await expect(scan.run({ uploadId: 'u1' }, signal)).resolves.toBe('CLEAN');
    expect(tx.clientUpload.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', status: 'SCANNING' },
      data: { status: 'PENDING_REVIEW' },
    });
    expect(notifications.notify).toHaveBeenCalledWith(
      ['lawyer'],
      expect.objectContaining({ type: 'CLIENT_UPLOAD', link: '/cases/f1?tab=documents' }),
      { jobId: 'scan-upload-u1-received' },
    );
  });

  it('should quarantine malware, audit it and delete the object', async () => {
    const { scan, tx, storage, notifications } = setup(UPLOAD, true);
    await expect(scan.run({ uploadId: 'u1' }, signal)).resolves.toBe('QUARANTINED');
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'SECURITY',
      entityType: 'ClientUpload',
      newValues: { event: 'MALWARE_DETECTED', signature: 'Eicar' },
    });
    expect(storage.delete).toHaveBeenCalledWith(UPLOAD.storageKey);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('should change nothing for an upload no longer scanning, and mark a lost scan FAILED', async () => {
    await expect(setup(null, false).scan.run({ uploadId: 'u1' }, signal)).resolves.toBe('SKIPPED');
    const raced = setup(UPLOAD, false, 0);
    await raced.scan.run({ uploadId: 'u1' }, signal);
    expect(raced.notifications.notify).not.toHaveBeenCalled();
    const infectedRace = setup(UPLOAD, true, 0);
    await expect(infectedRace.scan.run({ uploadId: 'u1' }, signal)).resolves.toBe('SKIPPED');
    expect(infectedRace.storage.delete).not.toHaveBeenCalled();
    const { scan, tx, storage } = setup(UPLOAD, false);
    await scan.markFailed({ uploadId: 'u1' });
    expect(tx.clientUpload.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', status: 'SCANNING' },
      data: { status: 'FAILED' },
    });
    expect(storage.delete).toHaveBeenCalledWith(UPLOAD.storageKey);
    const gone = setup(null, false);
    await gone.scan.markFailed({ uploadId: 'u1' });
    expect(gone.tx.clientUpload.updateMany).not.toHaveBeenCalled();
    const racedFail = setup(UPLOAD, false, 0);
    await racedFail.scan.markFailed({ uploadId: 'u1' });
    expect(racedFail.storage.delete).not.toHaveBeenCalled();
  });
});
