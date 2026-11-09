import type { ClsService } from 'nestjs-cls';

import { FileLifecycleService } from './file-lifecycle.service';
import type { FileTeamService } from './file-team.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';
import type { ReminderScheduler } from '../sessions/reminder-scheduler';
import type { TimelineService } from '../timeline/timeline.service';

const FILE = '01920000-0000-7000-8000-000000000001';
const LAWYER = '01920000-0000-7000-8000-0000000000a1';
const CLIENT = { ip: '127.0.0.1', userAgent: null, requestId: null };

function setup(role: string, userId = LAWYER, status = 'OPEN', openTasks = 0) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([
      {
        status,
        deleted: false,
        fileNumber: 'F-1',
        isConfidential: false,
        responsibleLawyerId: LAWYER,
      },
    ]),
    legalFile: { findUniqueOrThrow: jest.fn().mockResolvedValue({ status }), update: jest.fn() },
    task: { count: jest.fn().mockResolvedValue(openTasks) },
  };
  const db = {
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
    fileTeamMember: { count: jest.fn().mockResolvedValue(0) },
  };
  const reminders = { cancelForFile: jest.fn(), resetForFile: jest.fn() };
  const timeline = { record: jest.fn() };
  const team = {
    add: jest.fn().mockResolvedValue([]),
    changeRole: jest.fn().mockResolvedValue([]),
  };
  const context: Partial<RequestContext> = {
    officeId: 'o1' as never,
    role: role as never,
    userId: userId as never,
  };
  const service = new FileLifecycleService(
    { get: (key: keyof RequestContext) => context[key] } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    {
      run: (work: (t: typeof tx, after: () => void) => unknown) => work(tx, () => undefined),
    } as unknown as UnitOfWork,
    { assertFileAccess: jest.fn() } as unknown as CaseAccessService,
    reminders as unknown as ReminderScheduler,
    timeline as unknown as TimelineService,
    { log: jest.fn() } as unknown as AuditService,
    team as unknown as FileTeamService,
  );
  return { service, tx, db, reminders, timeline, team };
}

describe('FileLifecycleService (D-153)', () => {
  it('should close for the responsible lawyer, ending reminders, and record a forced close', async () => {
    const { service, tx, reminders, timeline } = setup('LAWYER', LAWYER, 'OPEN', 2);
    await expect(service.close(FILE, { force: false }, CLIENT)).rejects.toMatchObject({
      code: 'BIZ-003',
    });
    await service.close(FILE, { force: true, forceReason: ' Withdrawn ', reason: '' }, CLIENT);
    expect(tx.legalFile.update.mock.calls[0]?.[0].data.status).toBe('CLOSED');
    expect(reminders.cancelForFile).toHaveBeenCalled();
    expect(timeline.record.mock.calls[0]?.[1].payload).toEqual({
      forceReason: 'Withdrawn',
      openTasks: 2,
    });
  });

  it("should refuse another lawyer's close and a second close", async () => {
    await expect(
      setup('LAWYER', 'someone').service.close(FILE, { force: false }, CLIENT),
    ).rejects.toMatchObject({
      code: 'AUTH-100',
    });
    await expect(
      setup('OFFICE_MANAGER', 'om', 'CLOSED').service.close(FILE, { force: false }, CLIENT),
    ).rejects.toMatchObject({
      code: 'BIZ-002',
    });
  });

  it('should reopen and archive only closed files, archiving for OM/SL', async () => {
    await expect(
      setup('OFFICE_MANAGER', 'om', 'OPEN').service.reopen(FILE, CLIENT),
    ).rejects.toMatchObject({
      code: 'RES-003',
    });
    const { service, reminders } = setup('SENIOR_LAWYER', 'sl', 'CLOSED');
    await service.reopen(FILE, CLIENT);
    expect(reminders.resetForFile).toHaveBeenCalled();
    await service.archive(FILE, CLIENT);
    await expect(
      setup('LAWYER', LAWYER, 'CLOSED').service.archive(FILE, CLIENT),
    ).rejects.toMatchObject({
      code: 'AUTH-100',
    });
    await expect(
      setup('OFFICE_MANAGER', 'om', 'OPEN').service.archive(FILE, CLIENT),
    ).rejects.toMatchObject({
      code: 'RES-003',
    });
  });

  it('should reassign through the team: adding a newcomer, promoting a member', async () => {
    const { service, db, team } = setup('OFFICE_MANAGER', 'om');
    await service.reassign(FILE, { newResponsibleLawyerId: LAWYER, note: 'Leave' }, CLIENT);
    expect(team.add).toHaveBeenCalledWith(
      FILE,
      { userId: LAWYER, role: 'RESPONSIBLE_LAWYER' },
      CLIENT,
      { note: 'Leave' },
    );
    db.fileTeamMember.count.mockResolvedValueOnce(1);
    await service.reassign(FILE, { newResponsibleLawyerId: LAWYER }, CLIENT);
    expect(team.changeRole).toHaveBeenCalledWith(FILE, LAWYER, 'RESPONSIBLE_LAWYER', CLIENT, {
      note: undefined,
    });
  });
});
