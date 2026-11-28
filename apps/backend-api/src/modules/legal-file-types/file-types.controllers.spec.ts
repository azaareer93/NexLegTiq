import { LegalFileTypesController } from './legal-file-types.controller';
import { PlatformFileTypesController } from './platform-file-types.controller';

function controller(active = false) {
  const types = {
    list: jest.fn().mockResolvedValue(['t']),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    createSubType: jest.fn().mockResolvedValue('sub-created'),
    updateSubType: jest.fn().mockResolvedValue('sub-updated'),
  };
  const cls = {
    isActive: jest.fn().mockReturnValue(active),
    getId: jest.fn().mockReturnValue('req-1'),
  };
  return { c: new PlatformFileTypesController(types as never, cls as never), types };
}
const req = (id?: string) =>
  ({ platformAdminId: id, ip: '1.2.3.4', get: () => undefined }) as never;

describe('PlatformFileTypesController', () => {
  it('should pass every call to the service with the admin and the request id', async () => {
    const { c, types } = controller(true);
    await expect(c.list({ jurisdiction: 'KUWAIT' })).resolves.toEqual(['t']);
    await expect(c.create({ code: 'FAMILY' } as never, req('a1'))).resolves.toBe('created');
    await expect(c.update('t1', { isActive: false }, req('a1'))).resolves.toBe('updated');
    await expect(c.createSubType('t1', { nameAr: 'أ', nameEn: 'A' }, req('a1'))).resolves.toBe(
      'sub-created',
    );
    await expect(c.updateSubType('s1', { sortOrder: 1 }, req('a1'))).resolves.toBe('sub-updated');
    expect(types.create).toHaveBeenCalledWith(
      { code: 'FAMILY' },
      'a1',
      expect.objectContaining({ requestId: 'req-1' }),
    );
    expect(types.updateSubType).toHaveBeenCalledWith(
      's1',
      { sortOrder: 1 },
      'a1',
      expect.anything(),
    );
  });

  it('should fail loudly when the admin guard did not run', () => {
    const { c } = controller();
    expect(() => c.update('t1', { isActive: false }, req())).toThrow('AdminAuthGuard did not run');
  });
});

describe('LegalFileTypesController', () => {
  it("should list the office's types", async () => {
    const types = { list: jest.fn().mockResolvedValue([]) };
    await expect(new LegalFileTypesController(types as never).list()).resolves.toEqual([]);
  });
});
