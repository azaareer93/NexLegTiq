import { PlatformPlansController } from './platform-plans.controller';

function controller(active = false) {
  const plans = {
    list: jest.fn().mockResolvedValue(['p']),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const cls = {
    isActive: jest.fn().mockReturnValue(active),
    getId: jest.fn().mockReturnValue('req-1'),
  };
  return { c: new PlatformPlansController(plans as never, cls as never), plans };
}
const req = (id?: string) =>
  ({ platformAdminId: id, ip: '1.2.3.4', get: () => undefined }) as never;

describe('PlatformPlansController', () => {
  it('should pass every call to the service with the admin and the request id', async () => {
    const { c, plans } = controller(true);
    await expect(c.list()).resolves.toEqual(['p']);
    await expect(c.create({ code: 'PS_PRO' } as never, req('a1'))).resolves.toBe('created');
    await expect(c.update('p1', { name: 'x' }, req('a1'))).resolves.toBe('updated');
    await c.remove('p1', req('a1'));
    expect(plans.create).toHaveBeenCalledWith(
      { code: 'PS_PRO' },
      'a1',
      expect.objectContaining({ requestId: 'req-1' }),
    );
    expect(plans.remove).toHaveBeenCalledWith('p1', 'a1', expect.anything());
  });

  it('should fail loudly when the admin guard did not run', () => {
    const { c } = controller();
    expect(() => c.remove('p1', req())).toThrow('AdminAuthGuard did not run');
  });
});
