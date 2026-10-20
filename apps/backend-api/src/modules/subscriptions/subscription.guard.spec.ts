import type { ExecutionContext } from '@nestjs/common';
import { Controller, Get, Post } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { OfficeId, UserId } from '@nexlegtiq/shared-types';

import { resolveEntitlements } from './entitlements';
import type { Entitlements } from './entitlements';
import type { EntitlementsService } from './entitlements.service';
import { AllowWhenReadOnly, RequireFeature } from './subscription.decorators';
import { SubscriptionGuard } from './subscription.guard';
import type { AuthPrincipal } from '../../common/context/request-context';

@Controller()
class Routes {
  @Get() read(): string {
    return 'read';
  }
  @Post() write(): string {
    return 'write';
  }
  @AllowWhenReadOnly() @Post() own(): string {
    return 'own';
  }
  @RequireFeature('googleVisionOcr') @Get() gated(): string {
    return 'gated';
  }
}

const OFFICE: AuthPrincipal = {
  userId: 'u' as UserId,
  officeId: 'o' as OfficeId,
  role: 'OFFICE_MANAGER',
  realm: 'OFFICE',
};
const plan = { code: 'P', name: 'P', maxUsers: null, aiQuotaMonthly: null, storageQuotaMb: 1 };
const ACTIVE = resolveEntitlements(
  [
    {
      status: 'ACTIVE',
      currentPeriodEnd: null,
      trialEndsAt: null,
      plan: { ...plan, features: {} },
    },
  ],
  new Date(),
);
const ENDED = { ...ACTIVE, status: 'EXPIRED', readOnly: true } satisfies Entitlements;

function run(
  handler: keyof Routes,
  method: string,
  entitlements: Entitlements,
  user?: AuthPrincipal,
) {
  const forOffice = jest.fn().mockResolvedValue(entitlements);
  const guard = new SubscriptionGuard(new Reflector(), {
    forOffice,
  } as unknown as EntitlementsService);
  const context = {
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ method, user }) }),
  } as unknown as ExecutionContext;
  return { result: guard.canActivate(context), forOffice };
}

describe('SubscriptionGuard (D-122)', () => {
  it('should refuse writes with AUTH-104 while the office is read-only, and allow reads', async () => {
    await expect(run('write', 'POST', ENDED, OFFICE).result).rejects.toMatchObject({
      code: 'AUTH-104',
    });
    await expect(run('write', 'DELETE', ENDED, OFFICE).result).rejects.toMatchObject({
      code: 'AUTH-104',
    });
    await expect(run('own', 'POST', ENDED, OFFICE).result).resolves.toBe(true);
    await expect(run('write', 'POST', ACTIVE, OFFICE).result).resolves.toBe(true);
  });

  it('should not load entitlements for an ungated read, a public route or a platform admin', async () => {
    for (const [handler, method, user] of [
      ['read', 'GET', OFFICE],
      ['write', 'POST', undefined],
      ['write', 'POST', { ...OFFICE, realm: 'PLATFORM' }],
    ] as const) {
      const { result, forOffice } = run(handler, method, ENDED, user);
      await expect(result).resolves.toBe(true);
      expect(forOffice).not.toHaveBeenCalled();
    }
  });

  it('should bind a portal client to the office subscription too', async () => {
    await expect(
      run('write', 'POST', ENDED, { ...OFFICE, realm: 'PORTAL' }).result,
    ).rejects.toMatchObject({ code: 'AUTH-104' });
  });

  it('should refuse a route whose feature the plan lacks with AUTH-102', async () => {
    await expect(run('gated', 'GET', ACTIVE, OFFICE).result).rejects.toMatchObject({
      code: 'AUTH-102',
    });
    const withOcr = { ...ACTIVE, features: { ...ACTIVE.features, googleVisionOcr: true } };
    await expect(run('gated', 'GET', withOcr, OFFICE).result).resolves.toBe(true);
  });
});
