import type { Permission, Role } from '@nexlegtiq/shared-types';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import { CaseAccessService } from './case-access.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  PermissionDeniedException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { assignedFilesWhere } from '../../common/rbac/case-scope';
import type { PrismaService } from '../../database/prisma.service';

const USER = '01920000-0000-7000-8000-000000000001';
const FILE = '01920000-0000-7000-8000-0000000000f1';

function service(
  role: Role | undefined,
  file: { id: string; status: string } | null = { id: FILE, status: 'OPEN' },
  permissions: readonly Permission[] | undefined = role && permissionsFor(role),
) {
  const store: Partial<RequestContext> = { userId: role && (USER as never), role, permissions };
  const cls = {
    get: (key: keyof RequestContext) => store[key],
  } as unknown as ClsService<RequestContext>;
  const findFirst = jest.fn().mockResolvedValue(file);
  const prisma = { db: { legalFile: { findFirst } } } as unknown as PrismaService;
  return { access: new CaseAccessService(cls, prisma), findFirst };
}

const assigned = assignedFilesWhere(USER as never);
const notConfidentialOrAssigned = { OR: [{ isConfidential: false }, assigned] };

describe('CaseAccessService', () => {
  it.each([
    ['OFFICE_MANAGER', { deletedAt: null }],
    ['SENIOR_LAWYER', { deletedAt: null, ...notConfidentialOrAssigned }],
    ['ADMIN', { deletedAt: null, ...notConfidentialOrAssigned }],
    ['LAWYER', { deletedAt: null, ...assigned }],
    ['EXTERNAL_COLLABORATOR', { deletedAt: null, ...assigned }],
  ] as const)('should let %s see %j', (role, where) => {
    expect(service(role).access.visibleWhere()).toEqual(where);
  });

  it('should let edit:any edit what it sees, and edit:assigned only assigned files', () => {
    expect(service('SENIOR_LAWYER').access.editableWhere()).toEqual({
      deletedAt: null,
      ...notConfidentialOrAssigned,
    });
    expect(service('PARALEGAL').access.editableWhere()).toEqual({
      AND: [{ deletedAt: null, ...assigned }, assigned],
    });
    expect(() => service('ADMIN').access.editableWhere()).toThrow(PermissionDeniedException);
  });

  it('should fail closed without a caller in the context', () => {
    expect(() => service(undefined).access.visibleWhere()).toThrow('No office caller');
  });

  it('should return a reachable file, 404 an unreachable one and BIZ-007 a write to an archived one', async () => {
    const reachable = service('LAWYER');
    await expect(reachable.access.assertFileAccess(FILE, 'read')).resolves.toEqual({ id: FILE });
    expect(reachable.findFirst).toHaveBeenCalledWith({
      where: { AND: [{ id: FILE }, { deletedAt: null, ...assigned }] },
      select: { id: true, status: true },
    });
    await expect(
      service('LAWYER', null).access.assertFileAccess(FILE, 'read'),
    ).rejects.toBeInstanceOf(ResourceNotFoundException);
    const archived = service('OFFICE_MANAGER', { id: FILE, status: 'ARCHIVED' });
    await expect(archived.access.assertFileAccess(FILE, 'read')).resolves.toEqual({ id: FILE });
    await expect(archived.access.assertFileAccess(FILE, 'write')).rejects.toBeInstanceOf(
      BusinessRuleException,
    );
  });
});
