import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { OfficeId, UserId } from '@nexlegtiq/shared-types';
import { CLS_ID, ClsServiceManager } from 'nestjs-cls';
import { lastValueFrom, of } from 'rxjs';

import { TenantRunner } from './tenant-runner';
import { TenantInterceptor } from './tenant.interceptor';
import type { AuthPrincipal, RequestContext } from '../context/request-context';

const cls = ClsServiceManager.getClsService<RequestContext>();
const OFFICE = '01920000-0000-7000-8000-00000000000a' as OfficeId;
const USER = '01920000-0000-7000-8000-0000000000aa' as UserId;

function httpContext(user?: AuthPrincipal): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as unknown as ExecutionContext;
}

describe('TenantInterceptor', () => {
  const interceptor = new TenantInterceptor(cls);
  const principal: AuthPrincipal = {
    userId: USER,
    officeId: OFFICE,
    role: 'LAWYER',
    realm: 'OFFICE',
  };

  it('should copy the authenticated principal into CLS', async () => {
    await cls.run(async () => {
      const handler: CallHandler = { handle: () => of(cls.get('officeId')) };

      await expect(
        lastValueFrom(interceptor.intercept(httpContext(principal), handler)),
      ).resolves.toBe(OFFICE);
      expect(cls.get()).toMatchObject({
        userId: USER,
        officeId: OFFICE,
        role: 'LAWYER',
        realm: 'OFFICE',
      });
      expect(cls.get('permissions')).toContain('create:case');
      expect(cls.get('permissions')).not.toContain('view:audit');
    });
  });

  it('should give portal principals an office but no office role or permissions', async () => {
    await cls.run(async () => {
      await lastValueFrom(
        interceptor.intercept(httpContext({ ...principal, realm: 'PORTAL' }), {
          handle: () => of(null),
        }),
      );

      expect(cls.get('officeId')).toBe(OFFICE);
      expect(cls.get('role')).toBeUndefined();
      expect(cls.get('permissions')).toBeUndefined();
    });
  });

  it('should leave CLS without an office on public routes', async () => {
    await cls.run(async () => {
      await lastValueFrom(interceptor.intercept(httpContext(), { handle: () => of(null) }));

      expect(cls.get('officeId')).toBeUndefined();
    });
  });
});

describe('TenantRunner', () => {
  const runner = new TenantRunner(cls);

  it('should run work in a fresh context with the office, user and request id', async () => {
    const seen = await runner.run(
      { officeId: OFFICE, userId: USER, requestId: 'req-12345678' },
      async () => ({
        officeId: cls.get('officeId'),
        userId: cls.get('userId'),
        requestId: cls.get(CLS_ID),
      }),
    );

    expect(seen).toEqual({ officeId: OFFICE, userId: USER, requestId: 'req-12345678' });
    expect(cls.isActive()).toBe(false);
  });

  it('should generate a request id when the job carries none', async () => {
    const requestId = await runner.run({ officeId: OFFICE }, async () => cls.get(CLS_ID));

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
