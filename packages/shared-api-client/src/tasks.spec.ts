import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { tasksApi } from './tasks.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, extra: object = {}) =>
  HttpResponse.json({ success: true, data, meta: { ...meta, ...extra } });

const PERSON = { id: '01920000-0000-7000-8000-0000000000a1', fullName: 'Omar Haddad' };
const TASK = {
  id: '01920000-0000-7000-8000-0000000007a1',
  title: 'File the brief',
  description: null,
  file: null,
  dueDate: '2026-10-30',
  priority: 'MEDIUM',
  status: 'TODO',
  assignedTo: PERSON,
  createdBy: PERSON,
  completedAt: null,
  sortOrder: 0,
  createdAt: '2026-10-05T09:00:00.000Z',
  updatedAt: '2026-10-05T09:00:00.000Z',
};
const PAGE = { pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false } };

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  tasksApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 'access-1',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('tasksApi (D-098)', () => {
  it('should list, create, edit, move, reorder and delete tasks', async () => {
    const seen: string[] = [];
    const record = async (request: Request) => {
      const { pathname, search } = new URL(request.url);
      const body = await request.text();
      seen.push(`${request.method} ${pathname.replace('/api/v1/', '')}${search} ${body}`.trim());
    };
    const noContent = () => new HttpResponse(null, { status: 204 });
    const done = { ...TASK, status: 'DONE', completedAt: '2026-10-06T09:00:00.000Z' };
    server.use(
      http.get(url('tasks'), async ({ request }) => (await record(request), ok([TASK], PAGE))),
      http.post(url('tasks'), async ({ request }) => (await record(request), ok(TASK))),
      http.patch(url('tasks/reorder'), async ({ request }) => (await record(request), noContent())),
      http.patch(url(`tasks/${TASK.id}`), async ({ request }) => (await record(request), ok(TASK))),
      http.patch(
        url(`tasks/${TASK.id}/status`),
        async ({ request }) => (await record(request), ok(done)),
      ),
      http.delete(
        url(`tasks/${TASK.id}`),
        async ({ request }) => (await record(request), noContent()),
      ),
    );
    const tasks = api();
    expect((await tasks.list({ assignee: 'me', status: 'TODO' })).items).toEqual([TASK]);
    expect(await tasks.create({ title: TASK.title, priority: 'MEDIUM' })).toEqual(TASK);
    await tasks.update(TASK.id, { description: null });
    expect((await tasks.changeStatus(TASK.id, 'DONE')).status).toBe('DONE');
    await tasks.reorder('TODO', [TASK.id]);
    await tasks.remove(TASK.id);
    expect(seen).toEqual([
      'GET tasks?assignee=me&status=TODO',
      'POST tasks {"title":"File the brief","priority":"MEDIUM"}',
      `PATCH tasks/${TASK.id} {"description":null}`,
      `PATCH tasks/${TASK.id}/status {"status":"DONE"}`,
      `PATCH tasks/reorder {"status":"TODO","taskIds":["${TASK.id}"]}`,
      `DELETE tasks/${TASK.id}`,
    ]);
  });
});
