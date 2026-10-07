import { Controller, Get } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { OfficeId, Role, UserId } from '@nexlegtiq/shared-types';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import {
  PermissionConditionsCheckedByService,
  RequireAnyPermission,
  RequirePermissions,
} from './permissions.decorator';
import { PermissionsGuard } from './permissions.guard';
import type { PrismaService } from '../../database/prisma.service';
import type { AuthPrincipal, AuthRealm, RequestContext } from '../context/request-context';
import { PermissionDeniedException } from '../errors/app.exception';
import { TenantRunner } from '../tenancy/tenant-runner';

// Cases added by the MVP-38 review (D-081): class + method requirements, ANY denial, realms, conditional cells.
const OFFICE = '01920000-0000-7000-8000-00000000000a' as OfficeId;
const USER = '01920000-0000-7000-8000-0000000000aa' as UserId;

@RequirePermissions('manage:users')
@Controller('users')
class UsersController {
  @RequireAnyPermission('view:assigned:cases')
  @Get('mine')
  mine(): string {
    return 'mine';
  }

  @Get('all')
  all(): string {
    return 'all';
  }
}

@Controller('cases')
class CasesController {
  @RequireAnyPermission('view:all:invoices', 'view:all:cases')
  @Get('overview')
  overview(): string {
    return 'overview';
  }

  @RequirePermissions('close:case')
  @Get('close-unchecked')
  closeUnchecked(): string {
    return 'close';
  }

  @PermissionConditionsCheckedByService()
  @RequirePermissions('close:case')
  @Get('close-checked')
  closeChecked(): string {
    return 'close';
  }
}

function setup() {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const create = jest.fn().mockResolvedValue({});
  const prisma = { db: { auditLog: { create } } } as unknown as PrismaService;
  const logger = { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger;
  const guard = new PermissionsGuard(new Reflector(), prisma, new TenantRunner(cls), cls, logger);
  const run = (handler: () => string, controller: object, user: AuthPrincipal): Promise<boolean> =>
    guard.canActivate({
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({
        getRequest: () => ({ user, headers: { 'user-agent': 'x'.repeat(2000) } }),
      }),
    } as unknown as ExecutionContext);
  return { run, create };
}

const as = (role: Role, realm: AuthRealm = 'OFFICE'): AuthPrincipal => ({
  userId: USER,
  officeId: OFFICE,
  role,
  realm,
});
const users = UsersController.prototype;
const cases = CasesController.prototype;

describe('PermissionsGuard — review hardening (D-081)', () => {
  it('should require both the class and the method requirement', async () => {
    const { run } = setup();
    await expect(run(users.mine, UsersController, as('OFFICE_MANAGER'))).resolves.toBe(true);
    await expect(run(users.mine, UsersController, as('TRAINEE'))).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    await expect(run(users.all, UsersController, as('SENIOR_LAWYER'))).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
  });

  it('should deny ANY when no listed permission is held, and audit mode ANY', async () => {
    const { run, create } = setup();
    await expect(run(cases.overview, CasesController, as('ADMIN'))).resolves.toBe(true);
    await expect(run(cases.overview, CasesController, as('LAWYER'))).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        officeId: OFFICE,
        newValues: expect.objectContaining({ mode: 'ANY' }),
      }),
    });
  });

  it.each<AuthRealm>(['PORTAL', 'PLATFORM'])(
    'should give no office permissions to the %s realm',
    async (realm) => {
      const { run, create } = setup();
      await expect(
        run(cases.overview, CasesController, as('OFFICE_MANAGER', realm)),
      ).rejects.toBeInstanceOf(PermissionDeniedException);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('should treat a conditional cell as not held unless the service declares it checks the condition', async () => {
    const { run } = setup();
    await expect(run(cases.closeUnchecked, CasesController, as('LAWYER'))).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
    await expect(run(cases.closeChecked, CasesController, as('LAWYER'))).resolves.toBe(true);
    await expect(run(cases.closeUnchecked, CasesController, as('SENIOR_LAWYER'))).resolves.toBe(
      true,
    );
  });

  it('should truncate the audited user agent', async () => {
    const { run, create } = setup();
    await expect(run(users.all, UsersController, as('TRAINEE'))).rejects.toThrow();
    expect(
      (create.mock.calls[0]?.[0] as { data: { userAgent: string } }).data.userAgent,
    ).toHaveLength(512);
  });

  it('should not audit allowed requests', async () => {
    const { run, create } = setup();
    await run(users.mine, UsersController, as('OFFICE_MANAGER'));
    expect(create).not.toHaveBeenCalled();
  });
});
