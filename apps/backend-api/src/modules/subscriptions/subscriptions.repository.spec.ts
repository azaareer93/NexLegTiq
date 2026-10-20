import type { OfficeId } from '@nexlegtiq/shared-types';

import { SubscriptionsRepository } from './subscriptions.repository';
import type { PrismaService } from '../../database/prisma.service';

const OFFICE = 'office-1' as OfficeId;

function repository(...rows: (object | null)[]) {
  const findFirst = jest.fn();
  for (const row of rows) findFirst.mockResolvedValueOnce(row);
  const prisma = { unscoped: () => ({ subscription: { findFirst } }) } as unknown as PrismaService;
  return { repo: new SubscriptionsRepository(prisma), findFirst };
}

describe('SubscriptionsRepository.subscriptionOf (D-122)', () => {
  it('should prefer the live subscription', async () => {
    const { repo, findFirst } = repository({ status: 'ACTIVE' });
    await expect(repo.subscriptionOf(OFFICE)).resolves.toEqual([{ status: 'ACTIVE' }]);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('should fall back to the newest one, or none', async () => {
    await expect(
      repository(null, { status: 'EXPIRED' }).repo.subscriptionOf(OFFICE),
    ).resolves.toEqual([{ status: 'EXPIRED' }]);
    await expect(repository(null, null).repo.subscriptionOf(OFFICE)).resolves.toEqual([]);
  });
});
