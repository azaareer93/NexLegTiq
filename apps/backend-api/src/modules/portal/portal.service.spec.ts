import { PortalService } from './portal.service';
import type { ClientInfo } from '../../common/context/client-info';
import type { StorageService } from '../../common/storage/storage.service';
import type { TenantRunner } from '../../common/tenancy/tenant-runner';
import type { PrismaService } from '../../database/prisma.service';
import type { ClientUploadIntake } from '../documents/client-upload-intake';
import { discardBody } from '../documents/upload/multipart';
import type { PortalAccounts } from '../portal-auth/portal-accounts';

jest.mock('../documents/upload/multipart', () => ({ discardBody: jest.fn() }));

const NO_CLIENT = { ip: '127.0.0.1', userAgent: null, requestId: null } satisfies ClientInfo;

const A = { officeId: 'o-a', officeName: 'Office A', clientId: 'c-a', clientName: 'Client' };
const B = { officeId: 'o-b', officeName: 'Office B', clientId: 'c-b', clientName: 'Client' };
const when = new Date('2026-12-01T08:00:00Z');
const fileRow = (
  court: { nameAr: string; nameEn: string | null } | null,
  hearing = true,
  id = 'f1',
) => ({
  id,
  fileNumber: '2026/1',
  title: 'Lease',
  status: 'OPEN',
  responsibleLawyer: { fullName: 'Lawyer' },
  sessions: hearing ? [{ startsAt: when, court }] : [],
});

function setup(grants = [A, B]) {
  const office: string[] = [];
  const db = {
    legalFile: { findMany: jest.fn(), findFirst: jest.fn() },
    caseTimelineEvent: { findMany: jest.fn().mockResolvedValue([]) },
    document: { findMany: jest.fn(), findFirst: jest.fn() },
    documentVersion: {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        storageKey: 'k',
        originalFilename: 'a.pdf',
        mimeType: 'application/pdf',
      }),
    },
    auditLog: { create: jest.fn() },
    clientUpload: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const intake = { receive: jest.fn().mockResolvedValue('upload') };
  const tenants = {
    run: jest.fn((ctx: { officeId: string }, work: () => Promise<unknown>) => {
      office.push(ctx.officeId);
      return work();
    }),
  };
  const service = new PortalService(
    { offices: jest.fn().mockResolvedValue(grants) } as unknown as PortalAccounts,
    tenants as unknown as TenantRunner,
    { db } as unknown as PrismaService,
    { presignedGetUrl: jest.fn().mockResolvedValue('https://s3/x') } as unknown as StorageService,
    intake as unknown as ClientUploadIntake,
  );
  return { service, db, office, intake };
}

describe('PortalService (D-186)', () => {
  it('should list each office its files, filtered to the grant client, with the next hearing', async () => {
    const { service, db, office } = setup();
    db.legalFile.findMany
      .mockResolvedValueOnce([fileRow({ nameAr: 'بداية', nameEn: null })])
      .mockResolvedValueOnce([fileRow(null, false, 'f2'), fileRow(null, true, 'f3')]);
    const files = await service.files('u1');
    expect(office).toEqual(['o-a', 'o-b']);
    expect(db.legalFile.findMany.mock.calls[1][0].where).toEqual({
      deletedAt: null,
      clients: { some: { clientId: 'c-b' } },
    });
    expect(files.map((f) => [f.officeName, f.nextHearing])).toEqual([
      ['Office A', { startsAt: when.toISOString(), courtNameAr: 'بداية', courtNameEn: null }],
      ['Office B', null],
      ['Office B', { startsAt: when.toISOString(), courtNameAr: null, courtNameEn: null }],
    ]);
  });

  it('should list a file once when two grants in one office reach it', async () => {
    const { service, db } = setup([A, { ...A, clientId: 'c-a2' }]);
    db.legalFile.findMany.mockResolvedValue([fileRow(null, false)]);
    expect((await service.files('u1')).map((f) => f.id)).toEqual(['f1']);
  });

  it('should open a file in the office whose client it belongs to, with kinds and times only', async () => {
    const { service, db, office } = setup();
    db.legalFile.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(fileRow(null, false));
    db.caseTimelineEvent.findMany.mockResolvedValue([
      { eventType: 'FILE_OPENED', occurredAt: when },
    ]);
    const file = await service.file('u1', 'f1');
    expect(office.at(-1)).toBe('o-b');
    expect(file).toMatchObject({ officeId: 'o-b', timeline: [{ eventType: 'FILE_OPENED' }] });
    expect(db.caseTimelineEvent.findMany.mock.calls[0][0].where.eventType.in).not.toContain(
      'TASK_COMPLETED',
    );
  });

  it('should answer 404 for a file of no grant', async () => {
    const { service, db } = setup();
    db.legalFile.findFirst.mockResolvedValue(null);
    await expect(service.file('u1', 'f1')).rejects.toMatchObject({ code: 'RES-001' });
    await expect(service.documents('u1', 'f1')).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should list only shared, scanned-clean documents', async () => {
    const { service, db } = setup([A]);
    db.legalFile.findFirst.mockResolvedValue(fileRow(null));
    db.document.findMany.mockResolvedValue([
      { id: 'd1', name: 'Lease', mimeType: 'application/pdf', sizeBytes: 10n, createdAt: when },
    ]);
    await expect(service.documents('u1', 'f1')).resolves.toEqual([
      expect.objectContaining({ sizeBytes: '10', createdAt: when.toISOString() }),
    ]);
    expect(db.document.findMany.mock.calls[0][0].where).toMatchObject({
      sharedWithClient: true,
      status: { in: ['PROCESSING', 'READY'] },
    });
  });

  it("should take an upload into the file's office for the grant's client, and drain a refused body", async () => {
    const { service, db, intake, office } = setup();
    db.legalFile.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(fileRow(null, false));
    const req = { readableEnded: false } as never;
    await expect(service.upload('u1', 'f1', req, NO_CLIENT)).resolves.toBe('upload');
    expect(office.at(-1)).toBe('o-b');
    expect(intake.receive).toHaveBeenCalledWith(
      req,
      { fileId: 'f1', clientId: 'c-b', clientUserId: 'u1' },
      NO_CLIENT,
    );
    db.legalFile.findFirst.mockResolvedValue(null);
    await expect(service.upload('u1', 'f1', req, NO_CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
    expect(discardBody).toHaveBeenCalledWith(req);
    intake.receive.mockRejectedValueOnce(new Error('storage down'));
    db.legalFile.findFirst.mockResolvedValue(fileRow(null));
    await expect(service.upload('u1', 'f1', req, NO_CLIENT)).rejects.toThrow('storage down');
    expect(discardBody).toHaveBeenCalledTimes(1);
  });

  it("should list only the grant client's uploads on the file", async () => {
    const { service, db } = setup([A]);
    db.legalFile.findFirst.mockResolvedValue(fileRow(null));
    db.clientUpload.findMany.mockResolvedValue([
      {
        id: 'cu1',
        fileId: 'f1',
        originalFilename: 'a.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 5n,
        status: 'REJECTED',
        rejectionReason: 'Unsigned',
        createdAt: when,
      },
    ]);
    await expect(service.uploads('u1', 'f1')).resolves.toEqual([
      expect.objectContaining({ name: 'a.pdf', sizeBytes: '5', rejectionReason: 'Unsigned' }),
    ]);
    expect(db.clientUpload.findMany.mock.calls[0][0].where).toEqual({
      fileId: 'f1',
      clientId: 'c-a',
    });
  });

  it('should give a link to a shared document and audit it as the portal account', async () => {
    const { service, db } = setup();
    db.document.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ currentVersion: 2 });
    const client = { ip: '1.2.3.4', userAgent: 'ua', requestId: 'r1' };
    await expect(service.download('u1', 'd1', client)).resolves.toEqual({
      downloadUrl: 'https://s3/x',
      expiresIn: expect.any(Number),
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        officeId: 'o-b',
        userId: null,
        clientUserId: 'u1',
        action: 'DOWNLOAD',
      }),
    });
  });

  it('should answer 404 for a document no grant may download', async () => {
    const { service, db } = setup();
    db.document.findFirst.mockResolvedValue(null);
    await expect(service.download('u1', 'd1', NO_CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
