import { Injectable } from '@nestjs/common';
import { conditionFor, permissionsFor } from '@nexlegtiq/shared-types';
import type { Role, UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { caseScope, caseScopeWhere } from '../../common/rbac/case-scope';
import { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import { CaseAccessService } from '../legal-files/case-access.service';

/** What a route does to a task: edit it (create:task holders) or move it between columns (complete:task). */
export type TaskMode = 'edit' | 'status';

const ACCESS_SELECT = {
  id: true,
  fileId: true,
  title: true,
  status: true,
  assignedToId: true,
  file: { select: { status: true } },
} satisfies Prisma.TaskSelect;
export type TaskAccessRow = Prisma.TaskGetPayload<{ select: typeof ACCESS_SELECT }>;

/**
 * Which tasks the caller may see and change (D-098). A task on a file follows the file (CaseAccessService, D-096):
 * visible when the file is, editable when the file is, read-only once it is archived (BIZ-007). A personal task (no
 * file) is seen and edited by its creator and assignee only. Anything else is 404 RES-001 (D-019).
 */
@Injectable()
export class TaskAccessService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
  ) {}

  /** Tasks on a visible file, plus the caller's personal tasks (created by or assigned to them). */
  visibleWhere(): Prisma.TaskWhereInput {
    const me = this.actorId();
    return {
      OR: [
        { file: { is: this.files.visibleWhere() } },
        { fileId: null, OR: [{ createdById: me }, { assignedToId: me }] },
      ],
    };
  }

  async find(id: string): Promise<TaskAccessRow> {
    const task = await this.prisma.db.task.findFirst({
      where: { AND: [{ id }, this.visibleWhere()] },
      select: ACCESS_SELECT,
    });
    if (!task) throw new ResourceNotFoundException();
    return task;
  }

  /**
   * The task if the caller may act on it. Editing a file's task needs write access to the file (404 otherwise); any
   * change to a task on an archived file is BIZ-007; an external collaborator moves only their own tasks (403).
   */
  async findFor(id: string, mode: TaskMode): Promise<TaskAccessRow> {
    const task = await this.find(id);
    if (mode === 'edit' && task.fileId) await this.files.assertFileAccess(task.fileId, 'write');
    if (task.file?.status === 'ARCHIVED') {
      throw new BusinessRuleException('BIZ-007', 'The file is archived and read-only');
    }
    if (
      mode === 'status' &&
      conditionFor(this.role(), 'complete:task') === 'OWN' &&
      task.assignedToId !== this.actorId()
    ) {
      throw new PermissionDeniedException();
    }
    return task;
  }

  /** Every task for editing; one the caller cannot reach makes the whole request 404. */
  async findAllFor(ids: readonly string[]): Promise<TaskAccessRow[]> {
    const tasks = await this.prisma.db.task.findMany({
      where: { AND: [{ id: { in: [...ids] } }, this.visibleWhere()] },
      select: ACCESS_SELECT,
    });
    if (tasks.length !== ids.length) throw new ResourceNotFoundException();
    for (const fileId of new Set(tasks.flatMap((task) => (task.fileId ? [task.fileId] : [])))) {
      await this.files.assertFileAccess(fileId, 'write');
    }
    return tasks;
  }

  // A missing caller is a programming error (guarded routes always set it): 500 SYS-001, never a 403 that hides it.
  actorId(): UserId {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }

  private role(): Role {
    const role = this.cls.get('role');
    if (!role) throw new Error('No role in the request context');
    return role;
  }
}

/**
 * The assignee must be an active colleague whose role can work on tasks (`complete:task`) and, for a file's task, who
 * can see that file by their own scope (D-051, D-096) — otherwise 400 VAL-001 on `assignedToId`.
 */
export async function assertAssignable(
  tx: ScopedTransaction,
  userId: string,
  fileId: string | null,
): Promise<void> {
  const user = await tx.user.findFirst({
    where: { id: userId, isActive: true },
    select: { id: true, role: true },
  });
  const permissions = user ? permissionsFor(user.role) : [];
  let allowed = user !== null && permissions.includes('complete:task');
  if (allowed && user && fileId) {
    const visible = await tx.legalFile.count({
      where: {
        id: fileId,
        deletedAt: null,
        ...caseScopeWhere(caseScope(permissions, user.id as UserId), user.role),
      },
    });
    allowed = visible === 1;
  }
  if (!allowed) {
    throw new ValidationException([{ field: 'assignedToId', message: 'validation.assignee' }]);
  }
}
