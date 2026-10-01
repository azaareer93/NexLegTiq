import { Controller, Get } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { OfficeId, UserId } from '@nexlegtiq/shared-types';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import { PrismaService } from '../../database/prisma.service';
import { ReadinessRegistry } from '../../health/readiness.registry';
import type { AuthPrincipal, RequestContext } from '../context/request-context';
import { PermissionDeniedException } from '../errors/app.exception';
import { TenantRunner } from '../tenancy/tenant-runner';
import { RequirePermissions } from './permissions.decorator';
import { PermissionsGuard } from './permissions.guard';

@Controller('audit-probe')
class ProbeController {
  @RequirePermissions('manage:users')
  @Get()
  manageUsers(): string {
    return 'ok';
  }
}

/**
 * The denial audit on real PostgreSQL: the row lands in the caller's office through the scoped client, and a
 * principal whose user belongs to another office is refused by the composite FK — logged, still 403 (D-079, D-081).
 */
describe('PermissionsGuard denial audit (real PostgreSQL)', () => {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const warn = jest.fn();
  let prisma: PrismaService;
  let guard: PermissionsGuard;
  const offices: { officeId: string; userId: string }[] = [];

  const deny = (principal: AuthPrincipal): Promise<boolean> =>
    guard.canActivate({
      getHandler: () => ProbeController.prototype.manageUsers,
      getClass: () => ProbeController,
      switchToHttp: () => ({ getRequest: () => ({ user: principal, method: 'GET', ip: '127.0.0.1', headers: {} }) }),
    } as unknown as ExecutionContext);

  beforeAll(async () => {
    const config = new AppConfig(parseEnv(testEnv({ DATABASE_URL: process.env['DATABASE_URL'], NODE_ENV: 'test' })));
    prisma = new PrismaService(config, new ReadinessRegistry({ setContext: () => undefined } as unknown as PinoLogger), cls);
    const logger = { setContext: jest.fn(), warn } as unknown as PinoLogger;
    guard = new PermissionsGuard(new Reflector(), prisma, new TenantRunner(cls), cls, logger);
    const raw = prisma.unscoped();
    for (const name of ['Audit office A', 'Audit office B']) {
      const office = await raw.office.create({ data: { name } });
      const user = await raw.user.create({
        data: { officeId: office.id, fullName: 'Trainee', email: `audit-${office.id}@example.test`, passwordHash: '!', role: 'TRAINEE' },
      });
      offices.push({ officeId: office.id, userId: user.id });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    const raw = prisma.unscoped();
    const ids = offices.map((office) => office.officeId);
    await raw.auditLog.deleteMany({ where: { officeId: { in: ids } } });
    await raw.user.deleteMany({ where: { officeId: { in: ids } } });
    await raw.office.deleteMany({ where: { id: { in: ids } } });
    await prisma.onModuleDestroy();
  });

  it('should write one PERMISSION_DENIED row in the caller office only', async () => {
    const [a, b] = offices as [(typeof offices)[0], (typeof offices)[0]];
    const principal: AuthPrincipal = {
      userId: a.userId as UserId,
      officeId: a.officeId as OfficeId,
      role: 'TRAINEE',
      realm: 'OFFICE',
    };

    await expect(deny(principal)).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(warn).not.toHaveBeenCalled();

    const rows = await prisma.unscoped().auditLog.findMany({ where: { officeId: { in: [a.officeId, b.officeId] } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      officeId: a.officeId,
      userId: a.userId,
      action: 'PERMISSION_DENIED',
      entityType: 'Route',
      ipAddress: '127.0.0.1',
      newValues: expect.objectContaining({ mode: 'ALL', required: ['manage:users'], role: 'TRAINEE' }),
    });
  });

  it('should still answer 403 when the principal user belongs to another office (FK refuses the audit row)', async () => {
    const [a, b] = offices as [(typeof offices)[0], (typeof offices)[0]];
    warn.mockClear();
    const forged: AuthPrincipal = { userId: b.userId as UserId, officeId: a.officeId as OfficeId, role: 'TRAINEE', realm: 'OFFICE' };

    await expect(deny(forged)).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.anything() }), 'Could not audit a permission denial');
    await expect(prisma.unscoped().auditLog.count({ where: { userId: b.userId } })).resolves.toBe(0);
  });
});
