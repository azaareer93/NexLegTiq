import type { OfficeId, UserId } from '@nexlegtiq/shared-types';
import { ClsServiceManager } from 'nestjs-cls';

import type { RequestContext } from '../context/request-context';
import { TenantRunner } from './tenant-runner';

const cls = ClsServiceManager.getClsService<RequestContext>();
const runner = new TenantRunner(cls);
const A = '01920000-0000-7000-8000-00000000000a' as OfficeId;
const B = '01920000-0000-7000-8000-00000000000b' as OfficeId;
const USER = '01920000-0000-7000-8000-0000000000aa' as UserId;
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('TenantRunner — isolation between runs', () => {
  it('should keep overlapping runs on their own office', async () => {
    const [first, second] = await Promise.all([
      runner.run({ officeId: A }, async () => {
        await tick(20);
        return cls.get('officeId');
      }),
      runner.run({ officeId: B }, async () => {
        await tick(5);
        return cls.get('officeId');
      }),
    ]);

    expect([first, second]).toEqual([A, B]);
  });

  it('should run lazy thenables (Prisma queries) inside the context', async () => {
    // Like a PrismaPromise: nothing happens until then() is called.
    const lazy = { then: (resolve: (value: unknown) => void) => resolve(cls.get('officeId')) };

    await expect(
      runner.run({ officeId: A }, () => lazy as unknown as Promise<unknown>),
    ).resolves.toBe(A);
  });

  it('should not inherit the caller user, role or permissions when nested in a request context', async () => {
    await cls.run(async () => {
      cls.set('officeId', A);
      cls.set('userId', USER);
      cls.set('permissions', ['view:all:cases']);

      const inner = await runner.run({ officeId: B }, async () => cls.get());

      expect(inner).toMatchObject({ officeId: B });
      expect(inner.userId).toBeUndefined();
      expect(inner.permissions).toBeUndefined();
      expect(cls.get('officeId')).toBe(A);
    });
  });
});
