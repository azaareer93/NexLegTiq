import { recipientsWanting, wants } from './notification-preferences';

describe('notification preferences (D-146)', () => {
  it('should deliver unless the category channel is turned off; unknown types and bad data are always on', () => {
    expect(wants({}, 'task.assigned', 'inApp')).toBe(true);
    expect(wants({ TASKS: { inApp: false } }, 'task.assigned', 'inApp')).toBe(false);
    expect(wants({ TASKS: { inApp: false } }, 'task.assigned', 'email')).toBe(true);
    expect(wants({ HEARINGS: { email: false } }, 'SESSION_REMINDER', 'email')).toBe(false);
    expect(wants({ FILES: { inApp: false } }, 'file.teamAdded', 'inApp')).toBe(false);
    expect(wants({ TASKS: { inApp: false } }, 'something.else', 'inApp')).toBe(true);
    expect(wants('not an object', 'task.assigned', 'inApp')).toBe(true);
    expect(wants(null, 'DOCUMENT_FAILED', 'inApp')).toBe(true);
  });

  it('should keep the recipients who want it, in one query', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'a', notificationPrefs: { TEAM: { inApp: false } } },
      { id: 'b', notificationPrefs: {} },
    ]);
    const wanted = await recipientsWanting(
      { user: { findMany } },
      ['a', 'b', 'c'],
      'invitation.accepted',
      'inApp',
    );
    expect([...wanted].sort()).toEqual(['b', 'c']);
    expect(findMany).toHaveBeenCalledTimes(1);
    // Nobody, or a type no one can turn off: no query at all.
    findMany.mockClear();
    expect(await recipientsWanting({ user: { findMany } }, [], 'task.assigned', 'inApp')).toEqual(
      new Set(),
    );
    expect(await recipientsWanting({ user: { findMany } }, ['a'], 'other', 'inApp')).toEqual(
      new Set(['a']),
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
