import { Controller, Get } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES } from '@nexlegtiq/shared-types';
import type { OfficeId, Role, UserId } from '@nexlegtiq/shared-types';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import type { PrismaService } from '../../database/prisma.service';
import { Role as PrismaRole } from '../../generated/prisma/enums';
import type { AuthPrincipal, RequestContext } from '../context/request-context';
import { AppException, PermissionDeniedException } from '../errors/app.exception';
import { TenantRunner } from '../tenancy/tenant-runner';
import { assignedFilesWhere, caseScope, caseScopeWhere } from './case-scope';
import { RequireAnyPermission, RequirePermissions } from './permissions.decorator';
import { PermissionsGuard } from './permissions.guard';

const OFFICE = '01920000-0000-7000-8000-00000000000a' as OfficeId;
const USER = '01920000-0000-7000-8000-0000000000aa' as UserId;

@Controller('probe')
class ProbeController {
  @Get('public')
  open(): string {
    return 'open';
  }

  @RequirePermissions('create:case', 'use:ai')
  @Get('all')
  all(): string {
    return 'all';
  }

  @RequireAnyPermission('view:all:cases', 'view:assigned:cases')
  @Get('any')
  any(): string {
    return 'any';
  }
}

@RequirePermissions('manage:office')
class ManagerOnlyController {
  settings(): string {
    return 'settings';
  }
}

function setup() {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const create = jest.fn().mockResolvedValue({});
  const prisma = { db: { auditLog: { create } } } as unknown as PrismaService;
  const logger = { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger;
  const guard = new PermissionsGuard(new Reflector(), prisma, new TenantRunner(cls), cls, logger);
  const context = (handler: () => void, cls_: object, user?: AuthPrincipal): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => cls_,
      switchToHttp: () => ({
        getRequest: () => ({
          user,
          ip: '127.0.0.1',
          method: 'GET',
          headers: { 'user-agent': 'jest' },
        }),
      }),
    }) as unknown as ExecutionContext;
  return { guard, context, create, logger };
}

const as = (role: Role): AuthPrincipal => ({
  userId: USER,
  officeId: OFFICE,
  role,
  realm: 'OFFICE',
});
const proto = ProbeController.prototype;

describe('PermissionsGuard', () => {
  it('should let routes without a permission decorator through', async () => {
    const { guard, context } = setup();
    await expect(guard.canActivate(context(proto.open, ProbeController))).resolves.toBe(true);
  });

  it('should require every permission for @RequirePermissions', async () => {
    const { guard, context } = setup();
    await expect(
      guard.canActivate(context(proto.all, ProbeController, as('LAWYER'))),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(context(proto.all, ProbeController, as('ADMIN'))),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
  });

  it('should require one permission for @RequireAnyPermission', async () => {
    const { guard, context } = setup();
    for (const role of ROLES) {
      await expect(guard.canActivate(context(proto.any, ProbeController, as(role)))).resolves.toBe(
        true,
      );
    }
  });

  it('should read a class-level requirement', async () => {
    const { guard, context } = setup();
    const handler = ManagerOnlyController.prototype.settings;
    await expect(
      guard.canActivate(context(handler, ManagerOnlyController, as('OFFICE_MANAGER'))),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(context(handler, ManagerOnlyController, as('SENIOR_LAWYER'))),
    ).rejects.toMatchObject({
      code: 'AUTH-100',
      status: 403,
    });
  });

  it('should answer 401 AUTH-003 when a protected route has no principal', async () => {
    const { guard, context } = setup();
    await expect(guard.canActivate(context(proto.all, ProbeController))).rejects.toMatchObject({
      code: 'AUTH-003',
    });
  });

  it('should deny an unknown role', async () => {
    const { guard, context } = setup();
    const ghost = { ...as('LAWYER'), role: 'GHOST' as Role };
    await expect(
      guard.canActivate(context(proto.any, ProbeController, ghost)),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
  });

  it('should audit a denial in the caller office, with the route and the requirement', async () => {
    const { guard, context, create } = setup();
    await expect(
      guard.canActivate(context(proto.all, ProbeController, as('TRAINEE'))),
    ).rejects.toThrow(AppException);

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER,
        action: 'PERMISSION_DENIED',
        entityType: 'Route',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
        newValues: expect.objectContaining({
          mode: 'ALL',
          required: ['create:case', 'use:ai'],
          role: 'TRAINEE',
        }),
      }),
    });
  });

  it('should still answer 403 when the audit write fails', async () => {
    const { guard, context, create, logger } = setup();
    create.mockRejectedValueOnce(new Error('db down'));

    await expect(
      guard.canActivate(context(proto.all, ProbeController, as('TRAINEE'))),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('case scope (D-051)', () => {
  it('should give ALL to view:all:cases and ASSIGNED to view:assigned:cases', () => {
    expect(caseScope(['view:all:cases', 'view:assigned:cases'], USER)).toEqual({ kind: 'ALL' });
    expect(caseScope(['view:assigned:cases'], USER)).toEqual({ kind: 'ASSIGNED', userId: USER });
    expect(() => caseScope(['use:ai'], USER)).toThrow(PermissionDeniedException);
  });

  it('should filter assigned files by responsible lawyer, responsible paralegal or team membership', () => {
    expect(assignedFilesWhere(USER)).toEqual({
      OR: [
        { responsibleLawyerId: USER },
        { responsibleParalegalId: USER },
        { teamMembers: { some: { userId: USER } } },
      ],
    });
    expect(caseScopeWhere({ kind: 'ALL' })).toEqual({});
    expect(caseScopeWhere({ kind: 'ASSIGNED', userId: USER })).toEqual(assignedFilesWhere(USER));
  });
});

describe('roles', () => {
  it('should match the Prisma Role enum exactly', () => {
    expect([...ROLES].sort()).toEqual(Object.values(PrismaRole).sort());
  });
});
