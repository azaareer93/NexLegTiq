import type { ClsService } from 'nestjs-cls';

import type { DocumentAccessService } from './document-access.service';
import { DocumentRecordsService, TEXT_PAGE_CHARS } from './document-records.service';
import type { UploadIntake } from './upload/upload-intake';
import type { RequestContext } from '../../common/context/request-context';
import type { StorageService } from '../../common/storage/storage.service';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
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
const BEFORE = { name: 'a.pdf', documentType: 'OTHER', folderId: null, isConfidential: false };

const DEFAULTS = {
  role: 'LAWYER',
  status: 'READY',
  text: null as string | null,
  responsible: 0,
  live: true,
  userId: 'u1',
  officeId: 'o1' as string | null,
};

function setup(options: Partial<typeof DEFAULTS> = {}) {
  const { role, status, text, responsible, live, userId, officeId } = { ...DEFAULTS, ...options };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    document: {
      findFirst: jest.fn().mockResolvedValue(live ? BEFORE : null),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn() },
  };
  const state = { status, currentVersion: 2, ocrStatus: 'DONE' };
  const db = {
    document: {
      findMany: jest.fn().mockResolvedValue([ROW]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn((args: { select: Record<string, unknown> }) =>
        Promise.resolve(live ? ('uploadedBy' in args.select ? ROW : state) : null),
      ),
    },
    documentVersion: {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        storageKey: 'o1/f1/d1/x.pdf',
        originalFilename: 'عقد.pdf',
        mimeType: 'application/pdf',
      }),
    },
    documentText: { findFirst: jest.fn().mockResolvedValue(text === null ? null : { text }) },
    legalFile: { count: jest.fn().mockResolvedValue(responsible) },
    auditLog: { create: jest.fn() },
  };
  const documents = {
    visibleWhere: () => ({ visible: true }),
    assertDocumentAccess: jest
      .fn()
      .mockResolvedValue({ id: 'd1', fileId: 'f1', uploadedById: 'u9' }),
    assertMayReplace: jest.fn().mockResolvedValue(undefined),
  };
  const intake = { recheck: jest.fn().mockResolvedValue(undefined) };
  const storage = { presignedGetUrl: jest.fn().mockResolvedValue('https://s3.test/x') };
  const context: Partial<RequestContext> = {
    officeId: officeId ?? undefined,
    userId,
    role,
  } as never;
  const service = new DocumentRecordsService(
    { get: (key: keyof RequestContext) => context[key] } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    { assertFileAccess: jest.fn() } as unknown as CaseAccessService,
    documents as unknown as DocumentAccessService,
    storage as unknown as StorageService,
    { run: (work: (t: typeof tx) => Promise<unknown>) => work(tx) } as unknown as UnitOfWork,
    intake as unknown as UploadIntake,
  );
  return { service, db, tx, storage, intake };
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

  it('should link only the current version of a scanned-clean document, and audit it', async () => {
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
    await expect(service.download('d1', 2, CLIENT)).resolves.toBeTruthy();
    await expect(service.download('d1', 1, CLIENT)).rejects.toMatchObject({ code: 'RES-001' });
    await expect(
      setup({ status: 'QUARANTINED' }).service.download('d1', undefined, CLIENT),
    ).rejects.toMatchObject({ code: 'STO-004' });
    await expect(
      setup({ status: 'SCANNING' }).service.download('d1', undefined, CLIENT),
    ).rejects.toMatchObject({ code: 'BIZ-015' });
    await expect(
      setup({ live: false }).service.download('d1', undefined, CLIENT),
    ).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should page the text, audit each page and answer empty before extraction', async () => {
    const empty = setup();
    await expect(empty.service.text('d1', 1, CLIENT)).resolves.toMatchObject({
      totalPages: 0,
      text: '',
    });
    expect(empty.db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'VIEW',
        newValues: { versionNumber: 2, text: true, page: 1 },
      }),
    });
    const long = 'x'.repeat(TEXT_PAGE_CHARS) + 'end';
    await expect(setup({ text: long }).service.text('d1', 2, CLIENT)).resolves.toMatchObject({
      page: 2,
      totalPages: 2,
      text: 'end',
    });
    await expect(
      setup({ status: 'QUARANTINED' }).service.text('d1', 1, CLIENT),
    ).rejects.toMatchObject({ code: 'STO-004' });
  });

  it('should re-check under locks, write only changes, and keep classification to who may classify', async () => {
    const { service, tx, intake } = setup();
    await service.update('d1', { name: 'a.pdf' }, CLIENT);
    expect(intake.recheck).toHaveBeenCalledWith(tx, { fileId: 'f1', folderId: undefined });
    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.document.update).not.toHaveBeenCalled();
    await service.update('d1', { name: 'b.pdf', folderId: 'x' }, CLIENT);
    expect(intake.recheck).toHaveBeenLastCalledWith(tx, { fileId: 'f1', folderId: 'x' });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'UPDATE',
        oldValues: { name: 'a.pdf', folderId: null },
        newValues: { name: 'b.pdf', folderId: 'x' },
      }),
    });
    await expect(
      setup().service.update('d1', { isConfidential: true }, CLIENT),
    ).rejects.toMatchObject({ code: 'AUTH-100' });
    await setup({ role: 'OFFICE_MANAGER' }).service.update('d1', { isConfidential: true }, CLIENT);
    await setup({ responsible: 1 }).service.update('d1', { isConfidential: true }, CLIENT);
    await setup({ userId: 'u9' }).service.update('d1', { isConfidential: true }, CLIENT);
    await expect(
      setup({ live: false }).service.update('d1', { name: 'c.pdf' }, CLIENT),
    ).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should soft-delete under locks, read one document, and need an office', async () => {
    const { service, tx } = setup();
    await service.remove('d1', CLIENT);
    expect(tx.document.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { deletedAt: expect.any(Date) },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'DELETE', newValues: { name: 'a.pdf' } }),
    });
    await expect(setup({ live: false }).service.remove('d1', CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(service.get('d1')).resolves.toMatchObject({ id: 'd1', sizeBytes: 10 });
    await expect(setup({ live: false }).service.get('d1')).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(setup({ officeId: null }).service.remove('d1', CLIENT)).rejects.toThrow(
      'No office caller',
    );
  });
});
