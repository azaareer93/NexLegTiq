import type { Role } from '@nexlegtiq/shared-types';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import { assertAssignable, TaskAccessService } from './task-access.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { CaseAccessService } from '../legal-files/case-access.service';

const USER = '01920000-0000-7000-8000-000000000001';
const OTHER = '01920000-0000-7000-8000-000000000002';
const FILE = '01920000-0000-7000-8000-0000000000f1';
const TASK = '01920000-0000-7000-8000-0000000000t1';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: TASK,
  fileId: FILE,
  title: 'Draft',
  status: 'TODO',
  assignedToId: USER,
  file: { status: 'OPEN' },
  ...overrides,
});

function setup(role: Role | null = 'LAWYER', tasks: unknown[] = [row()]) {
  const store: Partial<RequestContext> = {
    userId: role ? (USER as never) : undefined,
    role: role ?? undefined,
    permissions: role ? permissionsFor(role) : undefined,
  };
  const cls = {
    get: (key: keyof RequestContext) => store[key],
  } as unknown as ClsService<RequestContext>;
  const task = {
    findFirst: jest.fn().mockResolvedValue(tasks[0] ?? null),
    findMany: jest.fn().mockResolvedValue(tasks),
  };
  const prisma = { db: { task } } as unknown as PrismaService;
  const files = {
    visibleWhere: jest.fn().mockReturnValue({ deletedAt: null }),
    assertFileAccess: jest.fn().mockResolvedValue({ id: FILE }),
  } as unknown as CaseAccessService;
  return { access: new TaskAccessService(cls, prisma, files), task, files };
}

describe('TaskAccessService', () => {
  it("should see tasks of visible files and the caller's personal tasks", () => {
    expect(setup().access.visibleWhere()).toEqual({
      OR: [
        { file: { is: { deletedAt: null } } },
        { fileId: null, OR: [{ createdById: USER }, { assignedToId: USER }] },
      ],
    });
  });

  it('should 404 a task the caller cannot see', async () => {
    await expect(setup('LAWYER', []).access.find(TASK)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it("should check write access to the task's file when editing, but not for a personal task", async () => {
    const { access, files } = setup();
    await access.findFor(TASK, 'edit');
    expect(files.assertFileAccess).toHaveBeenCalledWith(FILE, 'write');
    const personal = setup('LAWYER', [row({ fileId: null, file: null })]);
    await personal.access.findFor(TASK, 'edit');
    expect(personal.files.assertFileAccess).not.toHaveBeenCalled();
  });

  it('should refuse any change to a task on an archived file (BIZ-007)', async () => {
    const { access } = setup('TRAINEE', [row({ file: { status: 'ARCHIVED' } })]);
    await expect(access.findFor(TASK, 'status')).rejects.toBeInstanceOf(BusinessRuleException);
  });

  it("should let an external collaborator move only tasks assigned to them, and a trainee anyone's", async () => {
    await expect(
      setup('EXTERNAL_COLLABORATOR').access.findFor(TASK, 'status'),
    ).resolves.toMatchObject({ id: TASK });
    const notTheirs = [row({ assignedToId: OTHER })];
    await expect(
      setup('EXTERNAL_COLLABORATOR', notTheirs).access.findFor(TASK, 'status'),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    await expect(setup('TRAINEE', notTheirs).access.findFor(TASK, 'status')).resolves.toBeDefined();
  });

  it('should require every task of a batch to be visible, and write access to each of their files once', async () => {
    const { access, files } = setup('LAWYER', [
      row(),
      row({ id: 'b' }),
      row({ id: 'c', fileId: null }),
    ]);
    await access.findAllFor([TASK, 'b', 'c']);
    expect(files.assertFileAccess).toHaveBeenCalledTimes(1);
    await expect(access.findAllFor([TASK, 'b', 'c', 'd'])).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('should fail loudly without a caller (programming error, not a 403)', () => {
    expect(() => setup(null).access.visibleWhere()).toThrow('No caller');
  });
});

describe('assertAssignable', () => {
  function tx(user: { id: string; role: Role } | null, visibleFiles = 1) {
    return {
      user: { findFirst: jest.fn().mockResolvedValue(user) },
      legalFile: { count: jest.fn().mockResolvedValue(visibleFiles) },
    };
  }
  const check = (t: ReturnType<typeof tx>, fileId: string | null = FILE) =>
    assertAssignable(t as unknown as ScopedTransaction, OTHER, fileId);

  it('should accept an active colleague who can see the file', async () => {
    await expect(check(tx({ id: OTHER, role: 'PARALEGAL' }))).resolves.toBeUndefined();
  });

  it('should check the file with the assignee’s own scope', async () => {
    const t = tx({ id: OTHER, role: 'LAWYER' });
    await check(t);
    expect(t.legalFile.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: FILE, deletedAt: null, OR: expect.any(Array) }),
    });
  });

  it.each([
    ['an unknown or inactive user', tx(null)],
    ['admin staff (cannot work on tasks)', tx({ id: OTHER, role: 'ADMIN' })],
    ['someone who cannot see the file', tx({ id: OTHER, role: 'LAWYER' }, 0)],
  ])('should refuse %s with VAL-001 on assignedToId', async (_name, t) => {
    await expect(check(t)).rejects.toBeInstanceOf(ValidationException);
  });

  it('should not look at files for a personal task', async () => {
    const t = tx({ id: OTHER, role: 'TRAINEE' });
    await check(t, null);
    expect(t.legalFile.count).not.toHaveBeenCalled();
  });
});
