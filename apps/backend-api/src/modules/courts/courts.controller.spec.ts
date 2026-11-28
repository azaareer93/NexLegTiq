import { CourtsController } from './courts.controller';
import { ProsecutorsController } from './prosecutors.controller';

const req = { ip: '1.2.3.4', get: () => undefined } as never;
const cls = (active: boolean) => ({
  isActive: jest.fn().mockReturnValue(active),
  getId: jest.fn().mockReturnValue('req-1'),
});

describe('CourtsController', () => {
  it('should pass reads and judge writes to the service, with the request id when there is one', async () => {
    const courts = {
      list: jest.fn().mockResolvedValue('list'),
      get: jest.fn().mockResolvedValue('court'),
      listJudges: jest.fn().mockResolvedValue('judges'),
      createJudge: jest.fn().mockResolvedValue('judge'),
      updateJudge: jest.fn().mockResolvedValue('updated'),
      removeJudge: jest.fn().mockResolvedValue(undefined),
    };
    for (const active of [true, false]) {
      const c = new CourtsController(courts as never, cls(active) as never);
      await expect(c.list({ page: 1, limit: 20 })).resolves.toBe('list');
      await expect(c.get('c1')).resolves.toBe('court');
      await expect(c.listJudges('c1')).resolves.toBe('judges');
      await expect(c.createJudge('c1', { fullName: 'ق' }, req)).resolves.toBe('judge');
      await expect(c.updateJudge('c1', 'j1', { isActive: false }, req)).resolves.toBe('updated');
      await c.removeJudge('c1', 'j1', req);
    }
    expect(courts.createJudge.mock.calls[0]?.[2]).toMatchObject({ requestId: 'req-1' });
    expect(courts.createJudge.mock.calls[1]?.[2]).toMatchObject({ requestId: null });
  });
});

describe('ProsecutorsController', () => {
  it('should pass every call to the service, with the request id when there is one', async () => {
    const prosecutors = {
      list: jest.fn().mockResolvedValue('list'),
      get: jest.fn().mockResolvedValue('one'),
      create: jest.fn().mockResolvedValue('created'),
      update: jest.fn().mockResolvedValue('updated'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    for (const active of [true, false]) {
      const c = new ProsecutorsController(prosecutors as never, cls(active) as never);
      await expect(c.list({ page: 1, limit: 20 })).resolves.toBe('list');
      await expect(c.get('p1')).resolves.toBe('one');
      await expect(c.create({ fullName: 'و' }, req)).resolves.toBe('created');
      await expect(c.update('p1', { fullName: 'و' }, req)).resolves.toBe('updated');
      await c.remove('p1', req);
    }
    expect(prosecutors.create.mock.calls[1]?.[1]).toMatchObject({ requestId: null });
  });
});
