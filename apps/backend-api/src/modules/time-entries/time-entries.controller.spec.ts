import { CaseTimeTotalsController, TimeEntriesController } from './time-entries.controller';
import type { TimeEntriesService } from './time-entries.service';
import type { TimerService } from './time-timer.service';

const ID = '01920000-0000-7000-8000-000000000001';

/** The controllers only hand over to the services (D-152): every route reaches its method with its input. */
describe('time entries controllers', () => {
  it('should pass each route to its service', async () => {
    const time = {
      list: jest.fn().mockResolvedValue('list'),
      create: jest.fn().mockResolvedValue('created'),
      get: jest.fn().mockResolvedValue('entry'),
      update: jest.fn().mockResolvedValue('updated'),
      remove: jest.fn().mockResolvedValue(undefined),
      totals: jest.fn().mockResolvedValue('totals'),
    };
    const timers = {
      timer: jest.fn().mockResolvedValue(null),
      start: jest.fn().mockResolvedValue('started'),
      stop: jest.fn().mockResolvedValue('stopped'),
    };
    const entries = new TimeEntriesController(
      time as unknown as TimeEntriesService,
      timers as unknown as TimerService,
    );
    const query = { page: 1, limit: 20 };
    await expect(entries.list(query)).resolves.toBe('list');
    await expect(
      entries.create({ fileId: ID, durationHours: '1', description: 'Call' }),
    ).resolves.toBe('created');
    await expect(entries.get(ID)).resolves.toBe('entry');
    await expect(entries.update(ID, { description: 'x' })).resolves.toBe('updated');
    await entries.remove(ID);
    await expect(entries.timer()).resolves.toBeNull();
    await expect(entries.start({ fileId: ID })).resolves.toBe('started');
    await expect(entries.stop({})).resolves.toBe('stopped');
    await expect(
      new CaseTimeTotalsController(time as unknown as TimeEntriesService).totals(ID),
    ).resolves.toBe('totals');
    expect(time.remove).toHaveBeenCalledWith(ID);
    expect(time.list).toHaveBeenCalledWith(query);
  });
});
