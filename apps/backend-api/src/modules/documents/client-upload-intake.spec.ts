import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import { ClientUploadIntake, MAX_PENDING_CLIENT_BYTES } from './client-upload-intake';
import { readUpload } from './upload/multipart';
import type { UploadIntake } from './upload/upload-intake';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';

jest.mock('./upload/multipart', () => ({ readUpload: jest.fn() }));
const mockedRead = jest.mocked(readUpload);

const NO_CLIENT = { ip: '127.0.0.1', userAgent: null, requestId: null };
const TARGET = { fileId: 'f1', clientId: 'c1', clientUserId: 'cu1' };
const STORED = {
  key: 'o1/f1/u/x.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 10,
  checksumSha256: 'a'.repeat(64),
};

function setup(pending: bigint | null = null, inTransaction = pending) {
  const after: (() => Promise<unknown>)[] = [];
  const tx = {
    $queryRaw: jest.fn(),
    clientUpload: {
      create: jest.fn((args: { data: Record<string, unknown> }) => ({
        ...args.data,
        sizeBytes: 10n,
        status: 'SCANNING',
        rejectionReason: null,
        createdAt: new Date('2026-11-16T10:00:00Z'),
      })),
    },
    auditLog: { create: jest.fn() },
  };
  Object.assign(tx.clientUpload, {
    aggregate: jest.fn().mockResolvedValue({ _sum: { sizeBytes: inTransaction } }),
  });
  const intake = {
    beforeStoring: jest.fn((_file: unknown, checks: () => Promise<unknown>) => checks()),
    store: jest.fn().mockResolvedValue(STORED),
    recheck: jest.fn(),
    discard: jest.fn(),
  };
  const queues = { enqueue: jest.fn() };
  const service = new ClientUploadIntake(
    { get: () => 'o1' } as unknown as ClsService<RequestContext>,
    {
      db: {
        clientUpload: {
          aggregate: jest.fn().mockResolvedValue({ _sum: { sizeBytes: pending } }),
        },
      },
    } as unknown as PrismaService,
    {
      run: async (
        work: (t: typeof tx, a: (f: () => Promise<unknown>) => void) => Promise<unknown>,
      ) => {
        const result = await work(tx, (f) => after.push(f));
        for (const f of after) await f();
        return result;
      },
    } as unknown as UnitOfWork,
    intake as unknown as UploadIntake,
    queues as unknown as QueueProducer,
  );
  mockedRead.mockResolvedValue({
    fields: {},
    file: { filename: 'عقد.pdf', stream: {} as never, truncated: () => false },
  });
  return { service, tx, intake, queues };
}

describe('ClientUploadIntake (D-187)', () => {
  it('should store, record and audit an upload as the portal account, then queue its scan', async () => {
    const { service, tx, intake, queues } = setup();
    const upload = await service.receive({} as Request, TARGET, NO_CLIENT);
    expect(upload).toMatchObject({
      name: 'عقد.pdf',
      status: 'SCANNING',
      sizeBytes: '10',
      fileId: 'f1',
    });
    expect(intake.recheck).toHaveBeenCalledWith(tx, { fileId: 'f1' });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.clientUpload.create.mock.calls[0]?.[0].data).toMatchObject({
      officeId: 'o1',
      ...TARGET,
      storageKey: STORED.key,
    });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      userId: null,
      clientUserId: 'cu1',
      entityType: 'ClientUpload',
      action: 'CREATE',
    });
    expect(queues.enqueue).toHaveBeenCalledWith(
      'ocr',
      'scan-client-upload',
      { uploadId: upload.id },
      { jobId: `scan-upload-${upload.id}` },
    );
  });

  it('should refuse a client over the cap of unreviewed uploads, and remove a stored object that cannot be kept', async () => {
    await expect(
      setup(MAX_PENDING_CLIENT_BYTES).service.receive({} as Request, TARGET, NO_CLIENT),
    ).rejects.toMatchObject({ code: 'BIZ-027' });
    // Room before storing, none once the lock shows another upload landed meanwhile.
    const { service, intake, tx } = setup(null, MAX_PENDING_CLIENT_BYTES - 5n);
    await expect(service.receive({} as Request, TARGET, NO_CLIENT)).rejects.toMatchObject({
      code: 'BIZ-027',
    });
    expect(intake.discard).toHaveBeenCalledWith(STORED.key);
    expect(tx.clientUpload.create).not.toHaveBeenCalled();
  });
});
