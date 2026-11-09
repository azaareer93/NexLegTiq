import { CaseSchema } from '@nexlegtiq/shared-contracts';
import type { TimeEntry } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
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
  USER,
} from '../../test/render-app';

setupTestServer();

const COLD = 20_000;
const SLOW = 60_000;
const ID = '01920000-0000-7000-8000-0000000001f1';
const LAWYER = '01920000-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-11-09T10:00:00.000Z');

const FILE = CaseSchema.parse({
  id: ID,
  fileNumber: '2026-LIT-00007',
  title: 'Land dispute',
  fileType: 'LITIGATION',
  status: 'OPEN',
  priority: 'HIGH',
  openingDate: '2026-10-01',
  isConfidential: false,
  primaryClient: { id: '01920000-0000-7000-8000-0000000000c1', displayName: 'Omar Khalil' },
  responsibleLawyer: { id: LAWYER, fullName: 'Sami Nasser' },
  updatedAt: '2026-10-05T09:00:00.000Z',
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
  retainerBalance: null,
  currency: 'ILS',
  clients: [
    {
      id: '01920000-0000-7000-8000-0000000000c1',
      displayName: 'Omar Khalil',
      clientType: 'INDIVIDUAL',
      isPrimary: true,
    },
  ],
  team: [{ id: LAWYER, fullName: 'Sami Nasser', role: 'RESPONSIBLE_LAWYER' }],
  counts: { parties: 0, notes: 0 },
  createdAt: '2026-10-01T09:00:00.000Z',
});

const FILE_REF = { id: ID, fileNumber: FILE.fileNumber, title: FILE.title };
const entry = (n: number, extra: Partial<TimeEntry> = {}): TimeEntry => ({
  id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  file: FILE_REF,
  user: { id: LAWYER, fullName: 'Sami Nasser' },
  workDate: '2026-11-08',
  durationHours: '1.50',
  description: `Work ${n}`,
  isBillable: true,
  hourlyRate: '150.00',
  amount: '225.00',
  currency: 'ILS',
  invoiced: false,
  createdAt: '2026-11-08T09:00:00.000Z',
  updatedAt: '2026-11-08T09:00:00.000Z',
  ...extra,
});
const TOTALS = {
  currency: 'ILS',
  billableHours: '3.00',
  nonBillableHours: '0.50',
  unbilledHours: '1.50',
  billableAmount: '450.00',
  unbilledAmount: '225.00',
};
const PAGE = { pagination: { page: 1, limit: 20, total: 2, totalPages: 1, hasMore: false } };

interface Calls {
  posted: unknown[];
  patched: unknown[];
  deleted: string[];
  stopped: unknown[];
  started: unknown[];
  discarded: number;
}

function serve(rows: TimeEntry[], options: { timer?: boolean } = {}) {
  const calls: Calls = {
    posted: [],
    patched: [],
    deleted: [],
    stopped: [],
    started: [],
    discarded: 0,
  };
  let running = options.timer ?? false;
  const timer = () => ({
    id: '01920000-0000-7000-8000-0000000009b1',
    file: FILE_REF,
    description: null,
    startedAt: new Date(NOW.getTime() - 65_000).toISOString(),
  });
  server.use(
    http.get(api(`cases/${ID}`), () => ok(FILE)),
    http.get(api('time-entries'), () =>
      HttpResponse.json({
        success: true,
        data: rows,
        meta: { timestamp: NOW.toISOString(), requestId: 'req-12345678', ...PAGE },
      }),
    ),
    http.get(api('time-entries/timer'), () => ok(running ? timer() : null)),
    http.get(api(`cases/${ID}/time-totals`), () => ok(TOTALS)),
    http.post(api('time-entries'), async ({ request }) => {
      calls.posted.push(await request.json());
      return ok(entry(9), 201);
    }),
    http.patch(api('time-entries/:id'), async ({ request }) => {
      calls.patched.push(await request.json());
      return ok(entry(1));
    }),
    http.delete(api('time-entries/timer'), () => {
      calls.discarded += 1;
      running = false;
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(api('time-entries/:id'), ({ params }) => {
      calls.deleted.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(api('time-entries/timer/start'), async ({ request }) => {
      calls.started.push(await request.json());
      running = true;
      return ok(timer(), 201);
    }),
    http.post(api('time-entries/timer/stop'), async ({ request }) => {
      calls.stopped.push(await request.json());
      running = false;
      return ok(entry(8), 201);
    }),
  );
  return calls;
}

async function openBilling(
  locale: 'en' | 'ar' = 'en',
  permissions = permissionsFor('OFFICE_MANAGER'),
) {
  setViewport(1280);
  signedIn({
    id: LAWYER,
    role: USER.role,
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissions],
  });
  renderApp(`/cases/${ID}?tab=billing`, locale);
  return screen.findByTestId('billing-tab', {}, { timeout: COLD });
}

describe('Billing tab (D-152)', () => {
  it(
    'should show entries with money, totals and a read-only invoiced row',
    async () => {
      serve([entry(1), entry(2, { invoiced: true })]);
      const tab = await openBilling();
      const table = await within(tab).findByTestId('billing-table');
      expect(within(table).getAllByText('₪225.00').length).toBeGreaterThan(0);
      expect(within(table).getAllByText('₪150.00').length).toBeGreaterThan(0);
      expect(within(table).getAllByText('08/11/2026').length).toBe(2);
      expect(within(table).getByTitle('Invoiced entries can no longer be changed.')).toBeTruthy();
      const totals = within(await screen.findByTestId('billing-totals'));
      expect(totals.getByText('₪450.00')).toBeTruthy();
      expect(totals.getByText('1.5 h')).toBeTruthy();
      expect(screen.getByTestId(`entry-edit-${entry(1).id}`)).toBeTruthy();
      expect(screen.queryByTestId(`entry-edit-${entry(2).id}`)).toBeNull();
      expect(screen.queryByTestId(`entry-delete-${entry(2).id}`)).toBeNull();
    },
    SLOW,
  );

  it(
    'should show a dash where the API sends no rate or amount',
    async () => {
      serve([entry(1, { hourlyRate: null, amount: null })]);
      const tab = await openBilling();
      const table = await within(tab).findByTestId('billing-table');
      expect(within(table).queryByText('₪225.00')).toBeNull();
      expect(within(table).getAllByText('—').length).toBeGreaterThanOrEqual(3);
    },
    SLOW,
  );

  it(
    'should log time with the contract body',
    async () => {
      const calls = serve([entry(1)]);
      await openBilling();
      fireEvent.click(await screen.findByTestId('entry-add'));
      fireEvent.change(await screen.findByTestId('entry-hours'), { target: { value: '1.5' } });
      fireEvent.change(screen.getByTestId('entry-description'), {
        target: { value: 'Drafting' },
      });
      fireEvent.click(screen.getByTestId('entry-save'));
      await waitFor(() =>
        expect(calls.posted).toEqual([
          { fileId: ID, durationHours: '1.5', description: 'Drafting', isBillable: true },
        ]),
      );
    },
    SLOW,
  );

  it(
    'should refuse bad hours before sending',
    async () => {
      const calls = serve([entry(1)]);
      await openBilling();
      fireEvent.click(await screen.findByTestId('entry-add'));
      fireEvent.change(await screen.findByTestId('entry-hours'), { target: { value: '30' } });
      fireEvent.change(screen.getByTestId('entry-description'), { target: { value: 'x' } });
      fireEvent.click(screen.getByTestId('entry-save'));
      expect(await screen.findByText(/between 0\.01 and 24/)).toBeTruthy();
      expect(calls.posted).toEqual([]);
    },
    SLOW,
  );

  it(
    'should send only the changed field when editing, and say why an invoiced entry is refused',
    async () => {
      const calls = serve([entry(1)]);
      await openBilling();
      fireEvent.click(await screen.findByTestId(`entry-edit-${entry(1).id}`));
      fireEvent.change(await screen.findByTestId('entry-description'), {
        target: { value: 'Reworked' },
      });
      fireEvent.click(screen.getByTestId('entry-save'));
      await waitFor(() => expect(calls.patched).toEqual([{ description: 'Reworked' }]));

      // It was invoiced in another tab meanwhile: the API refuses with BIZ-006.
      server.use(http.patch(api('time-entries/:id'), () => fail(422, 'BIZ-006')));
      fireEvent.click(await screen.findByTestId(`entry-edit-${entry(1).id}`));
      fireEvent.change(await screen.findByTestId('entry-description'), {
        target: { value: 'Again' },
      });
      fireEvent.click(screen.getByTestId('entry-save'));
      expect(await screen.findByText('This invoice can no longer be changed.')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should delete after a confirm',
    async () => {
      const calls = serve([entry(1)]);
      await openBilling();
      fireEvent.click(await screen.findByTestId(`entry-delete-${entry(1).id}`));
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
      );
      await waitFor(() => expect(calls.deleted).toEqual([entry(1).id]));
    },
    SLOW,
  );

  it(
    'should offer no writes on an archived file',
    async () => {
      serve([entry(1)]);
      server.use(http.get(api(`cases/${ID}`), () => ok({ ...FILE, status: 'ARCHIVED' })));
      await openBilling();
      await screen.findByTestId('billing-table');
      expect(screen.queryByTestId('entry-add')).toBeNull();
      expect(screen.queryByTestId(`entry-edit-${entry(1).id}`)).toBeNull();
    },
    SLOW,
  );
});

describe('Billing tab without log:time or case-wide reading', () => {
  it(
    'should show only the totals and a note to an admin, without asking for entries',
    async () => {
      serve([entry(1)]);
      server.use(http.get(api('time-entries'), () => fail(403, 'AUTH-100')));
      const tab = await openBilling('en', permissionsFor('ADMIN'));
      expect(await within(tab).findByTestId('billing-totals')).toBeTruthy();
      expect(within(tab).getByTestId('entries-note')).toBeTruthy();
      expect(within(tab).queryByTestId('billing-table')).toBeNull();
      expect(within(tab).queryByTestId('entry-add')).toBeNull();
    },
    SLOW,
  );

  it(
    'should explain the totals to someone who does not read every case',
    async () => {
      serve([entry(1)]);
      const tab = await openBilling(
        'en',
        permissionsFor('OFFICE_MANAGER').filter((p) => p !== 'view:all:cases'),
      );
      expect(await within(tab).findByTestId('totals-hint')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should go back to the last page when a delete empties the one shown',
    async () => {
      serve([]);
      const pages: string[] = [];
      server.use(
        http.get(api('time-entries'), ({ request }) => {
          const page = new URL(request.url).searchParams.get('page') ?? '1';
          pages.push(page);
          return HttpResponse.json({
            success: true,
            data: page === '2' ? [] : [entry(1)],
            meta: {
              timestamp: NOW.toISOString(),
              requestId: 'req-12345678',
              pagination: {
                page: Number(page),
                limit: 20,
                total: page === '2' ? 15 : 25,
                totalPages: 2,
                hasMore: page === '1',
              },
            },
          });
        }),
      );
      await openBilling();
      const next = await screen.findByTitle('Next Page', {}, { timeout: COLD });
      fireEvent.click(next);
      await waitFor(() => expect(pages).toContain('2'));
      await waitFor(() => expect(pages.slice(-1)).toEqual(['1']));
    },
    SLOW,
  );
});

describe('Timer widget (D-152)', () => {
  it(
    'should count up, then log the time with a description on stop',
    async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
      vi.setSystemTime(NOW);
      const calls = serve([], { timer: true });
      await openBilling();
      const clock = await screen.findByTestId('timer-elapsed', {}, { timeout: COLD });
      expect(clock.textContent).toBe('00:01:05');
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByTestId('timer-elapsed').textContent).toBe('00:01:08');
      expect(screen.getByTestId('timer-widget').textContent).toContain('2026-LIT-00007');
      fireEvent.click(screen.getByTestId('timer-stop'));
      fireEvent.click(await screen.findByTestId('timer-save'));
      expect(
        await screen.findByText('This field is required.', {}, { timeout: 5000 }),
      ).toBeTruthy();
      fireEvent.change(screen.getByTestId('timer-description'), { target: { value: 'Hearing' } });
      fireEvent.click(screen.getByTestId('timer-save'));
      await waitFor(() =>
        expect(calls.stopped).toEqual([{ description: 'Hearing', isBillable: true }]),
      );
      await waitFor(() => expect(screen.queryByTestId('timer-widget')).toBeNull());
    },
    SLOW,
  );

  it(
    'should discard the timer after a confirm',
    async () => {
      const calls = serve([], { timer: true });
      await openBilling();
      fireEvent.click(await screen.findByTestId('timer-discard', {}, { timeout: COLD }));
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Discard' }),
      );
      await waitFor(() => expect(calls.discarded).toBe(1));
      await waitFor(() => expect(screen.queryByTestId('timer-widget')).toBeNull());
    },
    SLOW,
  );

  it(
    'should start the timer on the file being viewed',
    async () => {
      const calls = serve([]);
      await openBilling();
      fireEvent.click(await screen.findByTestId('timer-start', {}, { timeout: COLD }));
      await waitFor(() => expect(calls.started).toEqual([{ fileId: ID }]));
      expect(await screen.findByTestId('timer-widget')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should offer to discard a running timer the start call collides with (409)',
    async () => {
      const calls = serve([]);
      server.use(http.post(api('time-entries/timer/start'), () => fail(409, 'RES-002')));
      await openBilling();
      fireEvent.click(await screen.findByTestId('timer-start', {}, { timeout: COLD }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Discard the running timer' }));
      await waitFor(() => expect(calls.discarded).toBe(1));
      expect(await screen.findByText('The timer was discarded. You can start again.')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show the running timer, not the discard offer, when it was started in another tab',
    async () => {
      const calls = serve([]);
      let other = false;
      server.use(
        http.get(api('time-entries/timer'), () =>
          ok(
            other
              ? {
                  id: '01920000-0000-7000-8000-0000000009b1',
                  file: FILE_REF,
                  description: null,
                  startedAt: NOW.toISOString(),
                }
              : null,
          ),
        ),
        http.post(api('time-entries/timer/start'), () => {
          other = true;
          return fail(409, 'RES-002');
        }),
      );
      await openBilling();
      fireEvent.click(await screen.findByTestId('timer-start', {}, { timeout: COLD }));
      expect(await screen.findByTestId('timer-widget')).toBeTruthy();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(calls.discarded).toBe(0);
    },
    SLOW,
  );

  it(
    'should not offer Start on an archived case in the header',
    async () => {
      serve([entry(1)]);
      server.use(http.get(api(`cases/${ID}`), () => ok({ ...FILE, status: 'ARCHIVED' })));
      await openBilling();
      await screen.findByTestId('billing-table');
      expect(screen.queryByTestId('timer-start')).toBeNull();
    },
    SLOW,
  );

  it(
    'should not show for a role without log:time',
    async () => {
      serve([]);
      await openBilling(
        'en',
        permissionsFor('OFFICE_MANAGER').filter((p) => p !== 'log:time'),
      );
      await screen.findByTestId('billing-table').catch(() => undefined);
      expect(screen.queryByTestId('timer-start')).toBeNull();
      expect(screen.queryByTestId('entry-add')).toBeNull();
    },
    SLOW,
  );
});

describe('accessibility', () => {
  it.each(['en', 'ar'] as const)(
    'should have no violations (%s)',
    async (locale) => {
      serve([entry(1), entry(2, { invoiced: true })]);
      const tab = await openBilling(locale);
      await within(tab).findByTestId('billing-table');
      if (locale === 'ar') expect(within(tab).getAllByText('مفوتَر').length).toBeGreaterThan(0);
      const results = await axe.run(tab, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );
});
