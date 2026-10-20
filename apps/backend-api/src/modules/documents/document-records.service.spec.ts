import type { ClsService } from 'nestjs-cls';

import type { DocumentAccessService } from './document-access.service';
import { DocumentRecordsService, TEXT_PAGE_CHARS } from './document-records.service';
import type { RequestContext } from '../../common/context/request-context';
import type { StorageService } from '../../common/storage/storage.service';
import type { PrismaService } from '../../database/prisma.service';
import type { CaseAccessService } from '../legal-files/case-access.service';

const CLIENT = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const ROW = {
  id: 'd1',
  fileId: 'f1',
  folderId: null,
  sessionId: null,
  name: 'a.pdf',
  originalFilename: 'a.pdf',
  documentType: 'OTHER',
  mimeType: 'application/pdf',
  sizeBytes: 10n,
  currentVersion: 2,
  status: 'READY',
  ocrStatus: 'PENDING',
  isConfidential: false,
  sharedWithClient: false,
  createdAt: new Date('2026-10-20T10:00:00Z'),
  updatedAt: new Date('2026-10-20T10:00:00Z'),
  uploadedBy: { id: 'u9', fullName: 'Uploader' },
};

function setup({
  role = 'LAWYER',
  status = 'READY',
  text = null as string | null,
  responsible = 0,
  updated = 1,
  context = { officeId: 'o1', userId: 'u1' } as Partial<RequestContext>,
} = {}) {
  const tx = {
    document: {
      updateMany: jest.fn().mockResolvedValue({ count: updated }),
      findFirstOrThrow: jest.fn().mockResolvedValue({ name: 'a.pdf' }),
    },
    auditLog: { create: jest.fn() },
  };
  const db = {
    document: {
      findMany: jest.fn().mockResolvedValue([ROW]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn().mockResolvedValue(ROW),
      findFirstOrThrow: jest.fn().mockResolvedValue({
        status,
        currentVersion: 2,
        ocrStatus: 'DONE',
        name: 'a.pdf',
        documentType: 'OTHER',
        folderId: null,
        isConfidential: false,
      }),
    },
    documentVersion: {
      findFirst: jest.fn().mockResolvedValue({
        versionNumber: 2,
        storageKey: 'o1/f1/d1/x.pdf',
        originalFilename: 'عقد.pdf',
        mimeType: 'application/pdf',
      }),
    },
    documentText: { findFirst: jest.fn().mockResolvedValue(text === null ? null : { text }) },
    documentFolder: { count: jest.fn().mockResolvedValue(1) },
    legalFile: { count: jest.fn().mockResolvedValue(responsible) },
    auditLog: { create: jest.fn() },
    $transaction: (work: (t: typeof tx) => Promise<unknown>) => work(tx),
  };
  const files = { assertFileAccess: jest.fn().mockResolvedValue({ id: 'f1' }) };
  const documents = {
    visibleWhere: () => ({ visible: true }),
    assertDocumentAccess: jest
      .fn()
      .mockResolvedValue({ id: 'd1', fileId: 'f1', uploadedById: 'u9' }),
    assertMayReplace: jest.fn().mockResolvedValue(undefined),
  };
  const storage = { presignedGetUrl: jest.fn().mockResolvedValue('https://s3.test/x') };
  const all: Partial<RequestContext> = { ...context, role: role as never };
  const service = new DocumentRecordsService(
    { get: (key: keyof RequestContext) => all[key] } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    files as unknown as CaseAccessService,
    documents as unknown as DocumentAccessService,
    storage as unknown as StorageService,
  );
  return { service, db, tx, files, storage };
}

const QUERY = {
  sort: [{ field: 'updatedAt' as const, direction: 'desc' as const }],
  page: 2,
  limit: 10,
};

describe('DocumentRecordsService', () => {
  it('should list with filters and present numbers and dates', async () => {
    const { service, db } = setup();
    const page = await service.list('f1', {
      ...QUERY,
      folderId: 'root',
      documentType: 'PLEADING',
      status: 'READY',
      search: 'عقد',
    });
    expect(page.items[0]).toMatchObject({ sizeBytes: 10, createdAt: '2026-10-20T10:00:00.000Z' });
    expect(page.pagination).toMatchObject({ page: 2, total: 1 });
    expect(db.document.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      }),
    );
    await service.list('f1', { ...QUERY, folderId: '01920000-0000-7000-8000-000000000001' });
  });

  it('should offer a link only for scanned-clean documents and audit it', async () => {
    const { service, storage, db } = setup();
    await expect(service.download('d1', undefined, CLIENT)).resolves.toEqual({
      downloadUrl: 'https://s3.test/x',
      expiresIn: 300,
    });
    expect(storage.presignedGetUrl).toHaveBeenCalledWith('o1/f1/d1/x.pdf', {
      expiresIn: 300,
      filename: 'عقد.pdf',
      contentType: 'application/pdf',
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'DOWNLOAD', newValues: { versionNumber: 2 } }),
    });
    await expect(
      setup({ status: 'QUARANTINED' }).service.download('d1', 1, CLIENT),
    ).rejects.toMatchObject({ code: 'STO-004' });
    await expect(
      setup({ status: 'SCANNING' }).service.download('d1', 1, CLIENT),
    ).rejects.toMatchObject({ code: 'BIZ-015' });
    const missing = setup();
    missing.db.documentVersion.findFirst.mockResolvedValue(null);
    await expect(missing.service.download('d1', 9, CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should page the text and answer empty before extraction', async () => {
    await expect(setup().service.text('d1', 1)).resolves.toMatchObject({ totalPages: 0, text: '' });
    const long = 'x'.repeat(TEXT_PAGE_CHARS) + 'end';
    await expect(setup({ text: long }).service.text('d1', 2)).resolves.toMatchObject({
      page: 2,
      totalPages: 2,
      text: 'end',
    });
  });

  it('should write only changes, and let only who may classify change confidentiality', async () => {
    const { service, tx } = setup();
    await service.update('d1', { name: 'a.pdf' }, CLIENT);
    expect(tx.document.updateMany).not.toHaveBeenCalled();
    await service.update('d1', { name: 'b.pdf', folderId: 'x' }, CLIENT);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE',
        newValues: { name: 'b.pdf', folderId: 'x' },
      }),
    });
    await expect(
      setup().service.update('d1', { isConfidential: true }, CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH-100' });
    await setup({ role: 'OFFICE_MANAGER' }).service.update('d1', { isConfidential: true }, CLIENT);
    await setup({ responsible: 1 }).service.update('d1', { isConfidential: true }, CLIENT);
    await setup({ context: { officeId: 'o1', userId: 'u9' } }).service.update(
      'd1',
      { isConfidential: true },
      CLIENT,
    );
    const unknown = setup();
    unknown.db.documentFolder.count.mockResolvedValue(0);
    await expect(unknown.service.update('d1', { folderId: 'y' }, CLIENT)).rejects.toMatchObject({
      code: 'VAL-001',
    });
    await expect(
      setup({ updated: 0 }).service.update('d1', { name: 'c.pdf' }, CLIENT),
    ).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should soft-delete once, read one document, and need a caller', async () => {
    const { service, tx } = setup();
    await service.remove('d1', CLIENT);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'DELETE', newValues: { name: 'a.pdf' } }),
    });
    await expect(setup({ updated: 0 }).service.remove('d1', CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(service.get('d1')).resolves.toMatchObject({ id: 'd1', sizeBytes: 10 });
    const gone = setup();
    gone.db.document.findFirst.mockResolvedValue(null);
    await expect(gone.service.get('d1')).rejects.toMatchObject({ code: 'RES-001' });
    await expect(setup({ context: {} }).service.remove('d1', CLIENT)).rejects.toThrow(
      'No office caller',
    );
  });
});
