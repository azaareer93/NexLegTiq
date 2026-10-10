import { Injectable } from '@nestjs/common';
import type { Permission, Role, UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { assignedFilesWhere, caseScope, caseScopeWhere } from '../../common/rbac/case-scope';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';

export type FileAccessMode = 'read' | 'write';

/**
 * Which legal files the caller may see and change (D-051, D-081, D-096). Every route on a file goes through
 * `assertFileAccess`; lists use `visibleWhere`. A file the caller may not reach is 404 RES-001, never 403 (D-019);
 * an archived file is read-only for everyone (D-052, BIZ-007).
 */
@Injectable()
export class CaseAccessService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
  ) {}

  /** Live (not deleted) files the caller may see: their scope plus the confidentiality rule. */
  visibleWhere(): Prisma.LegalFileWhereInput {
    const { userId, role, permissions } = this.caller();
    return { deletedAt: null, ...caseScopeWhere(caseScope(permissions, userId), role) };
  }

  /** Visible files the caller may also edit: any with `edit:any:case`, else only assigned ones. */
  editableWhere(): Prisma.LegalFileWhereInput {
    const { userId, permissions } = this.caller();
    if (permissions.includes('edit:any:case')) return this.visibleWhere();
    if (permissions.includes('edit:assigned:case')) {
      return { AND: [this.visibleWhere(), assignedFilesWhere(userId)] };
    }
    throw new PermissionDeniedException();
  }

  /** The file if the caller may read (or edit) it; 404 otherwise, BIZ-007 when writing to an archived file. */
  async assertFileAccess(fileId: string, mode: FileAccessMode): Promise<{ id: string }> {
    const where = mode === 'write' ? this.editableWhere() : this.visibleWhere();
    const file = await this.prisma.db.legalFile.findFirst({
      where: { AND: [{ id: fileId }, where] },
      select: { id: true, status: true },
    });
    if (!file) throw new ResourceNotFoundException();
    if (mode === 'write' && file.status === 'ARCHIVED') {
      throw new BusinessRuleException('BIZ-007', 'The file is archived and read-only');
    }
    return { id: file.id };
  }

  private caller(): { userId: UserId; role: Role; permissions: readonly Permission[] } {
    const userId = this.cls.get('userId');
    const role = this.cls.get('role');
    const permissions = this.cls.get('permissions');
    // Routes are guarded (JWT + permissions), so an office caller always has these; a missing one is a programming
    // error (500 SYS-001), never a 403 that would hide it.
    if (!userId || !role || !permissions)
      throw new Error('No office caller in the request context');
    return { userId, role, permissions };
  }
}
