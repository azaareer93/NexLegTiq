import type { ClsService } from 'nestjs-cls';

import { TeamService } from './team.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import type { ReminderScheduler } from '../sessions/reminder-scheduler';
import type { EntitlementsService } from '../subscriptions/entitlements.service';

const ME = 'manager-1';
const client: ClientInfo = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };

const row = (extra: object = {}) => ({
  id: 'user-1',
  fullName: 'Adel',
  email: 'adel@example.test',
  role: 'LAWYER',
  isActive: true,
  lastLoginAt: null,
  _count: { responsibleFiles: 0 },
  ...extra,
});

function setup(
  user = row(),
  { managers = 1, lawyers = ['lawyer-2'], files = [] as object[] } = {},
) {
  const tx = {
    $executeRaw: jest.fn(),
    user: {
      findFirst: jest.fn().mockResolvedValue(user),
      count: jest.fn().mockResolvedValue(managers),
      update: jest.fn(),
      findMany: jest.fn().mockResolvedValue(lawyers.map((id) => ({ id }))),
    },
    legalFile: { findMany: jest.fn().mockResolvedValue(files), update: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
    fileTeamMember: { deleteMany: jest.fn(), upsert: jest.fn() },
    caseTimelineEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    notification: { create: jest.fn() },
    session: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 's1',
          fileId: 'f1',
          startsAt: new Date(),
          attendingLawyerId: 'x',
          reminderDays: [1],
        },
      ]),
    },
  };
  const uow = {
    run: (work: (t: typeof tx, after: () => void) => Promise<unknown>) => work(tx, jest.fn()),
  } as unknown as UnitOfWork;
  const prisma = { db: tx } as unknown as PrismaService;
  const cls = {
    get: (key: string) => ({ userId: ME, officeId: 'office-1' })[key],
  } as unknown as ClsService<RequestContext>;
  const entitlements = { assertUserSlot: jest.fn() };
  const reminders = { reset: jest.fn() };
  const service = new TeamService(
    prisma,
    uow,
    cls,
    entitlements as unknown as EntitlementsService,
    reminders as unknown as ReminderScheduler,
  );
  return { service, tx, entitlements, reminders };
}

describe('TeamService (D-124)', () => {
  it('should leave an unchanged role alone', async () => {
    const { service, tx } = setup();
    await service.changeRole('user-1', 'LAWYER', client);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('should refuse to demote the last office manager (BIZ-001)', async () => {
    const { service } = setup(row({ role: 'OFFICE_MANAGER' }), { managers: 0 });
    await expect(service.changeRole('user-1', 'LAWYER', client)).rejects.toMatchObject({
      code: 'BIZ-001',
    });
  });

  it('should refuse a non-lawyer role to a responsible lawyer of open files', async () => {
    const { service } = setup(row({ _count: { responsibleFiles: 2 } }));
    await expect(service.changeRole('user-1', 'PARALEGAL', client)).rejects.toMatchObject({
      code: 'VAL-001',
    });
  });

  it('should change the role of an inactive user without the open-file rule', async () => {
    const { service, tx } = setup(row({ isActive: false, _count: { responsibleFiles: 2 } }));
    await service.changeRole('user-1', 'PARALEGAL', client);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { role: 'PARALEGAL' },
    });
  });

  it('should answer 404 for an unknown user', async () => {
    const { service, tx } = setup();
    tx.user.findFirst.mockResolvedValue(null);
    await expect(service.openFiles('nobody')).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should do nothing when deactivating an inactive user', async () => {
    const { service, tx } = setup(row({ isActive: false }));
    await service.deactivate('user-1', {}, client);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('should refuse a reassignment list that names a file that is not open', async () => {
    const { service } = setup(row(), { files: [{ id: 'f1', fileNumber: 'N1' }] });
    const reassignments = [
      { fileId: 'f1', newResponsibleLawyerId: 'lawyer-2' },
      { fileId: 'f9', newResponsibleLawyerId: 'lawyer-2' },
    ];
    await expect(service.deactivate('user-1', { reassignments }, client)).rejects.toMatchObject({
      code: 'VAL-001',
    });
  });

  it('should reassign without notifying the manager who takes the file, and reset its reminders', async () => {
    const { service, tx, reminders } = setup(row(), {
      files: [{ id: 'f1', fileNumber: 'N1' }],
      lawyers: [ME],
    });
    await service.deactivate(
      'user-1',
      { reassignments: [{ fileId: 'f1', newResponsibleLawyerId: ME }] },
      client,
    );
    expect(tx.legalFile.update).toHaveBeenCalledWith({
      where: { id: 'f1' },
      data: { responsibleLawyerId: ME },
    });
    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(reminders.reset).toHaveBeenCalledTimes(1);
  });

  it('should reactivate only an inactive user, after the seat check', async () => {
    const active = setup();
    await active.service.reactivate('user-1', client);
    expect(active.entitlements.assertUserSlot).not.toHaveBeenCalled();

    const inactive = setup(row({ isActive: false }));
    await inactive.service.reactivate('user-1', client);
    expect(inactive.entitlements.assertUserSlot).toHaveBeenCalled();
    expect(inactive.tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { isActive: true },
    });
  });

  it('should drop a user whose role the app does not know from the list', async () => {
    const { service, tx } = setup();
    tx.user.findMany.mockResolvedValue([row(), row({ id: 'x', role: 'CEO' })]);
    await expect(service.list()).resolves.toHaveLength(1);
  });

  it('should let a manager step down or leave while another manager remains', async () => {
    const { service, tx } = setup(row({ role: 'OFFICE_MANAGER' }), { managers: 1 });
    await service.changeRole('user-1', 'LAWYER', client);
    await service.deactivate('user-1', {}, client);
    expect(tx.user.update).toHaveBeenCalledTimes(2);
    expect(tx.refreshToken.updateMany).toHaveBeenCalled();
  });

  it('should refuse a new lawyer who is not an active lawyer of the office', async () => {
    const { service } = setup(row(), { files: [{ id: 'f1', fileNumber: 'N1' }], lawyers: [] });
    const reassignments = [{ fileId: 'f1', newResponsibleLawyerId: 'paralegal-1' }];
    await expect(service.deactivate('user-1', { reassignments }, client)).rejects.toMatchObject({
      code: 'VAL-001',
      details: [{ field: 'reassignments.0.newResponsibleLawyerId' }],
    });
  });

  it('should notify a colleague who takes a file', async () => {
    const { service, tx } = setup(row(), { files: [{ id: 'f1', fileNumber: 'N1' }] });
    await service.deactivate(
      'user-1',
      { reassignments: [{ fileId: 'f1', newResponsibleLawyerId: 'lawyer-2' }] },
      client,
    );
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'lawyer-2', link: '/cases/f1' }) as object,
    });
  });

  it('should answer 404 when the user is gone after the change', async () => {
    const { service, tx } = setup();
    tx.user.findFirst.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ role: 'CEO' }));
    await expect(service.changeRole('user-1', 'LAWYER', client)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });
});
