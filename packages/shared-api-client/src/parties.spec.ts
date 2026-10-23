import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { partiesApi } from './parties.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, extra: object = {}) =>
  HttpResponse.json({ success: true, data, meta: { ...meta, ...extra } });

const FILE = '01920000-0000-7000-8000-0000000001f1';
const PARTY = {
  id: '01920000-0000-7000-8000-0000000009a1',
  isIndividual: true,
  name: 'Omar Haddad',
  fullName: 'Omar Haddad',
  companyName: null,
  phone: null,
  email: null,
};
const FILE_PARTY = {
  id: '01920000-0000-7000-8000-0000000009b1',
  partyType: 'DEFENDANT',
  roleLabel: null,
  joinedAt: '2026-10-02T09:00:00.000Z',
  party: {
    ...PARTY,
    nationalId: null,
    taxId: null,
    address: null,
    legalRepresentative: null,
    notes: null,
  },
};
const CONFLICT = {
  id: '01920000-0000-7000-8000-0000000009c1',
  reason: 'ADVERSE_ON_OTHER_FILE',
  party: { id: PARTY.id, name: PARTY.name },
  file: null,
  otherFile: null,
  detectedAt: '2026-10-05T09:00:00.000Z',
  resolved: false,
  resolutionNotes: null,
  resolvedAt: null,
};

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  partiesApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 'access-1',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('partiesApi (D-135)', () => {
  it('should search the registry, read and change a file’s parties and resolve conflicts', async () => {
    const seen: string[] = [];
    const record = (request: Request) => {
      const { pathname, search } = new URL(request.url);
      seen.push(`${request.method} ${pathname.replace('/api/v1/', '')}${search}`);
    };
    const result = { fileParty: FILE_PARTY, conflicts: [CONFLICT] };
    server.use(
      http.get(url('parties'), ({ request }) => (record(request), ok([PARTY]))),
      http.get(url(`cases/${FILE}/parties`), ({ request }) => (record(request), ok([FILE_PARTY]))),
      http.post(url(`cases/${FILE}/parties`), ({ request }) => (record(request), ok(result))),
      http.patch(
        url(`cases/${FILE}/parties/${FILE_PARTY.id}`),
        ({ request }) => (record(request), ok(result)),
      ),
      http.delete(
        url(`cases/${FILE}/parties/${FILE_PARTY.id}`),
        ({ request }) => (record(request), new HttpResponse(null, { status: 204 })),
      ),
      http.get(
        url('conflicts'),
        ({ request }) => (
          record(request),
          ok([CONFLICT], {
            pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false },
          })
        ),
      ),
      http.patch(
        url(`conflicts/${CONFLICT.id}/resolve`),
        ({ request }) => (record(request), ok({ ...CONFLICT, resolved: true })),
      ),
    );
    const parties = api();
    expect(await parties.search('Omar')).toEqual([PARTY]);
    expect(await parties.forFile(FILE)).toEqual([FILE_PARTY]);
    expect(
      (await parties.add(FILE, { partyId: PARTY.id, partyType: 'DEFENDANT' })).conflicts,
    ).toHaveLength(1);
    await parties.update(FILE, FILE_PARTY.id, { roleLabel: null });
    await parties.remove(FILE, FILE_PARTY.id);
    expect((await parties.conflicts({ fileId: FILE, resolved: 'false' })).pagination.total).toBe(1);
    expect((await parties.resolve(CONFLICT.id, 'Consented')).resolved).toBe(true);
    expect(seen).toEqual([
      'GET parties?search=Omar',
      `GET cases/${FILE}/parties`,
      `POST cases/${FILE}/parties`,
      `PATCH cases/${FILE}/parties/${FILE_PARTY.id}`,
      `DELETE cases/${FILE}/parties/${FILE_PARTY.id}`,
      `GET conflicts?fileId=${FILE}&resolved=false`,
      `PATCH conflicts/${CONFLICT.id}/resolve`,
    ]);
  });
});
