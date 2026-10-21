import type { Case, Document, Folder } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { retryable, uploadProblem } from './document-upload';
import {
  api,
  http,
  ok,
  renderApp,
  server,
  setupTestServer,
  setViewport,
  signedIn,
} from '../../../test/render-app';

setupTestServer();

const SLOW = 60_000;
const COLD = 20_000;

const FILE_ID = '01920000-0000-7000-8000-0000000001f1';
const LAWYER_ID = '01920000-0000-7000-8000-0000000000a1';
const DOC_ID = '01920000-0000-7000-8000-0000000007a1';
const FAILED_ID = '01920000-0000-7000-8000-0000000007a2';
const UNREADABLE_ID = '01920000-0000-7000-8000-0000000007a3';
const PLEADINGS_ID = '01920000-0000-7000-8000-0000000008a1';
const CUSTOM_ID = '01920000-0000-7000-8000-0000000008a2';

const FILE: Case = {
  id: FILE_ID,
  fileNumber: '2026-LIT-00007',
  title: 'Land dispute',
  fileType: 'LITIGATION',
  status: 'OPEN',
  priority: 'HIGH',
  openingDate: '2026-10-01',
  isConfidential: false,
  primaryClient: null,
  responsibleLawyer: { id: LAWYER_ID, fullName: 'Sami Nasser' },
  updatedAt: '2026-10-05T09:00:00.000Z',
  description: null,
  subType: null,
  closingDate: null,
  responsibleParalegal: null,
  courtCaseNumber: null,
  court: null,
  judge: null,
  jurisdiction: 'PALESTINE',
  billingMethod: null,
  hourlyRate: null,
  fixedFee: null,
  retainerBalance: null,
  currency: 'ILS',
  clients: [],
  team: [{ id: LAWYER_ID, fullName: 'Sami Nasser', role: 'RESPONSIBLE_LAWYER' }],
  counts: { parties: 0, notes: 0 },
  createdAt: '2026-10-01T09:00:00.000Z',
};

const folder = (id: string, extra: Partial<Folder>): Folder => ({
  id,
  fileId: FILE_ID,
  parentId: null,
  name: null,
  systemKey: null,
  documentCount: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...extra,
});
const FOLDERS = [
  folder(PLEADINGS_ID, { systemKey: 'PLEADINGS', documentCount: 1 }),
  folder(CUSTOM_ID, { name: 'Expert reports' }),
];

const doc = (id: string, extra: Partial<Document> = {}): Document => ({
  id,
  fileId: FILE_ID,
  folderId: PLEADINGS_ID,
  sessionId: null,
  name: 'Statement of claim.pdf',
  originalFilename: 'Statement of claim.pdf',
  documentType: 'PLEADING',
  mimeType: 'application/pdf',
  sizeBytes: 2_516_582,
  currentVersion: 2,
  status: 'READY',
  ocrStatus: 'DONE',
  processingErrorCode: null,
  language: 'AR',
  isConfidential: false,
  sharedWithClient: false,
  uploadedBy: { id: LAWYER_ID, fullName: 'Sami Nasser' },
  createdAt: '2026-10-02T09:00:00.000Z',
  updatedAt: '2026-10-03T09:00:00.000Z',
  ...extra,
});
const DOCS = [
  doc(DOC_ID),
  doc(FAILED_ID, {
    name: 'Scan.png',
    status: 'FAILED',
    processingErrorCode: 'EXT-002',
    currentVersion: 1,
    language: null,
  }),
  doc(UNREADABLE_ID, {
    name: 'Broken.pdf',
    status: 'FAILED',
    processingErrorCode: 'VAL-005',
    currentVersion: 1,
  }),
];

const page = (items: Document[]) =>
  HttpResponse.json({
    success: true,
    data: items,
    meta: {
      timestamp: '2026-10-05T10:00:00.000Z',
      requestId: 'req-12345678',
      pagination: { page: 1, limit: 20, total: items.length, totalPages: 1, hasMore: false },
    },
  });

const asRole = (role: Role, uiLanguage: 'AR' | 'EN' = 'EN') =>
  signedIn({ id: LAWYER_ID, role, uiLanguage, permissions: [...permissionsFor(role)] });

interface Calls {
  lists: URLSearchParams[];
  writes: { method: string; path: string; body: unknown }[];
  uploads: FormData[];
}

function serve({ file = FILE, docs = DOCS } = {}): Calls {
  const calls: Calls = { lists: [], writes: [], uploads: [] };
  const record =
    (method: string, answer: () => Response) =>
    async ({ request }: { request: Request }) => {
      const text = await request.text();
      calls.writes.push({
        method,
        path: new URL(request.url).pathname,
        body: text ? (JSON.parse(text) as unknown) : null,
      });
      return answer();
    };
  server.use(
    http.get(api(`cases/${FILE_ID}`), () => ok(file)),
    http.get(api(`cases/${FILE_ID}/documents`), ({ request }) => {
      calls.lists.push(new URL(request.url).searchParams);
      return page(docs);
    }),
    http.get(api(`cases/${FILE_ID}/folders`), () => ok(FOLDERS)),
    http.post(
      api(`cases/${FILE_ID}/folders`),
      record('POST', () => ok(folder(CUSTOM_ID, { name: 'New' }), 201)),
    ),
    http.post(api('documents'), async ({ request }) => {
      calls.uploads.push(await request.formData());
      return ok({ documentId: DOC_ID, versionNumber: 1, status: 'UPLOADED' }, 202);
    }),
    http.patch(
      api(`documents/${DOC_ID}`),
      record('PATCH', () => ok(DOCS[0])),
    ),
    http.delete(
      api(`documents/${DOC_ID}`),
      record('DELETE', () => new HttpResponse(null, { status: 204 })),
    ),
    http.post(
      api(`documents/${FAILED_ID}/ocr/retry`),
      record('POST', () => ok({ jobId: 'job-1' }, 202)),
    ),
  );
  return calls;
}

const openTab = async (locale: 'en' | 'ar' = 'en') => {
  renderApp(`/cases/${FILE_ID}?tab=documents`, locale);
  const tab = await screen.findByTestId('case-documents', {}, { timeout: COLD });
  await within(tab).findByTestId(`document-row-${DOC_ID}`, {}, { timeout: COLD });
  return tab;
};

const openActions = async (id: string, item: string) => {
  fireEvent.click(screen.getByTestId(`document-actions-${id}`));
  fireEvent.click(await screen.findByText(item));
};

describe('document upload rules', () => {
  it('should refuse unknown types, empty files and files over 50 MB', () => {
    expect(uploadProblem({ name: 'a.PDF', size: 10 })).toBeNull();
    expect(uploadProblem({ name: 'tool.exe', size: 10 })).toBe('type');
    expect(uploadProblem({ name: 'noextension', size: 10 })).toBe('type');
    expect(uploadProblem({ name: 'a.docx', size: 0 })).toBe('empty');
    expect(uploadProblem({ name: 'a.tiff', size: 50 * 1024 * 1024 + 1 })).toBe('size');
  });

  it('should offer a retry only when it can help', () => {
    expect(retryable({ status: 'FAILED', processingErrorCode: 'EXT-002' })).toBe(true);
    expect(retryable({ status: 'FAILED', processingErrorCode: null })).toBe(true);
    expect(retryable({ status: 'FAILED', processingErrorCode: 'VAL-005' })).toBe(false);
    expect(retryable({ status: 'READY', processingErrorCode: null })).toBe(false);
  });
});

describe('documents tab (MVP-75)', () => {
  it(
    'should list documents with status, version, language and size, and the folder tree',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve();
      const tab = await openTab();
      const row = within(screen.getByTestId(`document-row-${DOC_ID}`));
      expect(row.getByText('Ready')).toBeTruthy();
      expect(row.getByText('v2')).toBeTruthy();
      expect(row.getByText('Arabic')).toBeTruthy();
      expect(row.getByText('2.4 MB')).toBeTruthy();
      expect(
        within(screen.getByTestId(`document-row-${FAILED_ID}`)).getByText('Failed'),
      ).toBeTruthy();
      // System folders are labelled in the reader's language; the office's own by their name.
      expect(within(tab).getByTestId(`folder-${PLEADINGS_ID}`).textContent).toContain('Pleadings');
      expect(within(tab).getByTestId(`folder-${CUSTOM_ID}`).textContent).toContain(
        'Expert reports',
      );
    },
    SLOW,
  );

  it(
    'should filter by folder and by search, back on page 1',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const calls = serve();
      await openTab();
      fireEvent.click(screen.getByTestId('folder-root'));
      await waitFor(() => expect(calls.lists.at(-1)?.get('folderId')).toBe('root'));
      fireEvent.click(screen.getByTestId(`folder-${CUSTOM_ID}`));
      await waitFor(() => expect(calls.lists.at(-1)?.get('folderId')).toBe(CUSTOM_ID));
      const search = within(screen.getByTestId('documents-search')).getByRole('searchbox');
      fireEvent.change(search, { target: { value: 'claim' } });
      fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' });
      await waitFor(() => expect(calls.lists.at(-1)?.get('search')).toBe('claim'));
      expect(calls.lists.at(-1)?.get('page')).toBe('1');
    },
    SLOW,
  );

  it(
    'should queue several files, refuse the wrong type, and upload the rest with type and folder',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const calls = serve();
      await openTab();
      // The selected folder is the upload's default.
      fireEvent.click(screen.getByTestId(`folder-${CUSTOM_ID}`));
      fireEvent.click(screen.getByTestId('documents-upload'));
      const panel = await screen.findByTestId('upload-panel');
      const input = panel.querySelector('input[type="file"]');
      if (!input) throw new Error('no file input');
      fireEvent.change(input, {
        target: {
          files: [
            new File(['%PDF-1.7'], 'Contract.pdf', { type: 'application/pdf' }),
            new File(['MZ'], 'tool.exe'),
          ],
        },
      });
      expect(await within(panel).findByText('This type of file is not accepted')).toBeTruthy();
      fireEvent.click(await within(panel).findByText('Upload 1 file'));
      await waitFor(() => expect(calls.uploads).toHaveLength(1));
      const form = calls.uploads[0];
      expect(form?.get('fileId')).toBe(FILE_ID);
      expect(form?.get('documentType')).toBe('OTHER');
      expect(form?.get('folderId')).toBe(CUSTOM_ID);
      expect((form?.get('file') as File | null)?.name).toBe('Contract.pdf');
      expect(await within(panel).findByText('Uploaded, being checked')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should retry a failed extraction, but not an unreadable file',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const calls = serve();
      await openTab();
      fireEvent.click(screen.getByTestId(`document-actions-${UNREADABLE_ID}`));
      await screen.findAllByText('Rename');
      expect(screen.queryByText('Try again')).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await openActions(FAILED_ID, 'Try again');
      await waitFor(() =>
        expect(calls.writes).toContainEqual({
          method: 'POST',
          path: `/api/v1/documents/${FAILED_ID}/ocr/retry`,
          body: null,
        }),
      );
    },
    SLOW,
  );

  it(
    'should rename and delete a document after confirming',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const calls = serve();
      await openTab();
      await openActions(DOC_ID, 'Rename');
      const name = await screen.findByTestId('document-rename-dialog-input');
      fireEvent.change(name, { target: { value: ' Claim v2.pdf ' } });
      fireEvent.click(within(screen.getByTestId('document-rename-dialog')).getByText('Save'));
      await waitFor(() =>
        expect(calls.writes).toContainEqual({
          method: 'PATCH',
          path: `/api/v1/documents/${DOC_ID}`,
          body: { name: 'Claim v2.pdf' },
        }),
      );
      await openActions(DOC_ID, 'Delete');
      const dialog = await screen.findByRole('dialog', { name: 'Delete this document?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() =>
        expect(calls.writes.some((write) => write.method === 'DELETE')).toBe(true),
      );
    },
    SLOW,
  );

  it(
    'should create a folder inside the selected one',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const calls = serve();
      await openTab();
      fireEvent.click(screen.getByTestId(`folder-${CUSTOM_ID}`));
      fireEvent.click(screen.getByTestId('folder-new'));
      fireEvent.change(await screen.findByTestId('folder-create-dialog-input'), {
        target: { value: 'Medical' },
      });
      fireEvent.click(within(screen.getByTestId('folder-create-dialog')).getByText('Create'));
      await waitFor(() =>
        expect(calls.writes).toContainEqual({
          method: 'POST',
          path: `/api/v1/cases/${FILE_ID}/folders`,
          body: { name: 'Medical', parentId: CUSTOM_ID },
        }),
      );
    },
    SLOW,
  );

  it(
    'should offer no writes on an archived file',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve({ file: { ...FILE, status: 'ARCHIVED' } });
      await openTab();
      expect(screen.queryByTestId('documents-upload')).toBeNull();
      expect(screen.queryByTestId('folder-new')).toBeNull();
      expect(screen.queryByTestId(`document-actions-${DOC_ID}`)).toBeNull();
    },
    SLOW,
  );

  it(
    'should show the empty state with the upload hint',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve({ docs: [] });
      renderApp(`/cases/${FILE_ID}?tab=documents`, 'en');
      expect(await screen.findByText('No documents yet', {}, { timeout: COLD })).toBeTruthy();
      expect(screen.getByText(/Drag files here or use Upload/)).toBeTruthy();
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should label the tab in the language and pass axe (%s)',
    async (locale) => {
      setViewport(1280);
      asRole('LAWYER', locale === 'ar' ? 'AR' : 'EN');
      serve();
      const tab = await openTab(locale);
      if (locale === 'ar') {
        expect(document.documentElement.dir).toBe('rtl');
        expect(within(tab).getByText('المجلدات')).toBeTruthy();
        expect(within(tab).getByTestId(`folder-${PLEADINGS_ID}`).textContent).toContain('اللوائح');
      }
      const { violations } = await axe.run(tab, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    180_000,
  );
});
