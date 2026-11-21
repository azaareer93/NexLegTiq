import { RESOURCES } from '@nexlegtiq/shared-i18n';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { setupServer } from 'msw/node';

import {
  FILE_ID,
  OFFICE_ID,
  SESSION,
  api,
  click,
  expectAccessible,
  fail,
  ok,
  renderApp,
} from '../../test/render-app';
import { resetSession } from '../auth/session';

const text = (tree: unknown, path: string): string =>
  path
    .split('.')
    .reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], tree) as string;
const t = (path: string): string => text(RESOURCES.en, path);

const FILE = {
  id: FILE_ID,
  officeId: OFFICE_ID,
  officeName: 'مكتب العدالة',
  fileNumber: '2026/014',
  title: 'Haddad v. Nasser',
  status: 'OPEN',
  lawyerName: 'Sami Khalil',
  nextHearing: {
    startsAt: '2026-12-02T08:30:00.000Z',
    courtNameAr: 'محكمة صلح رام الله',
    courtNameEn: 'Ramallah Magistrate Court',
  },
};
const DOC_ID = '01920000-0000-7000-8000-000000000301';
const INVOICE_ID = '01920000-0000-7000-8000-000000000401';

const server = setupServer(
  http.post(api('portal/auth/refresh'), () => ok(SESSION)),
  http.get(api('portal/files'), () => ok([FILE])),
  http.get(api(`portal/files/${FILE_ID}`), () =>
    ok({
      ...FILE,
      timeline: [
        { eventType: 'SESSION_CREATED', occurredAt: '2026-11-20T09:00:00.000Z' },
        { eventType: 'FILE_OPENED', occurredAt: '2026-11-01T09:00:00.000Z' },
      ],
    }),
  ),
  http.get(api(`portal/files/${FILE_ID}/documents`), () =>
    ok([
      {
        id: DOC_ID,
        name: 'Power of attorney.pdf',
        mimeType: 'application/pdf',
        sizeBytes: '20480',
        createdAt: '2026-11-15T09:00:00.000Z',
      },
    ]),
  ),
  http.get(api(`portal/files/${FILE_ID}/uploads`), () => ok([])),
);
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetSession();
  localStorage.clear();
});
afterAll(() => server.close());

describe('my files', () => {
  it('should list the files with status and next hearing, and the office contact card', async () => {
    await renderApp('/', 'en');
    const card = await screen.findByTestId(`file-${FILE_ID}`);
    expect(card.textContent).toContain('Haddad v. Nasser');
    expect(card.textContent).toContain('2026/014');
    expect(card.textContent).toContain(t('enums.fileStatus.OPEN'));
    expect(card.textContent).toContain('Ramallah Magistrate Court');
    const contact = screen.getByTestId(`contact-${OFFICE_ID}`);
    expect(within(contact).getByTestId('contact-phone').getAttribute('href')).toBe(
      'tel:+97022950000',
    );
    expect(within(contact).getByTestId('contact-email').getAttribute('href')).toBe(
      'mailto:office%40example.test',
    );
    await expectAccessible();
  });

  it('should show an empty state in Arabic when there is no file, with the contact card', async () => {
    server.use(http.get(api('portal/files'), () => ok([])));
    await renderApp('/');
    expect(await screen.findByText(text(RESOURCES.ar, 'portal.files.empty'))).toBeTruthy();
    expect(screen.getByTestId(`contact-${OFFICE_ID}`)).toBeTruthy();
  });

  it('should open a file: overview with the public timeline, documents and download', async () => {
    const opened: string[] = [];
    server.use(
      http.get(api(`portal/documents/${DOC_ID}/download`), () => {
        opened.push(DOC_ID);
        return ok({ downloadUrl: 'https://storage.test/doc.pdf', expiresIn: 300 });
      }),
    );
    const clickLink = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const router = await renderApp('/', 'en');
    click((await screen.findByTestId(`file-${FILE_ID}`)).dataset['testid'] ?? '');
    const timeline = await screen.findByTestId('portal-timeline');
    expect(timeline.textContent).toContain(t('portal.timeline.SESSION_CREATED'));
    expect(timeline.textContent).toContain(t('portal.timeline.FILE_OPENED'));
    expect(screen.getByTestId('next-hearing').textContent).toContain('Ramallah Magistrate Court');
    await expectAccessible();

    fireEvent.click(screen.getByRole('tab', { name: t('portal.detail.tabs.documents') }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=documents'));
    click((await screen.findByTestId(`download-${DOC_ID}`)).dataset['testid'] ?? '');
    await waitFor(() => expect(clickLink).toHaveBeenCalled());
    expect(opened).toEqual([DOC_ID]);
    clickLink.mockRestore();
  });

  it('should say a file is not available on 404', async () => {
    server.use(http.get(api(`portal/files/${FILE_ID}`), () => fail(404, 'RES-001')));
    await renderApp(`/files/${FILE_ID}`, 'en');
    expect(await screen.findByTestId('file-not-found')).toBeTruthy();
  });

  it('should send a document and list it with its review status', async () => {
    let name: string | undefined;
    let key: string | null = null;
    let sent = false;
    server.use(
      http.get(api(`portal/files/${FILE_ID}/uploads`), () =>
        ok(
          sent
            ? [
                {
                  id: '01920000-0000-7000-8000-000000000501',
                  fileId: FILE_ID,
                  name: 'id-card.pdf',
                  mimeType: 'application/pdf',
                  sizeBytes: '1000',
                  status: 'SCANNING',
                  rejectionReason: null,
                  createdAt: '2026-11-21T10:00:00.000Z',
                },
              ]
            : [],
        ),
      ),
      http.post(api(`portal/files/${FILE_ID}/uploads`), async ({ request }) => {
        key = request.headers.get('Idempotency-Key');
        name = ((await request.formData()).get('file') as File | null)?.name;
        sent = true;
        return ok(
          {
            id: '01920000-0000-7000-8000-000000000501',
            fileId: FILE_ID,
            name: 'id-card.pdf',
            mimeType: 'application/pdf',
            sizeBytes: '1000',
            status: 'SCANNING',
            rejectionReason: null,
            createdAt: '2026-11-21T10:00:00.000Z',
          },
          202,
        );
      }),
    );
    await renderApp(`/files/${FILE_ID}?tab=uploads`, 'en');
    await screen.findByText(t('portal.uploads.empty'));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.7'], 'id-card.pdf', { type: 'application/pdf' })] },
    });
    expect((await screen.findByTestId('uploads-list')).textContent).toContain(
      t('portal.uploads.status.SCANNING'),
    );
    expect(name).toBe('id-card.pdf');
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('should refuse an empty file before sending it', async () => {
    await renderApp(`/files/${FILE_ID}?tab=uploads`, 'en');
    await screen.findByText(t('portal.uploads.empty'));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([], 'empty.pdf')] } });
    expect((await screen.findByTestId('upload-problem')).textContent).toBe(
      t('documents.upload.problem.empty'),
    );
  });

  it('should refuse a file over the size limit before sending it', async () => {
    await renderApp(`/files/${FILE_ID}?tab=uploads`, 'en');
    await screen.findByText(t('portal.uploads.empty'));
    const big = new File(['x'], 'big.pdf');
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [big] },
    });
    expect((await screen.findByTestId('upload-problem')).textContent).toContain('50');
  });

  it('should show a rejected upload with the office reason in portal wording', async () => {
    server.use(
      http.get(api(`portal/files/${FILE_ID}/uploads`), () =>
        ok([
          {
            id: '01920000-0000-7000-8000-000000000502',
            fileId: FILE_ID,
            name: 'blurry.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: '2048',
            status: 'REJECTED',
            rejectionReason: 'Please send a clearer photo',
            createdAt: '2026-11-21T10:00:00.000Z',
          },
        ]),
      ),
    );
    await renderApp(`/files/${FILE_ID}?tab=uploads`, 'en');
    const list = await screen.findByTestId('uploads-list');
    expect(list.textContent).toContain(t('portal.uploads.status.REJECTED'));
    expect(list.textContent).toContain('Please send a clearer photo');
  });

  it('should name the product, not one office, when the account spans several offices', async () => {
    const other = {
      ...SESSION.user.offices[0],
      officeId: '01920000-0000-7000-8000-00000000000b',
      officeName: 'Other Office',
    };
    server.use(
      http.post(api('portal/auth/refresh'), () =>
        ok({ ...SESSION, user: { ...SESSION.user, offices: [...SESSION.user.offices, other] } }),
      ),
    );
    await renderApp('/', 'en');
    expect((await screen.findByTestId('portal-brand')).textContent).toBe('NexLegTiq Portal');
    expect((await screen.findByTestId(`file-${FILE_ID}`)).textContent).toContain('مكتب العدالة');
    expect(screen.getByTestId(`contact-${other.officeId}`)).toBeTruthy();
  });
});

describe('invoices', () => {
  const invoice = (status: 'SENT' | 'PAID') => ({
    id: INVOICE_ID,
    officeId: OFFICE_ID,
    officeName: 'مكتب العدالة',
    invoiceNumber: 'INV-2026-0007',
    status,
    currency: 'ILS',
    issueDate: '2026-11-01',
    dueDate: '2026-11-30',
    total: '1500.00',
    paidAt: status === 'PAID' ? '2026-11-10T10:00:00.000Z' : null,
    file: { id: FILE_ID, fileNumber: '2026/014', title: 'Haddad v. Nasser' },
  });

  it('should list the shared invoices with paid/unpaid and tell when the PDF is being prepared', async () => {
    server.use(
      http.get(api('portal/invoices'), () => ok([invoice('SENT')])),
      http.get(api(`portal/invoices/${INVOICE_ID}/pdf`), () => ok({ status: 'RENDERING' }, 202)),
    );
    await renderApp('/invoices', 'en');
    const card = await screen.findByTestId(`invoice-${INVOICE_ID}`);
    expect(card.textContent).toContain('INV-2026-0007');
    expect(card.textContent).toContain(t('portal.invoices.status.SENT'));
    expect(card.textContent).toContain('1,500.00');
    await expectAccessible();
    click(`invoice-pdf-${INVOICE_ID}`);
    expect(await screen.findByText(t('portal.invoices.preparing'))).toBeTruthy();
  });

  it('should download a ready PDF', async () => {
    server.use(
      http.get(api('portal/invoices'), () => ok([invoice('PAID')])),
      http.get(api(`portal/invoices/${INVOICE_ID}/pdf`), () =>
        ok({ status: 'READY', downloadUrl: 'https://storage.test/inv.pdf', expiresIn: 300 }),
      ),
    );
    const clickLink = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    await renderApp('/invoices');
    const card = await screen.findByTestId(`invoice-${INVOICE_ID}`);
    expect(card.textContent).toContain(text(RESOURCES.ar, 'portal.invoices.status.PAID'));
    click(`invoice-pdf-${INVOICE_ID}`);
    await waitFor(() => expect(clickLink).toHaveBeenCalled());
    clickLink.mockRestore();
  });

  it('should show an empty state without invoices', async () => {
    server.use(http.get(api('portal/invoices'), () => ok([])));
    await renderApp('/invoices', 'en');
    expect(await screen.findByText(t('portal.invoices.empty'))).toBeTruthy();
  });
});
