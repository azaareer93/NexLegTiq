import { CreateTaskSchema, TaskQuerySchema } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import type { TaskAccessService } from './task-access.service';
import type { TasksRepository } from './tasks.repository';
import { TasksService } from './tasks.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  PermissionDeniedException,
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';

const OFFICE = '01920000-0000-7000-8000-0000000000aa';
const ME = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';
const FILE = '01920000-0000-7000-8000-0000000000f1';
const TASK = '01920000-0000-7000-8000-0000000000a1';
const CLIENT = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };

const accessRow = (overrides: Record<string, unknown> = {}) => ({
  id: TASK,
  fileId: FILE,
  title: 'Draft',
  status: 'TODO',
  assignedToId: ME,
  file: { status: 'OPEN' },
  ...overrides,
});

function setup(role: Role = 'LAWYER', row = accessRow()) {
  const context: Partial<RequestContext> = {
    officeId: OFFICE as never,
    userId: ME as never,
    role,
    permissions: permissionsFor(role),
  };
  const tx = {
    user: { findFirst: jest.fn().mockResolvedValue({ id: OTHER, role: 'PARALEGAL' }) },
    legalFile: { count: jest.fn().mockResolvedValue(1) },
    task: {
      aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 4 } }),
      create: jest.fn().mockResolvedValue({ id: TASK }),
      findFirst: jest.fn().mockResolvedValue({
        title: 'Draft',
        description: 'x',
        dueDate: new Date('2026-11-02T00:00:00Z'),
        priority: 'MEDIUM',
        assignedToId: ME,
      }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    caseTimelineEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    notification: { create: jest.fn() },
  };
  const uow = {
    run: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
  } as unknown as UnitOfWork;
  const cls = {
    get: (key: keyof RequestContext) => context[key],
  } as unknown as ClsService<RequestContext>;
  const prisma = {
    db: { office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) } },
  } as unknown as PrismaService;
  const files = {
    assertFileAccess: jest.fn().mockResolvedValue({ id: FILE }),
  } as unknown as CaseAccessService;
  const access = {
    actorId: () => ME,
    visibleWhere: () => ({ visible: true }),
    find: jest.fn().mockResolvedValue(row),
    findFor: jest.fn().mockResolvedValue(row),
    findAllFor: jest.fn().mockResolvedValue([row]),
  } as unknown as TaskAccessService;
  const tasks = {
    get: jest.fn().mockResolvedValue({ id: TASK }),
    list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  } as unknown as TasksRepository;
  return {
    service: new TasksService(cls, uow, prisma, files, access, tasks),
    tx,
    files,
    tasks,
    context,
  };
}

describe('TasksService', () => {
  describe('create', () => {
    it('should create a task last in TODO, check the file and the assignee, audit and notify', async () => {
      const { service, tx, files } = setup();
      await service.create(
        CreateTaskSchema.parse({
          title: 'Draft',
          fileId: FILE,
          assignedToId: OTHER,
          dueDate: '2026-11-02',
        }),
        CLIENT,
      );
      expect(files.assertFileAccess).toHaveBeenCalledWith(FILE, 'write');
      expect(tx.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          officeId: OFFICE,
          fileId: FILE,
          description: null,
          dueDate: new Date('2026-11-02T00:00:00Z'),
          assignedToId: OTHER,
          createdById: ME,
          sortOrder: 5,
        }),
        select: { id: true },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ entityType: 'Task', action: 'CREATE' }),
      });
      expect(tx.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: OTHER, type: 'task.assigned' }),
      });
    });

    it('should make a personal task the creator’s by default, first in an empty column, without notifying', async () => {
      const { service, tx, files } = setup();
      tx.task.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      tx.user.findFirst.mockResolvedValue({ id: ME, role: 'LAWYER' });
      await service.create(CreateTaskSchema.parse({ title: 'Renew bar card' }), CLIENT);
      expect(files.assertFileAccess).not.toHaveBeenCalled();
      expect(tx.task.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fileId: null,
          dueDate: null,
          assignedToId: ME,
          sortOrder: 0,
        }),
        select: { id: true },
      });
      expect(tx.legalFile.count).not.toHaveBeenCalled();
      expect(tx.notification.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('should combine visibility and filters; assignee=me is the caller', async () => {
      const { service, tasks } = setup();
      await service.list(
        TaskQuerySchema.parse({
          fileId: FILE,
          assignee: 'me',
          status: 'TODO',
          priority: 'HIGH',
          dueBefore: '2026-11-30',
        }),
      );
      expect(tasks.list).toHaveBeenCalledWith(
        { visible: true },
        {
          fileId: FILE,
          assignedToId: ME,
          status: 'TODO',
          priority: 'HIGH',
          dueDate: { lte: new Date('2026-11-30T00:00:00Z') },
        },
        expect.objectContaining({ page: 1, limit: 20 }),
      );
    });

    it("should judge overdue against today in the office's time zone, and negate it for overdue=false", async () => {
      const { service, tasks } = setup();
      await service.list(TaskQuerySchema.parse({ overdue: 'true', assignee: OTHER }));
      const [, overdue] = (tasks.list as jest.Mock).mock.calls[0] as [unknown, { AND: unknown[] }];
      expect(overdue).toMatchObject({
        assignedToId: OTHER,
        AND: [{ status: { not: 'DONE' }, dueDate: { lt: expect.any(Date) } }],
      });
      await service.list(TaskQuerySchema.parse({ overdue: 'false' }));
      const [, notOverdue] = (tasks.list as jest.Mock).mock.calls[1] as [
        unknown,
        { AND: unknown[] },
      ];
      expect(notOverdue.AND).toEqual([
        { OR: [{ status: 'DONE' }, { dueDate: null }, { dueDate: { gte: expect.any(Date) } }] },
      ]);
    });
  });

  it('should check visibility before reading one task', async () => {
    const { service, tasks } = setup();
    await expect(service.get(TASK)).resolves.toEqual({ id: TASK });
    expect(tasks.get).toHaveBeenCalledWith(TASK);
  });

  describe('update', () => {
    it('should write and audit only changed fields, convert dates and notify a new assignee', async () => {
      const { service, tx } = setup();
      await service.update(
        TASK,
        { title: 'Draft', description: '', dueDate: '2026-12-01', assignedToId: OTHER },
        CLIENT,
      );
      expect(tx.task.update).toHaveBeenCalledWith({
        where: { id: TASK },
        data: { description: null, assignedToId: OTHER, dueDate: new Date('2026-12-01T00:00:00Z') },
      });
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          oldValues: { description: 'x', dueDate: '2026-11-02', assignedToId: ME },
          newValues: { description: null, dueDate: '2026-12-01', assignedToId: OTHER },
        }),
      });
      expect(tx.notification.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: OTHER, params: { taskId: TASK, title: 'Draft' } }),
      });
    });

    it('should clear a due date and write nothing when nothing changes', async () => {
      const { service, tx } = setup();
      await service.update(TASK, { dueDate: null }, CLIENT);
      expect(tx.task.update).toHaveBeenCalledWith({ where: { id: TASK }, data: { dueDate: null } });
      tx.task.update.mockClear();
      await service.update(TASK, { title: 'Draft', priority: 'MEDIUM' }, CLIENT);
      expect(tx.task.update).not.toHaveBeenCalled();
      expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    });

    it('should 404 a task deleted meanwhile, and refuse a reassignment without assign:task', async () => {
      const gone = setup();
      gone.tx.task.findFirst.mockResolvedValue(null);
      await expect(gone.service.update(TASK, { title: 'x' }, CLIENT)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
      const noAssign = setup();
      noAssign.context.permissions = ['create:task'];
      await expect(
        noAssign.service.update(TASK, { assignedToId: OTHER }, CLIENT),
      ).rejects.toBeInstanceOf(PermissionDeniedException);
    });

    it('should refuse an assignee who cannot work on the file', async () => {
      const { service, tx } = setup();
      tx.legalFile.count.mockResolvedValue(0);
      await expect(service.update(TASK, { assignedToId: OTHER }, CLIENT)).rejects.toBeInstanceOf(
        ValidationException,
      );
    });
  });

  describe('changeStatus', () => {
    it('should complete a file task: completedAt, TASK_COMPLETED event and audit', async () => {
      const { service, tx } = setup();
      await service.changeStatus(TASK, { status: 'DONE' }, CLIENT);
      expect(tx.task.updateMany).toHaveBeenCalledWith({
        where: { id: TASK, status: 'TODO' },
        data: { status: 'DONE', completedAt: expect.any(Date) },
      });
      expect(tx.caseTimelineEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          fileId: FILE,
          eventType: 'TASK_COMPLETED',
          sourceType: 'Task',
          sourceId: TASK,
          actorId: ME,
        }),
      });
    });

    it('should clear completedAt when leaving DONE, add no event for a personal task, and skip a no-op move', async () => {
      const { service, tx } = setup(
        'LAWYER',
        accessRow({ status: 'DONE', fileId: null, file: null }),
      );
      await service.changeStatus(TASK, { status: 'TODO' }, CLIENT);
      expect(tx.task.updateMany).toHaveBeenCalledWith({
        where: { id: TASK, status: 'DONE' },
        data: { status: 'TODO', completedAt: null },
      });
      expect(tx.caseTimelineEvent.create).not.toHaveBeenCalled();
      const personal = setup('LAWYER', accessRow({ fileId: null, file: null }));
      await personal.service.changeStatus(TASK, { status: 'DONE' }, CLIENT);
      expect(personal.tx.task.updateMany).toHaveBeenCalled();
      expect(personal.tx.caseTimelineEvent.create).not.toHaveBeenCalled();
      const same = setup();
      await same.service.changeStatus(TASK, { status: 'TODO' }, CLIENT);
      expect(same.tx.task.updateMany).not.toHaveBeenCalled();
    });

    it('should report a concurrent move as 409 RES-003', async () => {
      const { service, tx } = setup();
      tx.task.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.changeStatus(TASK, { status: 'DONE' }, CLIENT)).rejects.toBeInstanceOf(
        ResourceConflictException,
      );
    });
  });

  it('should delete and audit a task, or 404 when it is already gone', async () => {
    const { service, tx } = setup();
    await service.remove(TASK, CLIENT);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DELETE',
        oldValues: { title: 'Draft', fileId: FILE },
      }),
    });
    tx.task.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.remove(TASK, CLIENT)).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('should number a column in the order sent, and refuse a task of another column', async () => {
    const { service, tx } = setup();
    await service.reorder({ status: 'TODO', taskIds: [TASK] });
    expect(tx.task.updateMany).toHaveBeenCalledWith({
      where: { id: TASK },
      data: { sortOrder: 0 },
    });
    await expect(service.reorder({ status: 'DONE', taskIds: [TASK] })).rejects.toBeInstanceOf(
      ValidationException,
    );
  });

  it('should bulk-assign only tasks that change hands, audited and notified', async () => {
    const { service, tx } = setup();
    await expect(
      service.bulkAssign({ taskIds: [TASK], assignedToId: OTHER }, CLIENT),
    ).resolves.toEqual({ updated: 1 });
    expect(tx.task.update).toHaveBeenCalledWith({
      where: { id: TASK },
      data: { assignedToId: OTHER },
    });
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    tx.user.findFirst.mockResolvedValue({ id: ME, role: 'LAWYER' });
    await expect(
      service.bulkAssign({ taskIds: [TASK], assignedToId: ME }, CLIENT),
    ).resolves.toEqual({
      updated: 0,
    });
  });

  it('should fail loudly without an office in the context', async () => {
    const { service, context } = setup();
    context.officeId = undefined;
    await expect(service.remove(TASK, CLIENT)).rejects.toThrow('No office');
  });
});
