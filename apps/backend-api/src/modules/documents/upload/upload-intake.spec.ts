import { Readable } from 'node:stream';

import type { IncomingFile } from './multipart';
import { UploadIntake } from './upload-intake';
import type { StorageService } from '../../../common/storage/storage.service';
import type { PrismaService } from '../../../database/prisma.service';
import type { CaseAccessService } from '../../legal-files/case-access.service';
import type { EntitlementsService } from '../../subscriptions/entitlements.service';

const FILE = 'f1';

function setup({ folders = 1, sessions = 1 } = {}) {
  const db = {
    documentFolder: { count: jest.fn().mockResolvedValue(folders) },
    session: { count: jest.fn().mockResolvedValue(sessions) },
  };
  const files = { assertFileAccess: jest.fn().mockResolvedValue({ id: FILE }) };
  const entitlements = { assertStorageFor: jest.fn().mockResolvedValue(undefined) };
  const storage = {
    keyFor: jest.fn((...segments: string[]) => ['o', ...segments].join('/')),
    put: jest.fn(async (_key: string, body: Readable) => {
      for await (const chunk of body) void chunk;
    }),
    delete: jest.fn().mockRejectedValue(new Error('gone')),
  };
  const intake = new UploadIntake(
    { db } as unknown as PrismaService,
    files as unknown as CaseAccessService,
    entitlements as unknown as EntitlementsService,
    storage as unknown as StorageService,
  );
  return { intake, files, entitlements, storage };
}

const file = (): IncomingFile => ({
  filename: 'a.pdf',
  stream: Readable.from([Buffer.from('%PDF-1.7')]),
  truncated: () => false,
});

describe('UploadIntake', () => {
  it('should check the file, its folder and hearing, and refuse unknown ones', async () => {
    const { intake, files } = setup();
    await intake.assertTargets({ fileId: FILE, folderId: 'd1', sessionId: 's1' });
    expect(files.assertFileAccess).toHaveBeenCalledWith(FILE, 'contribute');
    await expect(
      setup({ folders: 0 }).intake.assertTargets({ fileId: FILE, folderId: 'x' }),
    ).rejects.toMatchObject({
      details: [{ field: 'folderId', message: 'validation.unknownFolder' }],
    });
    await expect(
      setup({ sessions: 0 }).intake.assertTargets({ fileId: FILE, sessionId: 'x' }),
    ).rejects.toMatchObject({
      details: [{ field: 'sessionId', message: 'validation.unknownSession' }],
    });
  });

  it('should drain the file when a check or a full quota refuses it', async () => {
    const { intake, entitlements } = setup();
    const incoming = file();
    const resume = jest.spyOn(incoming.stream, 'resume');
    await expect(intake.beforeStoring(incoming, () => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(entitlements.assertStorageFor).toHaveBeenCalledWith(1n);
    expect(resume).not.toHaveBeenCalled();
    await expect(
      intake.beforeStoring(incoming, () => Promise.reject(new Error('no'))),
    ).rejects.toThrow('no');
    expect(resume).toHaveBeenCalled();
  });

  it('should store under {officeId}/{fileId}/{documentId}/{uuid}.{ext} and undo it over the quota', async () => {
    const { intake, entitlements, storage } = setup();
    const stored = await intake.store(file(), FILE, 'doc1');
    expect(stored.key).toMatch(/^o\/f1\/doc1\/[0-9a-f-]{36}\.pdf$/);
    expect(entitlements.assertStorageFor).toHaveBeenCalledWith(8n);
    entitlements.assertStorageFor.mockRejectedValueOnce(new Error('AUTH-103'));
    await expect(intake.store(file(), FILE, 'doc1')).rejects.toThrow('AUTH-103');
    expect(storage.delete).toHaveBeenCalled();
  });
});
