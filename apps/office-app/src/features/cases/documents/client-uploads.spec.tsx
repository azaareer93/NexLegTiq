import type { Case, ClientUpload } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';

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
} from '../../../test/render-app';

setupTestServer();

const COLD = 20_000;
const SLOW = 60_000;
const FILE_ID = '01920000-0000-7000-8000-0000000001f1';
const USER_ID = '01920000-0000-7000-8000-0000000000a1';
const PENDING_ID = '01920000-0000-7000-8000-0000000009a1';
const REJECTED_ID = '01920000-0000-7000-8000-0000000009a2';
const ACCEPTED_ID = '01920000-0000-7000-8000-0000000009a3';
const CUSTOM_FOLDER = '01920000-0000-7000-8000-0000000008a2';

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
  responsibleLawyer: { id: USER_ID, fullName: 'Sami Nasser' },
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
  team: [{ id: USER_ID, fullName: 'Sami Nasser', role: 'RESPONSIBLE_LAWYER' }],
  counts: { parties: 0, notes: 0 },
  createdAt: '2026-10-01T09:00:00.000Z',
} as unknown as Case;

const upload = (id: string, extra: Partial<ClientUpload>): ClientUpload => ({
  id,
  fileId: FILE_ID,
  name: 'Contract scan.pdf',
  mimeType: 'application/pdf',
  sizeBytes: '2516582',
  status: 'PENDING_REVIEW',
  rejectionReason: null,
  createdAt: '2026-10-04T09:00:00.000Z',
  client: { id: '01920000-0000-7000-8000-0000000000c1', displayName: 'Layla Haddad' },
  uploaderName: 'Layla Haddad',
  reviewedBy: null,
  reviewedAt: null,
  documentId: null,
  ...extra,
});
const UPLOADS = [
  upload(PENDING_ID, {}),
  upload(REJECTED_ID, {
    name: 'Blurry.jpg',
    status: 'REJECTED',
    rejectionReason: 'Unreadable photo',
  }),
  upload(ACCEPTED_ID, { name: 'ID card.pdf', status: 'ACCEPTED' }),
];

const asRole = (role: Role, uiLanguage: 'AR' | 'EN' = 'EN') =>
  signedIn({ id: USER_ID, role, uiLanguage, permissions: [...permissionsFor(role)] });

interface Write {
  path: string;
  body: unknown;
}

function serve(): { writes: Write[]; docLists: () => number } {
  const writes: Write[] = [];
  let docLists = 0;
  const post = (id: string, verb: string, status: ClientUpload['status']) =>
    http.post(api(`client-uploads/${id}/${verb}`), async ({ request }) => {
      writes.push({ path: new URL(request.url).pathname, body: await request.json() });
      return ok(upload(id, { status }));
    });
  server.use(
    http.get(api(`cases/${FILE_ID}`), () => ok(FILE)),
    http.get(api(`cases/${FILE_ID}/documents`), () => {
      docLists += 1;
      return HttpResponse.json({
        success: true,
        data: [],
        meta: {
          timestamp: '2026-10-05T10:00:00.000Z',
          requestId: 'req-12345678',
          pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
        },
      });
    }),
    http.get(api(`cases/${FILE_ID}/folders`), () =>
      ok([
        {
          id: CUSTOM_FOLDER,
          fileId: FILE_ID,
          parentId: null,
          name: 'Expert reports',
          systemKey: null,
          documentCount: 0,
          createdAt: '2026-10-01T09:00:00.000Z',
          updatedAt: '2026-10-01T09:00:00.000Z',
        },
      ]),
    ),
    http.get(api(`cases/${FILE_ID}/client-uploads`), () => ok(UPLOADS)),
    post(PENDING_ID, 'accept', 'ACCEPTED'),
    post(PENDING_ID, 'reject', 'REJECTED'),
  );
  return { writes, docLists: () => docLists };
}

const openTab = async (locale: 'en' | 'ar' = 'en') => {
  renderApp(`/cases/${FILE_ID}?tab=documents`, locale);
  return screen.findByTestId('client-uploads', {}, { timeout: COLD });
};

describe('client uploads on the documents tab (MVP-99)', () => {
  it(
    'should list the uploads with status and rejection reason, and offer review on pending ones',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve();
      const card = within(await openTab());
      expect(card.getByText('Waiting for review')).toBeTruthy();
      expect(card.getByText('Accepted')).toBeTruthy();
      expect(card.getByText(/Unreadable photo/)).toBeTruthy();
      expect(card.getByTestId(`client-upload-accept-${PENDING_ID}`)).toBeTruthy();
      expect(card.queryByTestId(`client-upload-accept-${REJECTED_ID}`)).toBeNull();
    },
    SLOW,
  );

  it(
    'should accept with the chosen type and name, and refresh the documents',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const calls = serve();
      const card = within(await openTab());
      await waitFor(() => expect(calls.docLists()).toBeGreaterThan(0));
      const before = calls.docLists();
      fireEvent.click(card.getByTestId(`client-upload-accept-${PENDING_ID}`));
      const dialog = within(await screen.findByTestId('client-upload-accept-dialog'));
      fireEvent.mouseDown(dialog.getByLabelText('Document type'));
      fireEvent.click(await screen.findByText('Evidence'));
      fireEvent.change(dialog.getByTestId('client-upload-name'), {
        target: { value: 'Signed contract.pdf' },
      });
      fireEvent.click(
        within(screen.getByTestId('client-upload-accept-dialog')).getByRole('button', {
          name: 'Accept',
        }),
      );
      await waitFor(() => expect(calls.writes).toHaveLength(1));
      expect(calls.writes[0]).toEqual({
        path: `/api/v1/client-uploads/${PENDING_ID}/accept`,
        body: { documentType: 'EVIDENCE', name: 'Signed contract.pdf' },
      });
      await waitFor(() => expect(calls.docLists()).toBeGreaterThan(before));
    },
    SLOW,
  );

  it(
    'should require a reason to reject and send it',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const calls = serve();
      const card = within(await openTab());
      fireEvent.click(card.getByTestId(`client-upload-reject-${PENDING_ID}`));
      const dialog = within(await screen.findByTestId('client-upload-reject-dialog'));
      const confirm = dialog.getByRole('button', { name: 'Reject' });
      expect((confirm as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(dialog.getByTestId('client-upload-reason'), {
        target: { value: 'Not the right file' },
      });
      fireEvent.click(confirm);
      await waitFor(() => expect(calls.writes).toHaveLength(1));
      expect(calls.writes[0]).toEqual({
        path: `/api/v1/client-uploads/${PENDING_ID}/reject`,
        body: { reason: 'Not the right file' },
      });
    },
    SLOW,
  );

  it(
    'should show the mapped error when the upload was already reviewed',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve();
      server.use(http.post(api(`client-uploads/${PENDING_ID}/accept`), () => fail(422, 'BIZ-028')));
      const card = within(await openTab());
      fireEvent.click(card.getByTestId(`client-upload-accept-${PENDING_ID}`));
      await screen.findByTestId('client-upload-accept-dialog');
      fireEvent.click(
        within(screen.getByTestId('client-upload-accept-dialog')).getByRole('button', {
          name: 'Accept',
        }),
      );
      expect(
        await screen.findByText('This upload has already been reviewed.', {}, { timeout: COLD }),
      ).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should offer no actions without upload:document',
    async () => {
      setViewport(1280);
      asRole('ADMIN');
      serve();
      const card = within(await openTab());
      expect(card.getByText('Waiting for review')).toBeTruthy();
      expect(card.queryByTestId(`client-upload-accept-${PENDING_ID}`)).toBeNull();
      expect(card.queryByTestId(`client-upload-reject-${PENDING_ID}`)).toBeNull();
    },
    SLOW,
  );

  it(
    'should render in Arabic, right to left',
    async () => {
      setViewport(1280);
      asRole('LAWYER', 'AR');
      serve();
      const card = within(await openTab('ar'));
      expect(document.documentElement.dir).toBe('rtl');
      expect(card.getByText('مرفوعات الموكلين')).toBeTruthy();
      expect(card.getByText('بانتظار المراجعة')).toBeTruthy();
      expect(card.getByText('مقبول')).toBeTruthy();
      expect(card.getByText(/Unreadable photo/)).toBeTruthy();
    },
    SLOW,
  );
});
