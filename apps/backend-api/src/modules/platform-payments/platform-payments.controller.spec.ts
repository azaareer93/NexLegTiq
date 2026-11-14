import { PlatformPaymentsController } from './platform-payments.controller';

function controller(active = false, receipt: object = { status: 'RENDERING' }) {
  const payments = {
    list: jest.fn().mockResolvedValue(['p']),
    record: jest.fn().mockResolvedValue('recorded'),
    void: jest.fn().mockResolvedValue('voided'),
    receipt: jest.fn().mockResolvedValue(receipt),
  };
  const cls = {
    isActive: jest.fn().mockReturnValue(active),
    getId: jest.fn().mockReturnValue('req-1'),
  };
  return { c: new PlatformPaymentsController(payments as never, cls as never), payments };
}
const req = (id?: string) =>
  ({ platformAdminId: id, ip: '1.2.3.4', get: () => undefined }) as never;
const res = () => ({ status: jest.fn() });

describe('PlatformPaymentsController', () => {
  it('should pass every call to the service with the admin and the request id', async () => {
    const { c, payments } = controller(true);
    await expect(c.list('o1')).resolves.toEqual(['p']);
    await expect(c.record('o1', { amount: '1' } as never, req('a1'))).resolves.toBe('recorded');
    await expect(c.void('p1', { reason: ' twice ' }, req('a1'))).resolves.toBe('voided');
    expect(payments.record).toHaveBeenCalledWith(
      'o1',
      { amount: '1' },
      'a1',
      expect.objectContaining({ requestId: 'req-1' }),
    );
    expect(payments.void).toHaveBeenCalledWith('p1', 'twice', 'a1', expect.anything());
  });

  it('should answer 202 while the receipt renders and 200 once ready', async () => {
    const rendering = controller();
    const r1 = res();
    await expect(rendering.c.receipt('p1', {}, req('a1'), r1 as never)).resolves.toEqual({
      status: 'RENDERING',
    });
    expect(r1.status).toHaveBeenCalledWith(202);
    const ready = controller(false, { status: 'READY', downloadUrl: 'u', expiresIn: 300 });
    const r2 = res();
    await ready.c.receipt('p1', { language: 'EN' }, req('a1'), r2 as never);
    expect(r2.status).not.toHaveBeenCalled();
    expect(ready.payments.receipt).toHaveBeenCalledWith('p1', 'EN', 'a1', expect.anything());
  });

  it('should fail loudly when the admin guard did not run', () => {
    const { c } = controller();
    expect(() => c.void('p1', { reason: 'x' }, req())).toThrow('AdminAuthGuard did not run');
  });
});
