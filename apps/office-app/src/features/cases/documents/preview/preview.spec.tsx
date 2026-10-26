import type { Case, Document, DocumentVersion } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { isolate } from '@nexlegtiq/shared-utils';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { openDownload } from './open-download';
import { openPdf } from './pdf-render';
import { highlight } from './TextPane';
import { openable, previewKeys, previewKind } from './use-document-preview';
import {
  api,
  fail,
  http,
  ok,
  renderApp,
  server,
  setupTestServer,
  setViewport,
  signedIn,
} from '../../../../test/render-app';
import { documentKeys } from '../use-documents';

vi.mock('./pdf-render', () => ({ openPdf: vi.fn() }));
vi.mock('./open-download', () => ({ openDownload: vi.fn() }));

setupTestServer();

const SLOW = 60_000;
const COLD = 20_000;

const FILE_ID = '01920000-0000-7000-8000-0000000001f1';
const LAWYER_ID = '01920000-0000-7000-8000-0000000000a1';
const DOC_ID = '01920000-0000-7000-8000-0000000007a1';
const STORAGE_URL = 'https://storage.test/office/doc-1.pdf';

const FILE = {
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
} satisfies Case;

const doc = (extra: Partial<Document> = {}): Document => ({
  id: DOC_ID,
  fileId: FILE_ID,
  folderId: null,
  sessionId: null,
  name: 'لائحة الدعوى.pdf',
  originalFilename: 'لائحة الدعوى.pdf',
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

const version = (versionNumber: number, changeNote: string | null): DocumentVersion => ({
  versionNumber,
  originalFilename: `لائحة-${versionNumber}.pdf`,
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  checksumSha256: 'a'.repeat(64),
  changeNote,
  createdBy: { id: LAWYER_ID, fullName: 'Sami Nasser' },
  createdAt: `2026-10-0${versionNumber}T09:00:00.000Z`,
});

const ARABIC_TEXT =
  'قررت المحكمة تأجيل الجلسة.\nThe court adjourned the hearing.\nقررت المحكمة رد الدعوى.';

interface Calls {
  links: number;
  textPages: string[];
  versionUploads: FormData[];
}

function serve({
  file = FILE as Case,
  document = doc(),
  download = () => ok({ downloadUrl: STORAGE_URL, expiresIn: 300 }),
}: { file?: Case; document?: Document; download?: () => Response } = {}): Calls {
  const calls: Calls = { links: 0, textPages: [], versionUploads: [] };
  server.use(
    http.get(api(`cases/${FILE_ID}`), () => ok(file)),
    http.get(api(`cases/${FILE_ID}/folders`), () => ok([])),
    http.get(api(`cases/${FILE_ID}/documents`), () =>
      HttpResponse.json({
        success: true,
        data: [document],
        meta: {
          timestamp: '2026-10-05T10:00:00.000Z',
          requestId: 'req-12345678',
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false },
        },
      }),
    ),
    http.get(api(`documents/${DOC_ID}`), () => ok(document)),
    http.get(api(`documents/${DOC_ID}/download`), () => {
      calls.links += 1;
      return download();
    }),
    http.get(STORAGE_URL, () => new HttpResponse(new Uint8Array([37, 80, 68, 70]))),
    http.get(api(`documents/${DOC_ID}/text`), ({ request }) => {
      const page = new URL(request.url).searchParams.get('page') ?? '1';
      calls.textPages.push(page);
      return ok({
        versionNumber: 2,
        ocrStatus: 'DONE',
        page: Number(page),
        totalPages: 2,
        text: ARABIC_TEXT,
      });
    }),
    http.get(api(`documents/${DOC_ID}/versions`), () =>
      ok([version(2, 'بعد التوقيع'), version(1, null)]),
    ),
    http.post(api(`documents/${DOC_ID}/versions`), async ({ request }) => {
      calls.versionUploads.push(await request.formData());
      return ok({ documentId: DOC_ID, versionNumber: 3, status: 'SCANNING' }, 202);
    }),
  );
  return calls;
}

const asRole = (role: Role, uiLanguage: 'AR' | 'EN' = 'EN') =>
  signedIn({ id: LAWYER_ID, role, uiLanguage, permissions: [...permissionsFor(role)] });

/** Opens the file's Documents tab and the document's drawer. */
async function openDrawer(locale: 'en' | 'ar' = 'en'): Promise<HTMLElement> {
  setViewport(1280);
  renderApp(`/cases/${FILE_ID}?tab=documents`, locale);
  fireEvent.click(await screen.findByTestId(`document-open-${DOC_ID}`, {}, { timeout: COLD }));
  return screen.findByTestId('document-preview-drawer', {}, { timeout: COLD });
}

const tab = async (drawer: HTMLElement, name: string) =>
  fireEvent.click(await within(drawer).findByRole('tab', { name }, { timeout: COLD }));

// jsdom has no layout: give the preview frame the width a drawer has.
const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 720,
  });
});
afterAll(() => {
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth);
});

beforeEach(() => {
  vi.mocked(openPdf).mockReset();
  vi.mocked(openDownload).mockReset();
  URL.createObjectURL = vi.fn(() => 'blob:preview-1');
  URL.revokeObjectURL = vi.fn();
});

describe('document preview helpers', () => {
  it('should mark every case-insensitive match, taking regex characters literally', () => {
    expect(highlight('Court COURT court', 'court').filter((s) => s.match)).toHaveLength(3);
    expect(highlight('المحكمة قررت المحكمة', 'المحكمة')).toEqual([
      { text: 'المحكمة', match: true },
      { text: ' قررت ', match: false },
      { text: 'المحكمة', match: true },
    ]);
    expect(highlight('a (1) b', '(1)')).toEqual([
      { text: 'a ', match: false },
      { text: '(1)', match: true },
      { text: ' b', match: false },
    ]);
    expect(highlight('text', '  ')).toEqual([{ text: 'text', match: false }]);
  });

  it('should keep text pages and bytes out of the prefix the realtime bridge refreshes (each read is audited)', () => {
    const refreshed = documentKeys.all[0];
    expect(previewKeys.text(DOC_ID, 2, 1)[0]).not.toBe(refreshed);
    expect(previewKeys.bytes(DOC_ID, 2)[0]).not.toBe(refreshed);
    expect(previewKeys.versions(FILE_ID, DOC_ID)[0]).toBe(refreshed);
  });

  it('should open a document only once its scan was clean', () => {
    expect(openable({ status: 'READY', processingErrorCode: null })).toBe(true);
    expect(openable({ status: 'PROCESSING', processingErrorCode: null })).toBe(true);
    expect(openable({ status: 'FAILED', processingErrorCode: 'EXT-002' })).toBe(true);
    expect(openable({ status: 'FAILED', processingErrorCode: null })).toBe(false);
    expect(openable({ status: 'SCANNING', processingErrorCode: null })).toBe(false);
    expect(openable({ status: 'QUARANTINED', processingErrorCode: null })).toBe(false);
  });

  it('should preview PDFs, PNG and JPEG only', () => {
    expect(previewKind('application/pdf')).toBe('pdf');
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('image/jpeg')).toBe('image');
    expect(previewKind('image/tiff')).toBeNull();
    expect(
      previewKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBeNull();
  });
});

describe('document preview drawer (D-143)', () => {
  it(
    'should render a PDF page by page from bytes the app fetched through an audited link',
    async () => {
      asRole('PARALEGAL');
      const calls = serve();
      const renderPage = vi.fn().mockResolvedValue(undefined);
      vi.mocked(openPdf).mockResolvedValue({ pageCount: 3, renderPage, destroy: vi.fn() });
      const drawer = await openDrawer();
      await within(drawer).findByTestId('document-preview-pdf', {}, { timeout: COLD });
      expect(calls.links).toBe(1);
      expect(vi.mocked(openPdf).mock.calls[0]?.[0].byteLength).toBe(4);
      await waitFor(() => expect(renderPage).toHaveBeenCalledWith(1, expect.anything(), 720));
      fireEvent.click(within(drawer).getByTitle('Next Page'));
      await waitFor(() =>
        expect(renderPage).toHaveBeenCalledWith(2, expect.anything(), expect.any(Number)),
      );
      expect(within(drawer).getByRole('img', { name: 'Page 2 of 3' })).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show an image through an object URL and say when a type cannot be previewed',
    async () => {
      asRole('LAWYER');
      serve({ document: doc({ mimeType: 'image/png', name: 'scan.png' }) });
      const drawer = await openDrawer();
      const image = await within(drawer).findByTestId(
        'document-preview-image',
        {},
        { timeout: COLD },
      );
      expect(image.getAttribute('src')).toBe('blob:preview-1');
      expect(image.getAttribute('alt')).toBe(isolate('scan.png'));
    },
    SLOW,
  );

  it(
    'should not ask for a link for a type it cannot preview',
    async () => {
      asRole('LAWYER');
      const calls = serve({ document: doc({ mimeType: 'image/tiff', name: 'scan.tiff' }) });
      const drawer = await openDrawer();
      expect(await within(drawer).findByText('This type of file cannot be previewed')).toBeTruthy();
      expect(calls.links).toBe(0);
    },
    SLOW,
  );

  it(
    'should wait for a clean scan before asking for a link, then preview by itself',
    async () => {
      asRole('LAWYER');
      const calls = serve({ document: doc({ status: 'SCANNING' }) });
      vi.mocked(openPdf).mockResolvedValue({
        pageCount: 1,
        renderPage: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
      });
      const drawer = await openDrawer();
      expect(
        await within(drawer).findByText(/still being checked/, {}, { timeout: COLD }),
      ).toBeTruthy();
      expect(calls.links).toBe(0);
    },
    SLOW,
  );

  it(
    "should show the API's reason when the link is refused",
    async () => {
      asRole('LAWYER');
      serve({ download: () => fail(422, 'BIZ-015') });
      const drawer = await openDrawer();
      expect(
        await within(drawer).findByText(/still being checked/, {}, { timeout: COLD }),
      ).toBeTruthy();
      expect(openPdf).not.toHaveBeenCalled();
    },
    SLOW,
  );

  it(
    'should page the Arabic text right to left and mark the matches of a search',
    async () => {
      asRole('LAWYER', 'AR');
      const calls = serve();
      vi.mocked(openPdf).mockResolvedValue({
        pageCount: 1,
        renderPage: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
      });
      const drawer = await openDrawer('ar');
      await tab(drawer, 'النص');
      const text = await within(drawer).findByTestId('document-text', {}, { timeout: COLD });
      expect(text.style.unicodeBidi).toBe('plaintext');
      expect(text.style.textAlign).toBe('start');
      fireEvent.change(
        within(drawer)
          .getByTestId('document-text-search')
          .querySelector('input') as HTMLInputElement,
        {
          target: { value: 'المحكمة' },
        },
      );
      expect(text.querySelectorAll('mark')).toHaveLength(2);
      expect(within(drawer).getByTestId('document-text-matches').textContent).toBe(
        'نتيجتان في هذه الصفحة',
      );
      fireEvent.click(within(drawer).getByTitle('الصفحة التالية'));
      await waitFor(() => expect(calls.textPages).toEqual(['1', '2']));
    },
    SLOW,
  );

  it(
    'should list the versions, download only the current one and upload a new one with its note',
    async () => {
      asRole('LAWYER');
      const calls = serve();
      vi.mocked(openPdf).mockResolvedValue({
        pageCount: 1,
        renderPage: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
      });
      const drawer = await openDrawer();
      await tab(drawer, 'Versions');
      const current = await within(drawer).findByTestId(
        'document-version-download-2',
        {},
        { timeout: COLD },
      );
      expect(within(drawer).getByTestId('document-version-1').textContent).toContain('لائحة-1.pdf');
      expect(
        (within(drawer).getByRole('button', { name: 'Download version 1' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      fireEvent.click(current);
      await waitFor(() => expect(openDownload).toHaveBeenCalledWith(STORAGE_URL));
      const input = drawer.querySelector('input[type=file]') as HTMLInputElement;
      fireEvent.change(input, {
        target: { files: [new File(['%PDF-1.7'], 'لائحة-3.pdf', { type: 'application/pdf' })] },
      });
      fireEvent.change(within(drawer).getByTestId('document-version-note'), {
        target: { value: 'تصحيح التاريخ' },
      });
      fireEvent.click(within(drawer).getByTestId('document-version-submit'));
      await waitFor(() => expect(calls.versionUploads).toHaveLength(1));
      const form = calls.versionUploads[0] as FormData;
      expect([...form.keys()]).toEqual(['changeNote', 'file']);
      expect(form.get('changeNote')).toBe('تصحيح التاريخ');
      expect(await screen.findByText(/New version uploaded/)).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should offer no new version on an archived file',
    async () => {
      asRole('LAWYER');
      serve({ file: { ...FILE, status: 'ARCHIVED' } });
      vi.mocked(openPdf).mockResolvedValue({
        pageCount: 1,
        renderPage: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
      });
      const drawer = await openDrawer();
      await tab(drawer, 'Versions');
      await within(drawer).findByTestId('document-version-2', {}, { timeout: COLD });
      expect(within(drawer).queryByTestId('document-version-submit')).toBeNull();
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should pass axe with the drawer open (%s)',
    async (locale) => {
      asRole('LAWYER', locale === 'ar' ? 'AR' : 'EN');
      serve();
      vi.mocked(openPdf).mockResolvedValue({
        pageCount: 2,
        renderPage: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
      });
      const drawer = await openDrawer(locale);
      await within(drawer).findByTestId('document-preview-pdf', {}, { timeout: COLD });
      const { violations } = await axe.run(drawer, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    180_000,
  );
});
