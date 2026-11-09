import type { ClsService } from 'nestjs-cls';

import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { FieldCipher } from '../../common/crypto/field-cipher';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';

const FILE = '01920000-0000-7000-8000-000000000001';
const NOTE = '01920000-0000-7000-8000-000000000002';
const AUTHOR = '01920000-0000-7000-8000-0000000000a1';

const row = (overrides: object = {}) => ({
  id: NOTE,
  body: 'Text',
  isConfidential: false,
  pinned: false,
  authorId: AUTHOR,
  createdAt: new Date('2026-11-09T08:00:00Z'),
  updatedAt: new Date('2026-11-09T08:00:00Z'),
  author: { id: AUTHOR, fullName: 'Omar' },
  ...overrides,
});

function setup(role: string, userId = AUTHOR, assigned = 1) {
  const db = {
    legalFile: { count: jest.fn().mockResolvedValue(assigned) },
    fileNote: {
      findMany: jest
        .fn()
        .mockResolvedValue([row(), row({ isConfidential: true, body: 'enc:Secret' })]),
      findFirst: jest.fn().mockResolvedValue(row()),
      create: jest.fn().mockImplementation(({ data }) => row(data)),
      update: jest.fn().mockImplementation(({ data }) => row(data)),
      delete: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ status: 'OPEN', deleted: false }]),
  };
  const audit = { log: jest.fn() };
  const context: Partial<Record<keyof RequestContext, unknown>> = { officeId: 'o1', role, userId };
  const cipher = {
    encrypt: (plain: string) => `enc:${plain}`,
    decrypt: (stored: string) => stored.replace(/^enc:/, ''),
  };
  const service = new NotesService(
    { get: (key: keyof RequestContext) => context[key] } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    { run: (work: (tx: typeof db) => unknown) => work(db) } as unknown as UnitOfWork,
    { assertFileAccess: jest.fn() } as unknown as CaseAccessService,
    cipher as unknown as FieldCipher,
    audit as unknown as AuditService,
  );
  return { service, db, audit };
}

describe('NotesService (D-154)', () => {
  it('should decrypt confidential notes for those who may see them and hide them from others', async () => {
    const { service, db } = setup('LAWYER');
    expect((await service.list(FILE)).map((n) => n.body)).toEqual(['Text', 'Secret']);
    const unassigned = setup('SENIOR_LAWYER', 'sl', 0);
    await unassigned.service.list(FILE);
    expect(unassigned.db.fileNote.findMany.mock.calls[0]?.[0].where).toEqual({
      fileId: FILE,
      isConfidential: false,
    });
    expect(db.fileNote.findMany.mock.calls[0]?.[0].where).toEqual({ fileId: FILE });
    // The office manager sees confidential notes without being assigned.
    expect((await setup('OFFICE_MANAGER', 'om', 0).service.list(FILE))[0]?.canEdit).toBe(true);
  });

  it('should encrypt a confidential note and refuse one from someone who may not read them', async () => {
    const { service, db } = setup('LAWYER');
    const note = await service.create(FILE, { body: 'Secret', isConfidential: true });
    expect(db.fileNote.create.mock.calls[0]?.[0].data.body).toBe('enc:Secret');
    expect(note).toMatchObject({ body: 'Secret', isConfidential: true });
    await expect(
      setup('SENIOR_LAWYER', 'sl', 0).service.create(FILE, { body: 'x', isConfidential: true }),
    ).rejects.toMatchObject({ code: 'AUTH-100' });
    await service.create(FILE, { body: 'Plain' });
    expect(db.fileNote.create.mock.calls[1]?.[0].data).toMatchObject({
      body: 'Plain',
      pinned: false,
    });
  });

  it("should change a note for its author or OM/SL, and refuse someone else's", async () => {
    const { service, audit } = setup('LAWYER');
    await expect(service.update(FILE, NOTE, {})).rejects.toMatchObject({ code: 'VAL-001' });
    await service.update(FILE, NOTE, { body: 'New', pinned: true });
    expect(audit.log.mock.calls[0]?.[1].newValues).toMatchObject({
      bodyChanged: true,
      pinned: true,
    });
    await service.update(FILE, NOTE, { isConfidential: true });
    await expect(
      setup('PARALEGAL', 'p').service.update(FILE, NOTE, { pinned: true }),
    ).rejects.toMatchObject({
      code: 'AUTH-100',
    });
    await setup('SENIOR_LAWYER', 'sl').service.remove(FILE, NOTE);
    const missing = setup('LAWYER');
    missing.db.fileNote.findFirst.mockResolvedValueOnce(null);
    await expect(missing.service.remove(FILE, NOTE)).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should refuse to run without a caller', async () => {
    await expect(setup('', '').service.list(FILE)).rejects.toThrow('No office caller');
  });

  it('should hand each route to the service', async () => {
    const notes = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue('created'),
      update: jest.fn().mockResolvedValue('updated'),
      remove: jest.fn(),
    };
    const controller = new NotesController(notes as unknown as NotesService);
    await expect(controller.list(FILE)).resolves.toEqual([]);
    await expect(controller.create(FILE, { body: 'x' })).resolves.toBe('created');
    await expect(controller.update(FILE, NOTE, { pinned: true })).resolves.toBe('updated');
    await controller.remove(FILE, NOTE);
    expect(notes.remove).toHaveBeenCalledWith(FILE, NOTE);
  });
});
