import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { notificationsApi } from './notifications.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-08T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown) => HttpResponse.json({ success: true, data, meta });
const ID = '01920000-0000-7000-8000-000000000001';
const NOTE = {
  id: ID,
  type: 'TASK_ASSIGNED',
  titleKey: 'common.notifications.taskAssigned',
  params: { title: 'Draft the reply' },
  link: '/tasks?task=1',
  readAt: null,
  createdAt: '2026-11-08T09:00:00.000Z',
};

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  notificationsApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 'access-1',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('notificationsApi (D-149)', () => {
  it('should list by cursor, count the unread ones and mark them read', async () => {
    let query = '';
    server.use(
      http.get(url('notifications'), ({ request }) => {
        query = new URL(request.url).search;
        return ok({ items: [NOTE], nextCursor: null });
      }),
      http.get(url('notifications/unread-count'), () => ok({ count: 3 })),
      http.post(url(`notifications/${ID}/read`), () =>
        ok({ ...NOTE, readAt: '2026-11-08T10:00:00.000Z' }),
      ),
      http.post(url('notifications/read-all'), () => ok({ count: 2 })),
    );
    await expect(api().list({ cursor: ID, unread: true, limit: 10 })).resolves.toEqual({
      items: [NOTE],
      nextCursor: null,
    });
    expect(new URLSearchParams(query).get('cursor')).toBe(ID);
    expect(new URLSearchParams(query).get('unread')).toBe('true');
    await expect(api().unreadCount()).resolves.toEqual({ count: 3 });
    await expect(api().markRead(ID)).resolves.toMatchObject({ readAt: '2026-11-08T10:00:00.000Z' });
    await expect(api().markAllRead()).resolves.toEqual({ count: 2 });
  });
});
