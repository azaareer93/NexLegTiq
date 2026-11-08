import { recipientsWanting, wants } from './notification-preferences';

describe('notification preferences (D-146)', () => {
  it('should deliver unless the category channel is turned off; unknown types and bad data are always on', () => {
    expect(wants({}, 'TASK_ASSIGNED', 'inApp')).toBe(true);
    expect(wants({ TASKS: { inApp: false } }, 'TASK_ASSIGNED', 'inApp')).toBe(false);
    expect(wants({ TASKS: { inApp: false } }, 'TASK_ASSIGNED', 'email')).toBe(true);
    expect(wants({ HEARINGS: { email: false } }, 'HEARING_REMINDER', 'email')).toBe(false);
    expect(wants({ FILES: { inApp: false } }, 'FILE_TEAM_ADDED', 'inApp')).toBe(false);
    expect(wants({ DOCUMENTS: { inApp: false } }, 'DOCUMENT_QUARANTINED', 'inApp')).toBe(true);
    expect(wants('not an object', 'TASK_ASSIGNED', 'inApp')).toBe(true);
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
      'INVITE_ACCEPTED',
      'inApp',
    );
    // c is not an active user of the office: left out, so it can never fail the write for the others.
    expect([...wanted].sort()).toEqual(['b']);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a', 'b', 'c'] }, isActive: true },
      select: { id: true, notificationPrefs: true },
    });
    // A type no one can turn off still goes to the active users only; nobody at all: no query.
    expect(
      await recipientsWanting({ user: { findMany } }, ['a', 'c'], 'DOCUMENT_QUARANTINED', 'inApp'),
    ).toEqual(new Set(['a', 'b']));
    findMany.mockClear();
    expect(await recipientsWanting({ user: { findMany } }, [], 'TASK_ASSIGNED', 'inApp')).toEqual(
      new Set(),
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
