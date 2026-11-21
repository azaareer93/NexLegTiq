import { CaseSchema } from '@nexlegtiq/shared-contracts';
import type { Invoice } from '@nexlegtiq/shared-contracts';
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
  USER,
} from '../../test/render-app';

setupTestServer();
const COLD = 20_000;
const SLOW = 60_000;
const FILE_ID = '01920000-0000-7000-8000-0000000001f1';
const CLIENT = { id: '01920000-0000-7000-8000-0000000000c1', displayName: 'Omar Khalil' };
const NOW = '2026-11-09T10:00:00.000Z';

const invoice = (n: number, extra: Partial<Invoice> = {}): Invoice => ({
  id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  invoiceNumber: `INV-2026-000${n}`,
  status: 'SENT',
  client: CLIENT,
  file: { id: FILE_ID, fileNumber: '2026-LIT-00007', title: 'Land dispute' },
  currency: 'ILS',
  issueDate: '2026-11-01',
  dueDate: '2026-12-01',
  subtotal: '100.00',
  taxRatePercent: '16.00',
  taxAmount: '16.00',
  total: '116.00',
  sentAt: NOW,
  paidAt: null,
  sharedWithClient: false,
  createdAt: NOW,
  updatedAt: NOW,
  paymentMethod: null,
  paymentReference: null,
  notes: null,
  lines: [],
  ...extra,
});
const page = (items: unknown[]) =>
  HttpResponse.json({
    success: true,
    data: items,
    meta: {
      timestamp: NOW,
      requestId: 'req-12345678',
      pagination: { page: 1, limit: 20, total: items.length, totalPages: 1, hasMore: false },
    },
  });

function serve(rows: Invoice[]) {
  const calls = {
    list: [] as string[],
    paid: [] as unknown[],
    voided: [] as string[],
    drafts: [] as unknown[],
    sent: [] as unknown[],
  };
  server.use(
    http.get(api('invoices'), ({ request }) => {
      calls.list.push(new URL(request.url).search);
      return page(rows);
    }),
    http.get(api('clients'), () => page([{ ...CLIENT, clientType: 'INDIVIDUAL' }])),
    http.post(api('invoices/:id/mark-paid'), async ({ request }) => {
      calls.paid.push(await request.json());
      return ok(invoice(1, { status: 'PAID', paidAt: NOW }));
    }),
    http.post(api('invoices/:id/void'), ({ params }) => {
      calls.voided.push(String(params.id));
      return ok(invoice(1, { status: 'VOID' }));
    }),
    http.get(api('invoices/:id/pdf'), () =>
      ok({ status: 'READY', downloadUrl: 'https://s3.test/i.pdf', expiresIn: 300 }),
    ),
    http.post(api('invoices'), async ({ request }) => {
      calls.drafts.push(await request.json());
      return ok(
        invoice(5, {
          status: 'DRAFT',
          invoiceNumber: null,
          issueDate: null,
          dueDate: null,
          subtotal: '245.00',
          taxAmount: '39.20',
          total: '284.20',
          lines: [
            {
              id: '01920000-0000-7000-8000-0000000000d1',
              description: 'Hearing preparation',
              quantity: '1.50',
              unitPrice: '150.00',
              amount: '225.00',
              timeEntryId: '01920000-0000-7000-8000-0000000000e1',
            },
            {
              id: '01920000-0000-7000-8000-0000000000d2',
              description: 'Court fee',
              quantity: '1',
              unitPrice: '20.00',
              amount: '20.00',
              timeEntryId: null,
            },
          ],
        }),
        201,
      );
    }),
    http.post(api('invoices/:id/send'), async ({ request }) => {
      calls.sent.push(await request.json());
      return ok(invoice(5));
    }),
  );
  return calls;
}

function open(
  path: string,
  locale: 'en' | 'ar' = 'en',
  role: 'OFFICE_MANAGER' | 'TRAINEE' = 'OFFICE_MANAGER',
) {
  setViewport(1280);
  signedIn({
    role,
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor(role)],
  });
  renderApp(path, locale);
}

describe('invoices page (MVP-148)', () => {
  it(
    'should list invoices with an overdue one marked in words, and write the filters into the URL',
    { timeout: SLOW },
    async () => {
      const calls = serve([
        invoice(1),
        invoice(2, { status: 'OVERDUE', dueDate: '2026-10-01' }),
        invoice(3, { status: 'DRAFT', invoiceNumber: null }),
      ]);
      open('/invoices');
      const table = await screen.findByTestId('invoices-table', {}, { timeout: COLD });
      expect(table.textContent).toContain('INV-2026-0001');
      expect(table.textContent).toContain('Overdue');
      expect(table.textContent).toContain('Draft');
      expect(table.textContent).toContain('₪116.00');
      fireEvent.mouseDown(
        within(screen.getByTestId('invoices-filter-status')).getByRole('combobox'),
      );
      fireEvent.click(await screen.findByTitle('Overdue'));
      await waitFor(() => expect(calls.list.at(-1)).toContain('status=OVERDUE'));
    },
  );

  it(
    'should mark an invoice paid, void one after a confirm, and open a ready PDF',
    { timeout: SLOW },
    async () => {
      const calls = serve([invoice(1)]);
      const clicked: string[] = [];
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        clicked.push(this.href);
      });
      open('/invoices');
      const id = invoice(1).id;
      fireEvent.click(await screen.findByTestId(`invoice-pay-${id}`, {}, { timeout: COLD }));
      fireEvent.click(await screen.findByTestId('invoice-paid-confirm'));
      await waitFor(() => expect(calls.paid).toHaveLength(1));
      expect(calls.paid[0]).toMatchObject({ method: 'BANK_TRANSFER' });

      fireEvent.click(screen.getByTestId(`invoice-void-${id}`));
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Void' }),
      );
      await waitFor(() => expect(calls.voided).toEqual([id]));

      fireEvent.click(screen.getByTestId(`invoice-pdf-${id}`));
      await waitFor(() => expect(clicked).toEqual(['https://s3.test/i.pdf']));
      click.mockRestore();
    },
  );

  it('should be accessible in Arabic', { timeout: SLOW }, async () => {
    serve([invoice(1), invoice(2, { status: 'OVERDUE' })]);
    open('/invoices', 'ar');
    await screen.findByTestId('invoices-table', {}, { timeout: COLD });
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('invoices-table').textContent).toContain('متأخرة');
    const { violations } = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});

describe('generate-invoice wizard and retainer in the billing tab (MVP-148)', () => {
  const FILE = CaseSchema.parse({
    id: FILE_ID,
    fileNumber: '2026-LIT-00007',
    title: 'Land dispute',
    fileType: 'LITIGATION',
    status: 'OPEN',
    priority: 'HIGH',
    openingDate: '2026-10-01',
    isConfidential: false,
    primaryClient: CLIENT,
    responsibleLawyer: { id: USER.id, fullName: 'Sami Nasser' },
    updatedAt: NOW,
    description: null,
    subType: null,
    closingDate: null,
    responsibleParalegal: null,
    courtCaseNumber: null,
    court: null,
    judge: null,
    jurisdiction: 'PALESTINE',
    billingMethod: 'HOURLY',
    hourlyRate: '150.00',
    fixedFee: null,
    retainerBalance: '500.00',
    currency: 'ILS',
    clients: [{ ...CLIENT, clientType: 'INDIVIDUAL', isPrimary: true }],
    team: [],
    counts: { parties: 0, notes: 0 },
    createdAt: NOW,
  });

  it(
    'should draft from the period with an extra item, show the server totals and send with the email',
    { timeout: SLOW },
    async () => {
      const calls = serve([]);
      const deposits: unknown[] = [];
      server.use(
        http.get(api(`cases/${FILE_ID}`), () => ok(FILE)),
        http.get(api('time-entries'), () => page([])),
        http.get(api('time-entries/timer'), () => ok(null)),
        http.get(api(`cases/${FILE_ID}/time-totals`), () =>
          ok({
            currency: 'ILS',
            billableHours: '0',
            nonBillableHours: '0',
            unbilledHours: '0',
            billableAmount: '0',
            unbilledAmount: '0',
          }),
        ),
        http.get(api(`cases/${FILE_ID}/retainer`), () =>
          ok({ fileId: FILE_ID, currency: 'ILS', balance: '500.00', entries: [] }),
        ),
        http.post(api(`cases/${FILE_ID}/retainer/deposit`), async ({ request }) => {
          deposits.push(await request.json());
          return ok({ fileId: FILE_ID, currency: 'ILS', balance: '600.00', entries: [] }, 201);
        }),
      );
      open(`/cases/${FILE_ID}?tab=billing`);
      expect(
        (await screen.findByTestId('retainer-balance', {}, { timeout: COLD })).textContent,
      ).toBe('₪500.00');

      fireEvent.click(screen.getByTestId('retainer-deposit'));
      fireEvent.change(await screen.findByTestId('retainer-amount'), { target: { value: '100' } });
      fireEvent.click(screen.getByTestId('retainer-deposit-confirm'));
      await waitFor(() => expect(deposits).toHaveLength(1));
      expect(deposits[0]).toMatchObject({ amount: '100', method: 'BANK_TRANSFER' });

      fireEvent.click(screen.getByTestId('invoice-generate'));
      fireEvent.click(await screen.findByTestId('invoice-line-add'));
      fireEvent.change(screen.getByTestId('invoice-line-description-0'), {
        target: { value: 'Court fee' },
      });
      // A bad price shows on its own row and sends nothing.
      fireEvent.change(screen.getByTestId('invoice-line-price-0'), { target: { value: 'abc' } });
      fireEvent.click(screen.getByTestId('invoice-prepare'));
      await waitFor(() =>
        expect(
          screen
            .getByTestId('invoice-line-price-0')
            .closest('.ant-form-item')
            ?.querySelector('.ant-form-item-explain-error'),
        ).not.toBeNull(),
      );
      expect(calls.drafts).toHaveLength(0);
      fireEvent.change(screen.getByTestId('invoice-line-price-0'), { target: { value: '20' } });
      fireEvent.click(screen.getByTestId('invoice-prepare'));
      await waitFor(() => expect(calls.drafts).toHaveLength(1));
      expect(calls.drafts[0]).toMatchObject({
        clientId: CLIENT.id,
        fileId: FILE_ID,
        includeTax: true,
        extraLines: [{ description: 'Court fee', quantity: '1', unitPrice: '20' }],
      });
      const totals = await screen.findByTestId('invoice-totals');
      expect(totals.textContent).toContain('₪245.00');
      expect(totals.textContent).toContain('₪39.20');
      expect(totals.textContent).toContain('₪284.20');

      fireEvent.click(screen.getByTestId('invoice-email-client'));
      fireEvent.click(screen.getByTestId('invoice-draft-send'));
      await waitFor(() => expect(calls.sent).toEqual([{ emailClient: true }]));
    },
  );
});
