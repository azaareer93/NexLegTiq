import type { Client, ClientDocument, Note } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import {
  api,
  http,
  ok,
  renderApp,
  server,
  setupTestServer,
  setViewport,
  signedIn,
} from '../../test/render-app';

setupTestServer();

const SLOW = 60_000;
const AXE_SLOW = 180_000;
const COLD = 20_000;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
const ID = '01920000-0000-7000-8000-0000000000c1';
const FILE = {
  id: '01920000-0000-7000-8000-0000000001f1',
  fileNumber: '2026-LIT-00007',
  title: 'Rent claim',
};

const CLIENT: Client = {
  id: ID,
  clientType: 'INDIVIDUAL',
  displayName: 'Omar Khalil',
  fullName: 'Omar Khalil',
  companyName: null,
  phone: '+970599000000',
  email: null,
  isActive: true,
  primaryLawyer: null,
  openFiles: 2,
  closedFiles: 1,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-05T09:00:00.000Z',
  nationalId: null,
  taxId: null,
  address: null,
  industry: null,
  contacts: [],
};
const NOTE: Note = {
  id: '01920000-0000-7000-8000-0000000000d1',
  body: 'Owes the bank',
  isConfidential: true,
  pinned: false,
  author: { id: '01920000-0000-7000-8000-000000000001', fullName: 'Layla Haddad' },
  canEdit: true,
  createdAt: '2026-10-03T09:00:00.000Z',
  updatedAt: '2026-10-03T09:00:00.000Z',
};
const DOCUMENT: ClientDocument = {
  id: '01920000-0000-7000-8000-0000000000e1',
  fileId: FILE.id,
  folderId: null,
  sessionId: null,
  name: 'Lease.pdf',
  originalFilename: 'Lease.pdf',
  documentType: 'PLEADING',
  mimeType: 'application/pdf',
  sizeBytes: 10,
  currentVersion: 1,
  status: 'READY',
  ocrStatus: 'DONE',
  processingErrorCode: null,
  language: null,
  isConfidential: false,
  sharedWithClient: false,
  uploadedBy: { id: NOTE.author.id, fullName: 'Layla Haddad' },
  createdAt: '2026-10-03T09:00:00.000Z',
  updatedAt: '2026-10-03T09:00:00.000Z',
  file: FILE,
};

const page = (data: unknown[]) =>
  HttpResponse.json({
    success: true,
    data,
    meta: {
      ...meta,
      pagination: { page: 1, limit: 20, total: data.length, totalPages: 1, hasMore: false },
    },
  });

/** Serves the profile's reads; returns the bodies posted as notes. */
function serveProfile(): unknown[] {
  const posted: unknown[] = [];
  server.use(
    http.get(api(`clients/${ID}`), () => ok(CLIENT)),
    http.get(api('invoices/summary'), () =>
      ok({ billed: [{ currency: 'ILS', amount: '170.50', count: 3 }], outstanding: [] }),
    ),
    http.get(api(`clients/${ID}/notes`), () => ok([NOTE])),
    http.post(api(`clients/${ID}/notes`), async ({ request }) => {
      posted.push(await request.json());
      return ok({ ...NOTE, id: '01920000-0000-7000-8000-0000000000d2' }, 201);
    }),
    http.get(api(`clients/${ID}/documents`), () => page([DOCUMENT])),
  );
  return posted;
}

const openProfile = async (path = `/clients/${ID}`, locale: 'en' | 'ar' = 'en') => {
  setViewport(1280);
  const view = renderApp(path, locale);
  await screen.findByTestId('page-client', {}, { timeout: COLD });
  return view;
};

describe('client profile (MVP-55)', () => {
  it(
    'should show the key numbers, then the documents of its cases and its notes',
    async () => {
      signedIn();
      const posted = serveProfile();
      await openProfile();
      expect(within(screen.getByTestId('client-stat-open')).getByText('2')).toBeTruthy();
      expect(
        within(await screen.findByTestId('client-stat-billed')).getByText('₪170.50'),
      ).toBeTruthy();
      expect(within(screen.getByTestId('client-stat-outstanding')).getByText('—')).toBeTruthy();

      fireEvent.click(screen.getByTestId('client-tab-documents'));
      const documents = await screen.findByTestId('client-documents');
      expect(within(documents).getByText('Lease.pdf')).toBeTruthy();
      expect(within(documents).getByText('2026-LIT-00007').closest('a')?.getAttribute('href')).toBe(
        `/cases/${FILE.id}?tab=documents`,
      );

      fireEvent.click(screen.getByTestId('client-tab-notes'));
      expect(await screen.findByText('Owes the bank')).toBeTruthy();
      fireEvent.change(screen.getByTestId('note-body'), { target: { value: 'Call on Sunday' } });
      fireEvent.click(screen.getByTestId('note-confidential'));
      fireEvent.click(screen.getByTestId('note-add'));
      await waitFor(() =>
        expect(posted).toEqual([{ body: 'Call on Sunday', isConfidential: true, pinned: false }]),
      );
    },
    SLOW,
  );

  it(
    'should leave out the invoices tab and money cards without an invoice right',
    async () => {
      signedIn({
        permissions: permissionsFor('PARALEGAL').filter((p) => !p.endsWith(':invoices')),
      });
      serveProfile();
      await openProfile(`/clients/${ID}?tab=invoices`);
      expect(screen.queryByTestId('client-tab-invoices')).toBeNull();
      expect(screen.queryByTestId('client-stat-billed')).toBeNull();
      // A link to a tab the user may not open falls back to the overview.
      expect(screen.getByTestId('client-stat-open')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show the 404 page for a client that is not there',
    async () => {
      signedIn();
      setViewport(1280);
      renderApp('/clients/not-an-id');
      expect(await screen.findByTestId('page-not-found', {}, { timeout: COLD })).toBeTruthy();
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should have no accessibility violations (%s)',
    async (locale) => {
      signedIn({ uiLanguage: locale === 'ar' ? 'AR' : 'EN' });
      serveProfile();
      await openProfile(`/clients/${ID}`, locale);
      if (locale === 'ar') expect(document.documentElement.dir).toBe('rtl');
      const results = await axe.run(screen.getByTestId('page-client'), {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    AXE_SLOW,
  );
});
