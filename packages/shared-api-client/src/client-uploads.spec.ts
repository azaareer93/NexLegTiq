import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { clientUploadsApi } from './client-uploads.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown) => HttpResponse.json({ success: true, data, meta });

const FILE = '01920000-0000-7000-8000-0000000001f1';
const UPLOAD = {
  id: '01920000-0000-7000-8000-0000000009a1',
  fileId: FILE,
  name: 'عقد.pdf',
  mimeType: 'application/pdf',
  sizeBytes: '4',
  status: 'PENDING_REVIEW',
  rejectionReason: null,
  createdAt: '2026-10-05T09:00:00.000Z',
  client: { id: '01920000-0000-7000-8000-0000000000c1', displayName: 'ليلى' },
  uploaderName: 'ليلى',
  reviewedBy: null,
  reviewedAt: null,
  documentId: null,
};

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  clientUploadsApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 'access-1',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('clientUploadsApi (MVP-99)', () => {
  it('should list, link, accept and reject', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get(url(`cases/${FILE}/client-uploads`), () => ok([UPLOAD])),
      http.get(url(`client-uploads/${UPLOAD.id}/download`), () =>
        ok({ downloadUrl: 'https://files.test/x', expiresIn: 300 }),
      ),
      http.post(url(`client-uploads/${UPLOAD.id}/accept`), async ({ request }) => {
        bodies.push(await request.json());
        return ok({ ...UPLOAD, status: 'ACCEPTED' });
      }),
      http.post(url(`client-uploads/${UPLOAD.id}/reject`), async ({ request }) => {
        bodies.push(await request.json());
        return ok({ ...UPLOAD, status: 'REJECTED', rejectionReason: 'x' });
      }),
    );
    expect(await api().forFile(FILE)).toHaveLength(1);
    expect((await api().downloadLink(UPLOAD.id)).downloadUrl).toBe('https://files.test/x');
    expect((await api().accept(UPLOAD.id, { documentType: 'EVIDENCE' })).status).toBe('ACCEPTED');
    expect((await api().reject(UPLOAD.id, { reason: 'x' })).status).toBe('REJECTED');
    expect(bodies).toEqual([{ documentType: 'EVIDENCE' }, { reason: 'x' }]);
  });
});
