import type { Job } from 'bullmq';

import { upgradeLegacyJob } from './legacy-notification-job';

const job = (name: string, data: object) => ({ name, data }) as unknown as Job<object>;

describe('upgradeLegacyJob (D-149)', () => {
  it('should turn a queued single-user job of the previous release into a fan-out job', () => {
    const upgraded = upgradeLegacyJob(
      job('create-notification', {
        officeId: 'o1',
        requestId: null,
        userId: 'u1',
        type: 'SESSION_REMINDER',
        titleKey: 'shell.notifications.hearingReminder',
        params: {},
        link: '/calendar?session=s1',
      }),
    );
    expect(upgraded.name).toBe('fan-out-notification');
    expect(upgraded.data).toEqual({
      officeId: 'o1',
      requestId: null,
      userIds: ['u1'],
      type: 'HEARING_REMINDER',
      titleKey: 'shell.notifications.hearingReminder',
      params: {},
      link: '/calendar?session=s1',
    });
    // A type that was already UPPER_SNAKE keeps its name.
    expect(
      upgradeLegacyJob(job('create-notification', { userId: 'u1', type: 'DOCUMENT_FAILED' })).data,
    ).toMatchObject({
      type: 'DOCUMENT_FAILED',
    });
  });

  it('should leave every other job as it is', () => {
    const other = job('fan-out-notification', { userIds: ['u1'] });
    expect(upgradeLegacyJob(other)).toBe(other);
    expect(other.data).toEqual({ userIds: ['u1'] });
  });
});
