import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { adminCourtsApi } from './admin-courts.js';
import { createApiClient } from './api-client.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-28T10:00:00.000Z', requestId: 'req-12345678' };
const pagination = { page: 1, limit: 50, total: 1, totalPages: 1, hasMore: false };
const ID = '01920000-0000-7000-8000-000000000001';
const TARGET = '01920000-0000-7000-8000-000000000002';

const court = {
  id: ID,
  jurisdiction: 'PALESTINE',
  courtType: 'MAGISTRATE',
  nameAr: 'محكمة صلح يطا',
  nameEn: 'Yatta Magistrate Court',
  city: null,
  address: null,
  phone: null,
  email: null,
  isPlatform: true,
  isActive: true,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};
const officeCourt = {
  ...court,
  isPlatform: false,
  officeId: TARGET,
  officeName: 'مكتب',
  fileCount: 1,
  sessionCount: 0,
  judgeCount: 0,
};
const report = {
  id: ID,
  name: 'محكمة صلح يطا',
  city: null,
  note: null,
  status: 'PENDING',
  createdAt: '2026-11-01T10:00:00.000Z',
  officeId: TARGET,
  officeName: 'مكتب',
  jurisdiction: 'PALESTINE',
  reportedByName: 'محامي',
  courtId: null,
  dismissReason: null,
  resolvedAt: null,
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  adminCourtsApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'admin',
      getToken: () => 'admin-access',
      setToken: () => undefined,
      onAuthFailure: vi.fn(),
    }),
  );

describe('adminCourtsApi', () => {
  it('should reach every admin court route with its body and query', async () => {
    const calls: string[] = [];
    const answer = (data: unknown) => HttpResponse.json({ success: true, data, meta });
    const page = (data: unknown) =>
      HttpResponse.json({ success: true, data, meta: { ...meta, pagination } });
    const record =
      (data: unknown) =>
      async ({ request }: { request: Request }) => {
        const body = request.method === 'GET' ? '' : JSON.stringify(await request.json());
        calls.push(`${request.method} ${new URL(request.url).pathname.slice(8)}${body}`);
        return answer(data);
      };
    server.use(
      http.get(url('admin/courts'), ({ request }) => {
        calls.push(`GET admin/courts${new URL(request.url).search}`);
        return page([court]);
      }),
      http.post(url('admin/courts'), record(court)),
      http.patch(url(`admin/courts/${ID}`), record(court)),
      http.get(url('admin/office-courts'), () => page([officeCourt])),
      http.post(
        url(`admin/office-courts/${ID}/replace`),
        record({ courtId: TARGET, files: 1, sessions: 0, judges: 0 }),
      ),
      http.post(url(`admin/office-courts/${ID}/promote`), record(court)),
      http.get(url('admin/court-reports'), () => page([report])),
      http.post(url(`admin/court-reports/${ID}/add`), record({ ...report, status: 'ADDED' })),
      http.post(
        url(`admin/court-reports/${ID}/dismiss`),
        record({ ...report, status: 'DISMISSED' }),
      ),
    );
    expect((await api().list({ jurisdiction: 'PALESTINE' })).items).toHaveLength(1);
    await api().create({
      jurisdiction: 'PALESTINE',
      courtType: 'MAGISTRATE',
      nameAr: 'م',
      nameEn: 'M',
    });
    await api().update(ID, { isActive: false });
    expect((await api().officeCourts({})).items[0]?.officeName).toBe('مكتب');
    expect((await api().replace(ID, TARGET)).files).toBe(1);
    await api().promote(ID, { nameEn: 'M' });
    expect((await api().reports({ status: 'PENDING' })).items).toHaveLength(1);
    await api().addReported(ID, { courtType: 'MAGISTRATE', nameAr: 'م', nameEn: 'M' });
    expect((await api().dismiss(ID, {})).status).toBe('DISMISSED');
    expect(calls).toEqual([
      'GET admin/courts?jurisdiction=PALESTINE',
      'POST admin/courts{"jurisdiction":"PALESTINE","courtType":"MAGISTRATE","nameAr":"م","nameEn":"M"}',
      `PATCH admin/courts/${ID}{"isActive":false}`,
      `POST admin/office-courts/${ID}/replace{"courtId":"${TARGET}"}`,
      `POST admin/office-courts/${ID}/promote{"nameEn":"M"}`,
      `POST admin/court-reports/${ID}/add{"courtType":"MAGISTRATE","nameAr":"م","nameEn":"M"}`,
      `POST admin/court-reports/${ID}/dismiss{}`,
    ]);
  });
});
