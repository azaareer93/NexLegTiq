import { isAppPath, NotificationQuerySchema, NotificationSchema } from './notification.contract.js';
import { REALTIME_EVENTS, RealtimePayloadSchemas } from './realtime.contract.js';

const ID = '01920000-0000-7000-8000-000000000001';

describe('notification contracts (D-149)', () => {
  it('should read the list query with its defaults and refuse a malformed cursor', () => {
    expect(NotificationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(NotificationQuerySchema.parse({ cursor: ID, unread: 'true', limit: '5' })).toEqual({
      cursor: ID,
      unread: true,
      limit: 5,
    });
    expect(NotificationQuerySchema.safeParse({ cursor: 'x' }).success).toBe(false);
    expect(NotificationQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });

  it('should read any stored type, so a newer server never breaks the list', () => {
    const note = {
      id: ID,
      type: 'TASK_ASSIGNED',
      titleKey: 'common.notifications.taskAssigned',
      params: { title: 'Draft the reply' },
      link: null,
      readAt: null,
      createdAt: '2026-11-08T10:00:00.000Z',
    };
    expect(NotificationSchema.parse(note)).toEqual(note);
    expect(NotificationSchema.parse({ ...note, type: 'SOMETHING_NEW' }).type).toBe('SOMETHING_NEW');
  });

  it('should accept only paths of this app as links', () => {
    expect(isAppPath('/cases/1?tab=documents')).toBe(true);
    for (const bad of [
      '//evil.test',
      '/\\evil.test',
      '/\t/evil.test',
      'https://evil.test',
      'cases',
      '/a b',
    ]) {
      expect(isAppPath(bad)).toBe(false);
    }
    expect(isAppPath(`/${'a'.repeat(500)}`)).toBe(false);
  });

  it('should push only the id of a new notification', () => {
    expect(REALTIME_EVENTS).toContain('notification');
    expect(RealtimePayloadSchemas.notification.parse({ notificationId: ID })).toEqual({
      notificationId: ID,
    });
    expect(RealtimePayloadSchemas.notification.safeParse({ notificationId: 'x' }).success).toBe(
      false,
    );
  });
});
