import { NotificationQuerySchema, NotificationSchema } from './notification.contract.js';
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

  it('should accept only the known notification types', () => {
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
    expect(NotificationSchema.safeParse({ ...note, type: 'task.assigned' }).success).toBe(false);
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
