import { PortalAccounts } from './portal-accounts';
import type { PrismaService } from '../../database/prisma.service';
import type { EntitlementsService } from '../subscriptions/entitlements.service';

const CLIENT = { ip: '203.0.113.7', userAgent: 'x'.repeat(600), requestId: 'req-1' };

describe('PortalAccounts (D-158)', () => {
  it('should list the live grants in active offices as office accesses', async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        officeId: 'o1',
        clientId: 'c1',
        office: { name: 'Office' },
        client: { displayName: 'Layla' },
      },
    ]);
    const forOffice = jest.fn().mockResolvedValue({ features: { clientPortal: true } });
    const accounts = new PortalAccounts(
      { unscoped: () => ({ clientPortalAccess: { findMany } }) } as unknown as PrismaService,
      { forOffice } as unknown as EntitlementsService,
    );
    await expect(accounts.offices('u1')).resolves.toEqual([
      { officeId: 'o1', officeName: 'Office', clientId: 'c1', clientName: 'Layla' },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clientUserId: 'u1', revokedAt: null }),
      }),
    );
  });

  it('should treat an office whose plan lacks the portal as no grant', async () => {
    const grant = (officeId: string) => ({
      officeId,
      clientId: 'c1',
      office: { name: officeId },
      client: { displayName: 'L' },
    });
    const accounts = new PortalAccounts(
      {
        unscoped: () => ({
          clientPortalAccess: { findMany: jest.fn().mockResolvedValue([grant('o1'), grant('o2')]) },
        }),
      } as unknown as PrismaService,
      {
        forOffice: jest.fn((id: string) =>
          Promise.resolve({ features: { clientPortal: id === 'o2' } }),
        ),
      } as unknown as EntitlementsService,
    );
    expect((await accounts.offices('u1')).map((o) => o.officeId)).toEqual(['o2']);
  });

  it('should write one audit row per office with a live grant, with the user agent capped, and none without', async () => {
    const createMany = jest.fn();
    const writer = (grants: object[]) =>
      ({
        clientPortalAccess: { findMany: jest.fn().mockResolvedValue(grants) },
        auditLog: { createMany },
      }) as never;
    const accounts = new PortalAccounts({} as PrismaService, {} as EntitlementsService);
    await accounts.audit(writer([]), 'u1', 'LOGIN', CLIENT);
    expect(createMany).not.toHaveBeenCalled();
    await accounts.audit(writer([{ officeId: 'o1' }, { officeId: 'o2' }]), 'u1', 'UPDATE', CLIENT, {
      passwordReset: true,
    });
    const { data } = createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({
      officeId: 'o1',
      clientUserId: 'u1',
      action: 'UPDATE',
      newValues: { passwordReset: true },
    });
    expect((data[0]?.['userAgent'] as string).length).toBe(512);
    await accounts.audit(writer([{ officeId: 'o1' }]), 'u1', 'LOGIN', {
      ...CLIENT,
      userAgent: null,
    });
    const plain = (createMany.mock.calls[1][0] as { data: Record<string, unknown>[] }).data[0];
    expect(plain).not.toHaveProperty('newValues');
    expect(plain?.['userAgent']).toBeNull();
  });
});
