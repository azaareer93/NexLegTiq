import type { ClsService } from 'nestjs-cls';

import { applyTaskTemplates, starterTemplates } from './task-templates';
import { TaskTemplatesController, TaskTemplatesService } from './task-templates.service';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';

const ID = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FILE = {
  officeId: 'o1',
  fileId: ID(1),
  fileType: 'LITIGATION' as const,
  openingDate: '2026-12-28',
  responsibleLawyerId: ID(7),
  responsibleParalegalId: null,
  createdById: ID(8),
};

const template = (n: number, extra: object = {}) => ({
  id: ID(n),
  name: `T${n}`,
  fileType: null,
  defaultTitle: `Title ${n}`,
  defaultDescription: null,
  dueDaysAfterOpen: 7,
  defaultAssigneeRole: null,
  isActive: true,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  ...extra,
});

describe('applyTaskTemplates (D-156)', () => {
  it('should make TODO tasks after the column, across a year end, skipping a missing paralegal', async () => {
    const tx = {
      taskTemplate: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            template(1),
            template(2, { defaultAssigneeRole: 'PARALEGAL' }),
            template(3, { dueDaysAfterOpen: null }),
          ]),
      },
      task: {
        aggregate: jest.fn().mockResolvedValue({ _max: { sortOrder: 4 } }),
        createMany: jest.fn(),
      },
    };
    expect(await applyTaskTemplates(tx as never, FILE)).toBe(2);
    expect(tx.task.createMany.mock.calls[0]?.[0].data).toEqual([
      expect.objectContaining({
        title: 'Title 1',
        dueDate: new Date('2027-01-04T00:00:00Z'),
        assignedToId: ID(7),
        sortOrder: 5,
        sourceType: 'TEMPLATE',
        sourceId: ID(1),
      }),
      expect.objectContaining({ title: 'Title 3', dueDate: null, sortOrder: 6 }),
    ]);
    expect(
      await applyTaskTemplates(
        { taskTemplate: { findMany: jest.fn().mockResolvedValue([]) }, task: tx.task } as never,
        FILE,
      ),
    ).toBe(0);
  });

  it('should seed starter templates in the office language', () => {
    expect(starterTemplates('o1', 'EN')[0]).toMatchObject({
      defaultTitle: 'Prepare the statement of claim',
    });
    expect(starterTemplates('o1', 'AR')[0]).toMatchObject({ defaultTitle: 'إعداد لائحة الدعوى' });
    expect(new Set(starterTemplates('o1', 'AR').map((t) => t.fileType))).toEqual(
      new Set(['LITIGATION', 'RENTAL_AGREEMENT']),
    );
  });
});

describe('TaskTemplatesService', () => {
  function setup() {
    const db = {
      taskTemplate: {
        findMany: jest.fn().mockResolvedValue([template(1, { defaultAssigneeRole: 'PARALEGAL' })]),
        findFirst: jest.fn().mockResolvedValue(template(1)),
        create: jest.fn().mockResolvedValue(template(2)),
        update: jest.fn().mockResolvedValue(template(1, { name: 'New' })),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const audit = { log: jest.fn() };
    const service = new TaskTemplatesService(
      { get: () => 'o1' } as unknown as ClsService<RequestContext>,
      { db } as unknown as PrismaService,
      { run: (work: (tx: typeof db) => unknown) => work(db) } as unknown as UnitOfWork,
      audit as unknown as AuditService,
    );
    return { service, db, audit };
  }

  it('should list, create, change and delete templates with audit rows', async () => {
    const { service, db, audit } = setup();
    expect((await service.list())[0]?.defaultAssigneeRole).toBe('PARALEGAL');
    expect((await service.create({ name: 'x', defaultTitle: 'y' })).defaultAssigneeRole).toBe(
      'RESPONSIBLE_LAWYER',
    );
    await expect(service.update(ID(1), {})).rejects.toMatchObject({ code: 'VAL-001' });
    await service.update(ID(1), { name: 'T1' });
    expect(db.taskTemplate.update).not.toHaveBeenCalled();
    expect((await service.update(ID(1), { name: 'New' })).name).toBe('New');
    db.taskTemplate.findFirst.mockResolvedValueOnce(null);
    await expect(service.update(ID(1), { name: 'Z' })).rejects.toMatchObject({ code: 'RES-001' });
    await service.remove(ID(1));
    db.taskTemplate.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.remove(ID(1))).rejects.toMatchObject({ code: 'RES-001' });
    expect(audit.log).toHaveBeenCalledTimes(3);
  });

  it('should hand each route to the service', async () => {
    const templates = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue('c'),
      update: jest.fn().mockResolvedValue('u'),
      remove: jest.fn(),
    };
    const controller = new TaskTemplatesController(templates as unknown as TaskTemplatesService);
    await controller.list();
    await expect(controller.create({ name: 'x', defaultTitle: 'y' })).resolves.toBe('c');
    await expect(controller.update(ID(1), { name: 'z' })).resolves.toBe('u');
    await controller.remove(ID(1));
    expect(templates.remove).toHaveBeenCalledWith(ID(1));
  });
});
