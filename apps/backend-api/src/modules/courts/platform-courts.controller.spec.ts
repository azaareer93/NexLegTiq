import { CourtReportsController } from './court-reports.controller';
import { PlatformCourtsController } from './platform-courts.controller';

const cls = (active: boolean) => ({
  isActive: jest.fn().mockReturnValue(active),
  getId: jest.fn().mockReturnValue('req-1'),
});
const req = (id?: string) =>
  ({ platformAdminId: id, ip: '1.2.3.4', get: () => undefined }) as never;

function controller(active = false) {
  const courts = {
    list: jest.fn().mockResolvedValue('list'),
    create: jest.fn().mockResolvedValue('created'),
    update: jest.fn().mockResolvedValue('updated'),
    listOfficeCourts: jest.fn().mockResolvedValue('office-courts'),
    replace: jest.fn().mockResolvedValue('replaced'),
    promote: jest.fn().mockResolvedValue('promoted'),
  };
  const reports = {
    list: jest.fn().mockResolvedValue('reports'),
    add: jest.fn().mockResolvedValue('added'),
    dismiss: jest.fn().mockResolvedValue('dismissed'),
  };
  return {
    c: new PlatformCourtsController(courts as never, reports as never, cls(active) as never),
    courts,
    reports,
  };
}

describe('PlatformCourtsController', () => {
  it('should pass every call to its service with the admin and the request id', async () => {
    const { c, courts, reports } = controller(true);
    const r = req('a1');
    await expect(c.list({} as never)).resolves.toBe('list');
    await expect(c.create({} as never, r)).resolves.toBe('created');
    await expect(c.update('c1', {} as never, r)).resolves.toBe('updated');
    await expect(c.listOfficeCourts({} as never)).resolves.toBe('office-courts');
    await expect(c.replace('c1', { courtId: 'p1' }, r)).resolves.toBe('replaced');
    await expect(c.promote('c1', {}, r)).resolves.toBe('promoted');
    await expect(c.listReports({} as never)).resolves.toBe('reports');
    await expect(c.addReported('r1', {} as never, r)).resolves.toBe('added');
    await expect(c.dismiss('r1', {}, r)).resolves.toBe('dismissed');
    expect(courts.replace).toHaveBeenCalledWith(
      'c1',
      'p1',
      'a1',
      expect.objectContaining({ requestId: 'req-1' }),
    );
    expect(reports.dismiss).toHaveBeenCalledWith('r1', {}, 'a1', expect.anything());
  });

  it('should fail loudly when the admin guard did not run', () => {
    const { c } = controller();
    expect(() => c.promote('c1', {}, req())).toThrow('AdminAuthGuard did not run');
  });
});

describe('CourtReportsController', () => {
  it('should record a report with the request facts, inside and outside a request context', async () => {
    const reports = { report: jest.fn().mockResolvedValue('reported') };
    for (const active of [true, false]) {
      const c = new CourtReportsController(reports as never, cls(active) as never);
      await expect(c.report({ name: 'م' }, req())).resolves.toBe('reported');
    }
    expect(reports.report).toHaveBeenCalledWith(
      { name: 'م' },
      expect.objectContaining({ requestId: 'req-1' }),
    );
  });
});
