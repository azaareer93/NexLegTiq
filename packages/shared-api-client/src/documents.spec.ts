import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { documentsApi, foldersApi } from './documents.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown, extra: object = {}) =>
  HttpResponse.json({ success: true, data, meta: { ...meta, ...extra } });

const FILE = '01920000-0000-7000-8000-0000000001f1';
const FOLDER = {
  id: '01920000-0000-7000-8000-0000000008a1',
  fileId: FILE,
  parentId: null,
  name: 'Drafts',
  systemKey: null,
  documentCount: 1,
  createdAt: '2026-10-05T09:00:00.000Z',
  updatedAt: '2026-10-05T09:00:00.000Z',
};
const DOC = {
  id: '01920000-0000-7000-8000-0000000008b1',
  fileId: FILE,
  folderId: FOLDER.id,
  sessionId: null,
  name: 'عقد.pdf',
  originalFilename: 'عقد.pdf',
  documentType: 'OTHER',
  mimeType: 'application/pdf',
  sizeBytes: 4,
  currentVersion: 1,
  status: 'FAILED',
  ocrStatus: 'FAILED',
  processingErrorCode: 'EXT-002',
  language: null,
  isConfidential: false,
  sharedWithClient: false,
  uploadedBy: { id: '01920000-0000-7000-8000-0000000000a1', fullName: 'Omar Haddad' },
  createdAt: '2026-10-05T09:00:00.000Z',
  updatedAt: '2026-10-05T09:00:00.000Z',
};
const PAGE = { pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false } };

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = () =>
  createApiClient({
    baseURL: ORIGIN,
    realm: 'office',
    getToken: () => 'access-1',
    setToken: () => undefined,
    onAuthFailure: () => undefined,
  });

describe('documentsApi and foldersApi (D-119, D-126, D-128, D-132)', () => {
  it('should send the upload fields before the file, with the idempotency key', async () => {
    let fields: string[] = [];
    let fileName: string | undefined;
    let key: string | null = null;
    server.use(
      http.post(url('documents'), async ({ request }) => {
        key = request.headers.get('Idempotency-Key');
        const form = await request.formData();
        fields = [...form.keys()];
        const file = form.get('file');
        fileName = file instanceof File ? file.name : undefined;
        return ok({ documentId: DOC.id, versionNumber: 1, status: 'SCANNING' });
      }),
    );
    const answer = await documentsApi(client()).upload(
      {
        fileId: FILE,
        file: new Blob(['%PDF']),
        filename: 'عقد.pdf',
        documentType: 'OTHER',
        folderId: FOLDER.id,
      },
      { idempotencyKey: 'upload-key-1', onProgress: () => undefined },
    );
    expect(answer.status).toBe('SCANNING');
    expect(fields).toEqual(['fileId', 'documentType', 'folderId', 'file']);
    expect(fileName).toBe('عقد.pdf');
    expect(key).toBe('upload-key-1');
  });

  it('should list, edit, retry and delete documents and manage folders', async () => {
    const seen: string[] = [];
    const record = (request: Request) => {
      const { pathname, search } = new URL(request.url);
      seen.push(`${request.method} ${pathname.replace('/api/v1/', '')}${search}`);
    };
    server.use(
      http.get(url(`cases/${FILE}/documents`), ({ request }) => (record(request), ok([DOC], PAGE))),
      http.patch(url(`documents/${DOC.id}`), ({ request }) => (record(request), ok(DOC))),
      http.post(
        url(`documents/${DOC.id}/ocr/retry`),
        ({ request }) => (record(request), ok({ ...DOC, status: 'PROCESSING' })),
      ),
      http.delete(
        url(`documents/${DOC.id}`),
        ({ request }) => (record(request), new HttpResponse(null, { status: 204 })),
      ),
      http.get(url(`cases/${FILE}/folders`), ({ request }) => (record(request), ok([FOLDER]))),
      http.post(url(`cases/${FILE}/folders`), ({ request }) => (record(request), ok(FOLDER))),
      http.patch(
        url(`cases/${FILE}/folders/${FOLDER.id}`),
        ({ request }) => (record(request), ok(FOLDER)),
      ),
    );
    const documents = documentsApi(client());
    const folders = foldersApi(client());
    expect((await documents.forFile(FILE, { folderId: 'root' })).items).toEqual([DOC]);
    await documents.update(DOC.id, { name: 'contract.pdf' });
    expect((await documents.retry(DOC.id)).status).toBe('PROCESSING');
    await documents.remove(DOC.id);
    expect(await folders.list(FILE)).toEqual([FOLDER]);
    await folders.create(FILE, { name: 'Drafts' });
    await folders.update(FILE, FOLDER.id, { name: 'Drafts 2' });
    expect(seen).toEqual([
      `GET cases/${FILE}/documents?folderId=root`,
      `PATCH documents/${DOC.id}`,
      `POST documents/${DOC.id}/ocr/retry`,
      `DELETE documents/${DOC.id}`,
      `GET cases/${FILE}/folders`,
      `POST cases/${FILE}/folders`,
      `PATCH cases/${FILE}/folders/${FOLDER.id}`,
    ]);
  });

  it('should read a document, its versions, a download link and its text, and upload a version', async () => {
    const version = {
      versionNumber: 2,
      originalFilename: 'عقد-معدل.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      checksumSha256: 'a'.repeat(64),
      changeNote: 'توقيع',
      createdBy: DOC.uploadedBy,
      createdAt: '2026-10-06T09:00:00.000Z',
    };
    let textPage: string | null = null;
    let versionFields: string[] = [];
    server.use(
      http.get(url(`documents/${DOC.id}`), () => ok(DOC)),
      http.get(url(`documents/${DOC.id}/versions`), () => ok([version])),
      http.get(url(`documents/${DOC.id}/download`), () =>
        ok({ downloadUrl: 'https://storage.test/o/1', expiresIn: 300 }),
      ),
      http.get(url(`documents/${DOC.id}/text`), ({ request }) => {
        textPage = new URL(request.url).searchParams.get('page');
        return ok({ versionNumber: 2, ocrStatus: 'DONE', page: 2, totalPages: 3, text: 'نص' });
      }),
      http.post(url(`documents/${DOC.id}/versions`), async ({ request }) => {
        versionFields = [...(await request.formData()).keys()];
        return HttpResponse.json(
          {
            success: true,
            data: { documentId: DOC.id, versionNumber: 2, status: 'SCANNING' },
            meta,
          },
          { status: 202 },
        );
      }),
    );
    const api = documentsApi(client());
    await expect(api.get(DOC.id)).resolves.toMatchObject({ id: DOC.id });
    await expect(api.versions(DOC.id)).resolves.toEqual([version]);
    await expect(api.downloadLink(DOC.id)).resolves.toEqual({
      downloadUrl: 'https://storage.test/o/1',
      expiresIn: 300,
    });
    await expect(api.text(DOC.id, 2)).resolves.toMatchObject({ text: 'نص', totalPages: 3 });
    expect(textPage).toBe('2');
    const file = new Blob(['%PDF'], { type: 'application/pdf' });
    await expect(
      api.uploadVersion(
        DOC.id,
        { file, filename: 'عقد-معدل.pdf', changeNote: 'توقيع' },
        { onProgress: () => undefined },
      ),
    ).resolves.toEqual({ documentId: DOC.id, versionNumber: 2, status: 'SCANNING' });
    expect(versionFields).toEqual(['changeNote', 'file']);
    await api.uploadVersion(DOC.id, { file, filename: 'x.pdf' });
    expect(versionFields).toEqual(['file']);
  });
});
