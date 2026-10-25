import type { ClsService } from 'nestjs-cls';

import { FileClientsService } from './file-clients.service';
import { FileTeamService } from './file-team.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';
import type { ReminderScheduler } from '../sessions/reminder-scheduler';

const ME = 'manager-1';
const FILE = 'file-1';
const client = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const LOCKED = {
  status: 'OPEN',
  deleted: false,
  fileNumber: '2026-LIT-00001',
  isConfidential: false,
  responsibleLawyerId: 'lawyer-1',
  responsibleParalegalId: 'paralegal-1',
};

interface Options {
  readonly file: object | null;
  readonly user: object | null;
  readonly member: { role: string } | null;
  readonly members: number;
  readonly clients: { clientId: string; isPrimary: boolean }[];
  readonly known: number;
  readonly role: string;
  readonly permissions: string[];
}
const DEFAULTS: Options = {
  file: LOCKED,
  user: { role: 'LAWYER', isActive: true },
  member: null,
  members: 0,
  clients: [],
  known: 1,
  role: 'OFFICE_MANAGER',
  permissions: ['edit:any:case'],
};

function setup(overrides: Partial<Options> = {}) {
  const { file, user, member, members, clients, known, role, permissions } = {
    ...DEFAULTS,
    ...overrides,
  };
  const tx = {
    // Answers by the table the query reads: the user row lock or the file row lock.
    $queryRaw: jest.fn((sql: TemplateStringsArray) =>
      Promise.resolve(
        sql.join('').includes('FROM users') ? (user ? [user] : []) : file ? [file] : [],
      ),
    ),
    client: { count: jest.fn().mockResolvedValue(known) },
    fileClient: {
      count: jest.fn().mockResolvedValue(clients.length ? 1 : 0),
      create: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(clients[0] ?? null),
      findMany: jest.fn().mockResolvedValue(clients),
    },
    fileTeamMember: {
      count: jest.fn().mockResolvedValue(members),
      create: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(member),
      findMany: jest.fn().mockResolvedValue([]),
    },
    legalFile: { update: jest.fn() },
    caseTimelineEvent: { create: jest.fn() },
    notification: { create: jest.fn().mockResolvedValue({ id: 'n1' }) },
  };
  const context: Record<string, unknown> = { userId: ME, officeId: 'office-1', role, permissions };
  const cls = { get: (key: string) => context[key] } as unknown as ClsService<RequestContext>;
  const tasks: (() => unknown)[] = [];
  const uow = {
    run: (work: (t: typeof tx, after: (task: () => unknown) => void) => Promise<unknown>) =>
      work(tx, (task) => tasks.push(task)),
  } as unknown as UnitOfWork;
  const access = { assertFileAccess: jest.fn() } as unknown as CaseAccessService;
  const audit = { log: jest.fn() };
  const reminders = { resetForFile: jest.fn() };
  const realtime = { toUser: jest.fn() };
  const prisma = { db: tx } as unknown as PrismaService;
  const team = new FileTeamService(
    cls,
    prisma,
    uow,
    access,
    audit as unknown as AuditService,
    reminders as unknown as ReminderScheduler,
    realtime as unknown as RealtimePublisher,
  );
  const clients$ = new FileClientsService(
    cls,
    prisma,
    uow,
    access,
    audit as unknown as AuditService,
  );
  const flush = async () => {
    for (const task of tasks) await task();
  };
  return { team, clients: clients$, tx, audit, reminders, realtime, flush, context };
}

describe('FileTeamService (D-140)', () => {
  it('should add a member, record it and notify them after the commit', async () => {
    const { team, tx, audit, realtime, flush } = setup();
    await team.add(FILE, { userId: 'lawyer-2' }, client);
    expect(tx.fileTeamMember.create).toHaveBeenCalledWith({
      data: { officeId: 'office-1', fileId: FILE, userId: 'lawyer-2', role: 'MEMBER' },
    });
    expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'TEAM_MEMBER_ADDED' }) as object,
    });
    expect(audit.log).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'CREATE' }),
      client,
    );
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'file.teamAdded' }) as object,
      }),
    );
    await flush();
    expect(realtime.toUser).toHaveBeenCalledWith('lawyer-2', 'notification', {
      notificationId: 'n1',
    });
  });

  it('should not notify someone who adds themselves', async () => {
    const { team, tx } = setup({ user: { role: 'OFFICE_MANAGER', isActive: true } });
    await team.add(FILE, { userId: ME }, client);
    expect(tx.notification.create).not.toHaveBeenCalled();
  });

  it('should refuse a deleted or archived file, an unknown user, an ineligible role and a duplicate', async () => {
    await expect(
      setup({ file: null }).team.add(FILE, { userId: 'x' }, client),
    ).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(
      setup({ file: { ...LOCKED, deleted: true } }).team.add(FILE, { userId: 'x' }, client),
    ).rejects.toMatchObject({ code: 'RES-001' });
    await expect(
      setup({ file: { ...LOCKED, status: 'ARCHIVED' } }).team.add(FILE, { userId: 'x' }, client),
    ).rejects.toMatchObject({ code: 'BIZ-007' });
    await expect(
      setup({ user: null }).team.add(FILE, { userId: 'x' }, client),
    ).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(
      setup({ user: { role: 'LAWYER', isActive: false } }).team.add(FILE, { userId: 'x' }, client),
    ).rejects.toMatchObject({ code: 'VAL-001' });
    await expect(
      setup().team.add(FILE, { userId: 'x', role: 'PARALEGAL' }, client),
    ).rejects.toMatchObject({ code: 'VAL-001' });
    await expect(
      setup({ members: 1 }).team.add(FILE, { userId: 'x' }, client),
    ).rejects.toMatchObject({
      code: 'RES-002',
    });
  });

  it('should keep confidential files for the office manager and the responsible lawyer to expose', async () => {
    const confidential = { ...LOCKED, isConfidential: true };
    await expect(
      setup({ file: confidential, role: 'PARALEGAL' }).team.add(FILE, { userId: 'x' }, client),
    ).rejects.toMatchObject({ code: 'AUTH-100' });
    const lawyer = setup({ file: { ...confidential, responsibleLawyerId: ME }, role: 'LAWYER' });
    await expect(lawyer.team.add(FILE, { userId: 'x' }, client)).resolves.toEqual([]);
  });

  it('should reassign the file to a new responsible lawyer and reset its reminders', async () => {
    const { team, tx, reminders } = setup({ member: { role: 'MEMBER' } });
    await team.changeRole(FILE, 'lawyer-2', 'RESPONSIBLE_LAWYER', client);
    expect(tx.fileTeamMember.updateMany).toHaveBeenCalledWith({
      where: { fileId: FILE, role: 'RESPONSIBLE_LAWYER' },
      data: { role: 'MEMBER' },
    });
    expect(tx.legalFile.update).toHaveBeenCalledWith({
      where: { id: FILE },
      data: { responsibleLawyerId: 'lawyer-2' },
    });
    expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'FILE_REASSIGNED',
        payload: { fromUserId: 'lawyer-1', toUserId: 'lawyer-2', reason: 'TEAM' },
      }) as object,
    });
    expect(reminders.resetForFile).toHaveBeenCalledWith(tx, expect.any(Function), FILE);
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'file.reassigned' }) as object,
      }),
    );
  });

  it('should need edit:any:case to name a responsible lawyer', async () => {
    const assigned = setup({ member: { role: 'MEMBER' }, permissions: ['edit:assigned:case'] });
    await expect(
      assigned.team.changeRole(FILE, 'lawyer-2', 'RESPONSIBLE_LAWYER', client),
    ).rejects.toMatchObject({ code: 'AUTH-100' });
  });

  it('should keep the responsible lawyer, and clear the paralegal when theirs ends', async () => {
    const lawyer = setup({ member: { role: 'RESPONSIBLE_LAWYER' } });
    await expect(lawyer.team.remove(FILE, 'lawyer-1', client)).rejects.toMatchObject({
      code: 'BIZ-019',
    });
    await expect(
      setup({ member: { role: 'RESPONSIBLE_LAWYER' } }).team.changeRole(
        FILE,
        'lawyer-1',
        'MEMBER',
        client,
      ),
    ).rejects.toMatchObject({ code: 'BIZ-019' });
    const paralegal = setup({ member: { role: 'PARALEGAL' } });
    await paralegal.team.remove(FILE, 'paralegal-1', client);
    expect(paralegal.tx.legalFile.update).toHaveBeenCalledWith({
      where: { id: FILE },
      data: { responsibleParalegalId: null },
    });
    const demoted = setup({
      member: { role: 'PARALEGAL' },
      user: { role: 'PARALEGAL', isActive: true },
    });
    await demoted.team.changeRole(FILE, 'paralegal-1', 'MEMBER', client);
    expect(demoted.tx.legalFile.update).toHaveBeenCalledWith({
      where: { id: FILE },
      data: { responsibleParalegalId: null },
    });
    expect(demoted.tx.fileTeamMember.updateMany).toHaveBeenCalledWith({
      where: { fileId: FILE, userId: 'paralegal-1' },
      data: { role: 'MEMBER' },
    });
  });

  it('should change nothing for the same role, and 404 for someone not on the team', async () => {
    const same = setup({ member: { role: 'MEMBER' } });
    await same.team.changeRole(FILE, 'x', 'MEMBER', client);
    expect(same.audit.log).not.toHaveBeenCalled();
    await expect(setup().team.remove(FILE, 'x', client)).rejects.toMatchObject({ code: 'RES-001' });
  });
});

describe('FileTeamService roles and context (D-140)', () => {
  it('should make a paralegal the responsible paralegal, demoting the previous one', async () => {
    const { team, tx, reminders } = setup({ user: { role: 'PARALEGAL', isActive: true } });
    await team.add(FILE, { userId: 'paralegal-2', role: 'PARALEGAL' }, client);
    expect(tx.fileTeamMember.updateMany).toHaveBeenCalledWith({
      where: { fileId: FILE, role: 'PARALEGAL' },
      data: { role: 'MEMBER' },
    });
    expect(tx.legalFile.update).toHaveBeenCalledWith({
      where: { id: FILE },
      data: { responsibleParalegalId: 'paralegal-2' },
    });
    expect(reminders.resetForFile).not.toHaveBeenCalled();
    expect(tx.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'file.teamAdded' }) as object,
      }),
    );
  });

  it('should treat a caller without permissions as unable to reassign', async () => {
    const bare = setup({ member: { role: 'MEMBER' } });
    delete bare.context['permissions'];
    await expect(
      bare.team.changeRole(FILE, 'lawyer-2', 'RESPONSIBLE_LAWYER', client),
    ).rejects.toMatchObject({ code: 'AUTH-100' });
  });

  it('should fail loudly without an office or a user in the request context', async () => {
    const noOffice = setup();
    delete noOffice.context['officeId'];
    await expect(noOffice.team.add(FILE, { userId: 'x' }, client)).rejects.toThrow('No office');
    await expect(noOffice.clients.add(FILE, { clientId: 'c2' }, client)).rejects.toThrow(
      'No office',
    );
    const noUser = setup({ member: { role: 'MEMBER' } });
    delete noUser.context['userId'];
    await expect(noUser.team.remove(FILE, 'x', client)).rejects.toThrow('No user');
    const noUserClients = setup({
      clients: [
        { clientId: 'c1', isPrimary: true },
        { clientId: 'c2', isPrimary: false },
      ],
    });
    delete noUserClients.context['userId'];
    await expect(noUserClients.clients.remove(FILE, 'c2', client)).rejects.toThrow('No user');
  });
});

describe('review rules (D-140)', () => {
  const confidential = { ...LOCKED, isConfidential: true };

  it('should let only the office manager or the responsible lawyer name a new lawyer of a confidential file', async () => {
    const senior = setup({ file: confidential, member: { role: 'MEMBER' }, role: 'SENIOR_LAWYER' });
    await expect(
      senior.team.changeRole(FILE, ME, 'RESPONSIBLE_LAWYER', client),
    ).rejects.toMatchObject({ code: 'AUTH-100' });
    const manager = setup({ file: confidential, member: { role: 'MEMBER' } });
    await manager.team.changeRole(FILE, 'lawyer-2', 'RESPONSIBLE_LAWYER', client);
    expect(manager.reminders.resetForFile).toHaveBeenCalled();
  });

  it('should let only the office manager or the responsible lawyer add a client to a confidential file', async () => {
    await expect(
      setup({ file: confidential, role: 'PARALEGAL' }).clients.add(
        FILE,
        { clientId: 'c2' },
        client,
      ),
    ).rejects.toMatchObject({ code: 'AUTH-100' });
  });

  it('should demote an inactive member to MEMBER without an eligibility check', async () => {
    const { team, tx } = setup({
      member: { role: 'PARALEGAL' },
      user: { role: 'PARALEGAL', isActive: false },
    });
    await team.changeRole(FILE, 'paralegal-1', 'MEMBER', client);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1); // the file lock only
  });

  it('should leave the file alone when a PARALEGAL row is not its responsible paralegal', async () => {
    const { team, tx } = setup({ member: { role: 'PARALEGAL' } });
    await team.remove(FILE, 'someone-else', client);
    expect(tx.legalFile.update).not.toHaveBeenCalled();
    expect(tx.fileTeamMember.deleteMany).toHaveBeenCalled();
  });
});

describe('FileClientsService (D-140)', () => {
  it('should add a secondary client without touching the primary', async () => {
    const { clients, tx } = setup();
    await clients.add(FILE, { clientId: 'c2' }, client);
    expect(tx.fileClient.updateMany).not.toHaveBeenCalled();
    expect(tx.fileClient.create).toHaveBeenCalledWith({
      data: { officeId: 'office-1', fileId: FILE, clientId: 'c2', isPrimary: false },
    });
  });

  it('should add a client, demoting the primary when the new one is primary', async () => {
    const { clients, tx } = setup();
    await clients.add(FILE, { clientId: 'c2', isPrimary: true }, client);
    expect(tx.fileClient.updateMany).toHaveBeenCalledWith({
      where: { fileId: FILE, isPrimary: true },
      data: { isPrimary: false },
    });
    expect(tx.fileClient.create).toHaveBeenCalledWith({
      data: { officeId: 'office-1', fileId: FILE, clientId: 'c2', isPrimary: true },
    });
    expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ eventType: 'CLIENT_ADDED' }) as object,
    });
  });

  it('should refuse an unknown client and one already on the file', async () => {
    await expect(
      setup({ known: 0 }).clients.add(FILE, { clientId: 'c2' }, client),
    ).rejects.toMatchObject({
      code: 'VAL-001',
    });
    await expect(
      setup({ clients: [{ clientId: 'c2', isPrimary: false }] }).clients.add(
        FILE,
        { clientId: 'c2' },
        client,
      ),
    ).rejects.toMatchObject({ code: 'RES-002' });
  });

  it('should make a client primary once, and 404 one not on the file', async () => {
    const other = setup({ clients: [{ clientId: 'c2', isPrimary: false }] });
    await other.clients.makePrimary(FILE, 'c2', client);
    expect(other.tx.fileClient.updateMany).toHaveBeenLastCalledWith({
      where: { fileId: FILE, clientId: 'c2' },
      data: { isPrimary: true },
    });
    const already = setup({ clients: [{ clientId: 'c2', isPrimary: true }] });
    await already.clients.makePrimary(FILE, 'c2', client);
    expect(already.audit.log).not.toHaveBeenCalled();
    await expect(setup().clients.makePrimary(FILE, 'c9', client)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should keep the last client and promote the oldest when the primary leaves', async () => {
    await expect(
      setup({ clients: [{ clientId: 'c1', isPrimary: true }] }).clients.remove(FILE, 'c1', client),
    ).rejects.toMatchObject({ code: 'BIZ-018' });
    await expect(setup().clients.remove(FILE, 'c9', client)).rejects.toMatchObject({
      code: 'RES-001',
    });
    const two = setup({
      clients: [
        { clientId: 'c1', isPrimary: true },
        { clientId: 'c2', isPrimary: false },
      ],
    });
    await two.clients.remove(FILE, 'c1', client);
    expect(two.tx.fileClient.updateMany).toHaveBeenCalledWith({
      where: { fileId: FILE, clientId: 'c2' },
      data: { isPrimary: true },
    });
    expect(two.audit.log).toHaveBeenCalledWith(
      two.tx,
      expect.objectContaining({ action: 'DELETE', newValues: { promotedClientId: 'c2' } }),
      client,
    );
    const secondary = setup({
      clients: [
        { clientId: 'c1', isPrimary: true },
        { clientId: 'c2', isPrimary: false },
      ],
    });
    await secondary.clients.remove(FILE, 'c2', client);
    expect(secondary.tx.fileClient.updateMany).not.toHaveBeenCalled();
  });

  it('should read the lists through the access check', async () => {
    const { clients, team, tx } = setup();
    tx.fileClient.findMany.mockResolvedValueOnce([
      { isPrimary: true, client: { id: 'c1', displayName: 'A', clientType: 'INDIVIDUAL' } },
    ]);
    await expect(clients.list(FILE)).resolves.toEqual([
      { id: 'c1', displayName: 'A', clientType: 'INDIVIDUAL', isPrimary: true },
    ]);
    tx.fileTeamMember.findMany.mockResolvedValueOnce([
      { role: 'MEMBER', user: { id: 'u2', fullName: 'B' } },
      { role: 'RESPONSIBLE_LAWYER', user: { id: 'u1', fullName: 'C' } },
    ]);
    await expect(team.list(FILE)).resolves.toEqual([
      { id: 'u1', fullName: 'C', role: 'RESPONSIBLE_LAWYER' },
      { id: 'u2', fullName: 'B', role: 'MEMBER' },
    ]);
  });
});
