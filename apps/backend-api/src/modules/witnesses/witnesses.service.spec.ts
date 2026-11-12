import type { ClsService } from 'nestjs-cls';

import { toStatement, withoutText } from './witnesses.mapper';
import { WitnessesService } from './witnesses.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';
import type { TimelineService } from '../timeline/timeline.service';

const FILE = '01920000-0000-7000-8000-000000000001';
const WITNESS = '01920000-0000-7000-8000-000000000002';
const STATEMENT = '01920000-0000-7000-8000-000000000003';
const SESSION = '01920000-0000-7000-8000-000000000004';
const ME = '01920000-0000-7000-8000-0000000000a1';
const OTHER = '01920000-0000-7000-8000-0000000000a2';
const T = new Date('2026-11-01T08:00:00Z');

const witness = (o: object = {}) => ({
  id: WITNESS,
  fileId: FILE,
  fullName: 'Nour',
  isExpert: false,
  expertiseArea: null,
  phone: null,
  email: null,
  address: null,
  notes: null,
  createdAt: T,
  updatedAt: T,
  _count: { statements: 2 },
  ...o,
});
const statement = (o: object = {}) => ({
  id: STATEMENT,
  witnessId: WITNESS,
  statementDate: new Date('2026-10-30T00:00:00Z'),
  text: 'Saw it',
  isUnderOath: false,
  createdAt: T,
  updatedAt: T,
  recordedBy: { id: ME, fullName: 'Sami' },
  session: null,
  ...o,
});

function setup(
  context: Partial<Record<keyof RequestContext, unknown>> = { userId: ME, officeId: 'o1' },
) {
  const db = {
    witness: {
      findMany: jest.fn().mockResolvedValue([witness()]),
      findFirst: jest.fn().mockResolvedValue(witness()),
      create: jest.fn().mockResolvedValue(witness()),
      update: jest.fn().mockImplementation(({ data }) => witness(data)),
      delete: jest.fn(),
    },
    witnessStatement: {
      findMany: jest.fn().mockResolvedValue([statement()]),
      findFirst: jest.fn().mockResolvedValue(statement()),
      create: jest.fn().mockResolvedValue(statement()),
      update: jest.fn().mockResolvedValue(statement()),
      delete: jest.fn(),
    },
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
    session: { count: jest.fn().mockResolvedValue(1) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([{ status: 'OPEN', deleted: false }]),
  };
  const audit = { log: jest.fn() };
  const timeline = { record: jest.fn() };
  const service = new WitnessesService(
    {
      get: (key: keyof RequestContext) => context[key],
    } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    { run: (work: (tx: typeof db) => unknown) => work(db) } as unknown as UnitOfWork,
    { assertFileAccess: jest.fn() } as unknown as CaseAccessService,
    timeline as unknown as TimelineService,
    audit as unknown as AuditService,
  );
  return { service, db, audit, timeline };
}

describe('WitnessesService (D-163)', () => {
  it('should refuse a write without an office caller', async () => {
    await expect(setup({}).service.create(FILE, { fullName: 'X' })).rejects.toThrow(
      'No office caller',
    );
  });

  it('should list witnesses with their statement count', async () => {
    const [row] = await setup().service.list(FILE);
    expect(row).toMatchObject({ statementCount: 2, createdAt: T.toISOString() });
  });

  it('should refuse an empty change, write nothing when nothing changed, and keep notes out of the audit', async () => {
    const { service, db, audit } = setup();
    await expect(service.update(FILE, WITNESS, {})).rejects.toMatchObject({ code: 'VAL-001' });
    await service.update(FILE, WITNESS, { fullName: 'Nour' });
    expect(db.witness.update).not.toHaveBeenCalled();
    await service.update(FILE, WITNESS, { notes: 'private' });
    expect(audit.log.mock.calls[0]?.[1].newValues).toEqual({ notesChanged: true });
  });

  it('should answer 404 for a witness of another file or a deleted statement', async () => {
    const { service, db } = setup();
    db.witness.findFirst.mockResolvedValue(null);
    await expect(service.remove(FILE, WITNESS)).rejects.toMatchObject({ code: 'RES-001' });
    await expect(service.statements(WITNESS)).rejects.toMatchObject({ code: 'RES-001' });
    const other = setup();
    other.db.witnessStatement.findFirst.mockResolvedValue(null);
    await expect(other.service.removeStatement(WITNESS, STATEMENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should remove a witness and audit its statement count', async () => {
    const { service, audit } = setup();
    await service.remove(FILE, WITNESS);
    expect(audit.log.mock.calls[0]?.[1].oldValues).toMatchObject({ statements: 2 });
  });

  it('should check the date, the hearing and the recorder of a statement', async () => {
    const { service, db } = setup();
    const body = { statementDate: '2026-10-30', text: 'x' };
    await expect(
      service.addStatement(WITNESS, { ...body, statementDate: '2999-01-01' }),
    ).rejects.toMatchObject({ details: [{ message: 'validation.futureDate' }] });
    db.session.count.mockResolvedValueOnce(0);
    await expect(
      service.addStatement(WITNESS, { ...body, sessionId: SESSION }),
    ).rejects.toMatchObject({ details: [{ message: 'validation.unknownSession' }] });
    await expect(
      service.addStatement(WITNESS, { ...body, recordedById: OTHER }),
    ).rejects.toMatchObject({ details: [{ message: 'validation.unknownRecorder' }] });
    await service.addStatement(WITNESS, { ...body, recordedById: ME, sessionId: SESSION });
    expect(db.witnessStatement.create.mock.calls[0]?.[0].data).toMatchObject({
      recordedById: ME,
      sessionId: SESSION,
      isUnderOath: false,
    });
  });

  it('should list statements and record a new one without its text on the timeline', async () => {
    const { service, timeline } = setup();
    expect(await service.statements(WITNESS)).toHaveLength(1);
    await service.addStatement(WITNESS, { statementDate: '2026-10-30', text: 'secret' });
    expect(JSON.stringify(timeline.record.mock.calls[0]?.[1])).not.toContain('secret');
  });

  it('should update only what changed in a statement', async () => {
    const { service, db, audit } = setup();
    await expect(service.updateStatement(WITNESS, STATEMENT, {})).rejects.toMatchObject({
      code: 'VAL-001',
    });
    await service.updateStatement(WITNESS, STATEMENT, { text: 'Saw it' });
    expect(db.witnessStatement.update).not.toHaveBeenCalled();
    await service.updateStatement(WITNESS, STATEMENT, { statementDate: '2026-10-31' });
    expect(db.witnessStatement.update.mock.calls[0]?.[0].data.statementDate).toEqual(
      new Date('2026-10-31T00:00:00Z'),
    );
    await service.updateStatement(WITNESS, STATEMENT, { isUnderOath: true, text: 'new' });
    expect(db.witnessStatement.update.mock.calls[1]?.[0].data).toEqual({
      isUnderOath: true,
      text: 'new',
    });
    expect(audit.log.mock.calls[1]?.[1].newValues).toEqual({
      isUnderOath: true,
      textChanged: true,
    });
  });

  it('should delete a statement', async () => {
    const { service, db } = setup();
    await service.removeStatement(WITNESS, STATEMENT);
    expect(db.witnessStatement.delete).toHaveBeenCalledWith({ where: { id: STATEMENT } });
  });
});

describe('witnesses mapper', () => {
  it('should map a hearing and keep values without text as they are', () => {
    const session = { id: SESSION, startsAt: T };
    expect(toStatement(statement({ session })).session).toEqual({
      id: SESSION,
      startsAt: T.toISOString(),
    });
    expect(withoutText({ a: 1 }, 'text')).toEqual({ a: 1 });
  });
});
