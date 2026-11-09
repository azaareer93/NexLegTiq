import { PlatformAuditService } from './platform-audit.service';
import type { PrismaService } from '../../database/prisma.service';

const CLIENT = { ip: '203.0.113.7', userAgent: 'UA', requestId: 'req-12345678' };

/** D-145: one row per admin action, written through the raw client or the caller's transaction. */
describe('PlatformAuditService', () => {
  it('should write the full entry through a given transaction', async () => {
    const create = jest.fn();
    const service = new PlatformAuditService({} as PrismaService);
    await service.log(
      {
        adminId: 'a1',
        action: 'LOGIN',
        entityType: 'PlatformAdmin',
        entityId: 'a1',
        targetOfficeId: 'o1',
        oldValues: { x: 1 },
        newValues: { x: 2 },
      },
      CLIENT,
      { platformAuditLog: { create } } as never,
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 'a1',
        targetOfficeId: 'o1',
        oldValues: { x: 1 },
        newValues: { x: 2 },
        ipAddress: '203.0.113.7',
        requestId: 'req-12345678',
      }),
    });
  });

  it('should use the raw client and leave out what was not given', async () => {
    const create = jest.fn();
    const service = new PlatformAuditService({
      unscoped: () => ({ platformAuditLog: { create } }),
    } as unknown as PrismaService);
    await service.log({ adminId: null, action: 'LOGOUT', entityType: 'PlatformSession' }, CLIENT);
    const data = create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({ adminId: null, entityId: null, targetOfficeId: null });
    expect(data).not.toHaveProperty('oldValues');
    expect(data).not.toHaveProperty('newValues');
  });
});
