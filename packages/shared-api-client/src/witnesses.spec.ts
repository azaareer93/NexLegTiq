import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { witnessesApi } from './witnesses.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const ok = (data: unknown) =>
  HttpResponse.json({
    success: true,
    data,
    meta: { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' },
  });

const FILE = '01920000-0000-7000-8000-0000000001f1';
const WITNESS = {
  id: '01920000-0000-7000-8000-0000000008a1',
  fileId: FILE,
  fullName: 'Nadia Khalil',
  isExpert: false,
  expertiseArea: null,
  phone: null,
  email: null,
  address: null,
  notes: null,
  statementCount: 1,
  createdAt: '2026-10-02T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
};
const STATEMENT = {
  id: '01920000-0000-7000-8000-0000000008b1',
  witnessId: WITNESS.id,
  statementDate: '2026-10-03',
  text: 'I saw the fence.',
  isUnderOath: true,
  recordedBy: { id: '01920000-0000-7000-8000-0000000000a1', fullName: 'Sami Nasser' },
  session: null,
  createdAt: '2026-10-03T09:00:00.000Z',
  updatedAt: '2026-10-03T09:00:00.000Z',
};

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  witnessesApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 'access-1',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('witnessesApi (D-163)', () => {
  it('should read and change a file’s witnesses and their statements', async () => {
    const seen: string[] = [];
    const rec =
      (data: unknown, empty = false) =>
      ({ request }: { request: Request }) => {
        seen.push(`${request.method} ${new URL(request.url).pathname.replace('/api/v1/', '')}`);
        return empty ? new HttpResponse(null, { status: 204 }) : ok(data);
      };
    const w = `cases/${FILE}/witnesses`;
    const s = `witnesses/${WITNESS.id}/statements`;
    server.use(
      http.get(url(w), rec([WITNESS])),
      http.post(url(w), rec(WITNESS)),
      http.patch(url(`${w}/${WITNESS.id}`), rec(WITNESS)),
      http.delete(url(`${w}/${WITNESS.id}`), rec(null, true)),
      http.get(url(s), rec([STATEMENT])),
      http.post(url(s), rec(STATEMENT)),
      http.patch(url(`${s}/${STATEMENT.id}`), rec(STATEMENT)),
      http.delete(url(`${s}/${STATEMENT.id}`), rec(null, true)),
    );
    const witnesses = api();
    expect(await witnesses.forFile(FILE)).toEqual([WITNESS]);
    await witnesses.create(FILE, { fullName: 'Nadia Khalil' });
    await witnesses.update(FILE, WITNESS.id, { phone: null });
    await witnesses.remove(FILE, WITNESS.id);
    expect(await witnesses.statements(WITNESS.id)).toEqual([STATEMENT]);
    await witnesses.addStatement(WITNESS.id, { statementDate: '2026-10-03', text: 'x' });
    await witnesses.updateStatement(WITNESS.id, STATEMENT.id, { isUnderOath: false });
    await witnesses.removeStatement(WITNESS.id, STATEMENT.id);
    expect(seen).toEqual([
      `GET ${w}`,
      `POST ${w}`,
      `PATCH ${w}/${WITNESS.id}`,
      `DELETE ${w}/${WITNESS.id}`,
      `GET ${s}`,
      `POST ${s}`,
      `PATCH ${s}/${STATEMENT.id}`,
      `DELETE ${s}/${STATEMENT.id}`,
    ]);
  });
});
