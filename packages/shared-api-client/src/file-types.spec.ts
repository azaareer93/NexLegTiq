import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { adminFileTypesApi, fileTypesApi } from './file-types.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-11-28T10:00:00.000Z', requestId: 'req-12345678' };
const ID = '01920000-0000-7000-8000-000000000001';
const SUB = '01920000-0000-7000-8000-000000000002';

const type = {
  id: ID,
  jurisdiction: 'PALESTINE',
  code: 'LITIGATION',
  numberCode: 'LIT',
  nameAr: 'تقاضٍ',
  nameEn: 'Litigation',
  sortOrder: 10,
  isActive: true,
  subTypes: [
    {
      id: SUB,
      nameAr: 'عمالي',
      nameEn: 'Labour',
      sortOrder: 0,
      isActive: true,
      updatedAt: '2026-11-28T10:00:00.000Z',
    },
  ],
  updatedAt: '2026-11-28T10:00:00.000Z',
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = (realm: 'admin' | 'office') =>
  createApiClient({
    baseURL: ORIGIN,
    realm,
    getToken: () => 'access',
    setToken: () => undefined,
    onAuthFailure: vi.fn(),
  });
const answer = (data: unknown) => HttpResponse.json({ success: true, data, meta });

describe('fileTypesApi', () => {
  it("should list the office country's types", async () => {
    server.use(
      http.get(url('file-types'), () =>
        answer([{ code: 'LITIGATION', nameAr: 'تقاضٍ', nameEn: 'Litigation', subTypes: [] }]),
      ),
    );
    expect(await fileTypesApi(client('office')).list()).toEqual([
      { code: 'LITIGATION', nameAr: 'تقاضٍ', nameEn: 'Litigation', subTypes: [] },
    ]);
  });
});

describe('adminFileTypesApi', () => {
  it('should list a country and create and update types and sub-types', async () => {
    const calls: string[] = [];
    const record = async (request: Request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
      return answer(type);
    };
    server.use(
      http.get(url('admin/file-types'), ({ request }) => {
        calls.push(`GET ${new URL(request.url).search}`);
        return answer([type]);
      }),
      http.post(url('admin/file-types'), ({ request }) => record(request)),
      http.patch(url(`admin/file-types/${ID}`), ({ request }) => record(request)),
      http.post(url(`admin/file-types/${ID}/sub-types`), ({ request }) => record(request)),
      http.patch(url(`admin/file-sub-types/${SUB}`), ({ request }) => record(request)),
    );
    const api = adminFileTypesApi(client('admin'));
    expect(await api.list('JORDAN')).toHaveLength(1);
    await api.create({ code: 'FAMILY' } as never);
    await api.update(ID, { isActive: false });
    await api.createSubType(ID, { nameAr: 'أ', nameEn: 'A' });
    await api.updateSubType(SUB, { sortOrder: 2 });
    expect(calls).toEqual([
      'GET ?jurisdiction=JORDAN',
      'POST /api/v1/admin/file-types {"code":"FAMILY"}',
      `PATCH /api/v1/admin/file-types/${ID} {"isActive":false}`,
      `POST /api/v1/admin/file-types/${ID}/sub-types {"nameAr":"أ","nameEn":"A"}`,
      `PATCH /api/v1/admin/file-sub-types/${SUB} {"sortOrder":2}`,
    ]);
  });
});
