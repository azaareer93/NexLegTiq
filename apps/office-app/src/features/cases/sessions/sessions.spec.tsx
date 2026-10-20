import type { Case, Session, SessionListItem } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
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
} from '../../../test/render-app';

setupTestServer();

const SLOW = 60_000;

/** Text without the Unicode isolates names and values are wrapped in (D-092). */
const ISOLATES = new RegExp(
  `[${String.fromCodePoint(0x2066)}-${String.fromCodePoint(0x2069)}]`,
  'g',
);
const plain = (element: HTMLElement) => (element.textContent ?? '').replace(ISOLATES, '');
const COLD = 20_000;

const FILE_ID = '01920000-0000-7000-8000-0000000001f1';
const LAWYER_ID = '01920000-0000-7000-8000-0000000000a1';
const SESSION_ID = '01920000-0000-7000-8000-0000000005a1';
const PAST_ID = '01920000-0000-7000-8000-0000000005a2';

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

const UPCOMING: SessionListItem = {
  id: SESSION_ID,
  file: { id: FILE_ID, fileNumber: FILE.fileNumber, title: FILE.title },
  sessionType: 'HEARING',
  status: 'SCHEDULED',
  // 09:30 in Hebron.
  startsAt: '2099-11-02T07:30:00.000Z',
  endsAt: null,
  court: {
    id: '01920000-0000-7000-8000-0000000000d1',
    nameAr: 'محكمة الصلح',
    nameEn: 'Magistrate Court',
  },
  judge: { id: '01920000-0000-7000-8000-0000000000e1', fullName: 'Judge Hani' },
  courtRoom: '3',
  attendingLawyer: { id: LAWYER_ID, fullName: 'Sami Nasser' },
  reminderDays: [7, 1],
  outcome: null,
  nextSessionId: null,
  previousSessionId: null,
  cancellationReason: null,
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
};
const PAST: SessionListItem = {
  ...UPCOMING,
  id: PAST_ID,
  startsAt: '2026-09-01T07:30:00.000Z',
  court: null,
  judge: null,
  courtRoom: null,
  reminderDays: [],
};
const full = (item: SessionListItem, extra: Partial<Session> = {}): Session => ({
  ...item,
  minutes: null,
  reminders: [
    {
      id: '01920000-0000-7000-8000-0000000006a1',
      daysBefore: 7,
      scheduledFor: '2099-10-26T07:00:00.000Z',
      status: 'SENT',
      recipient: { id: LAWYER_ID, fullName: 'Sami Nasser' },
      sentAt: '2099-10-26T07:00:00.000Z',
      acknowledgedAt: null,
    },
  ],
  ...extra,
});

const page = (items: SessionListItem[]) =>
  HttpResponse.json({
    success: true,
    data: items,
    meta: {
      timestamp: '2026-10-05T10:00:00.000Z',
      requestId: 'req-12345678',
      pagination: { page: 1, limit: 10, total: items.length, totalPages: 1, hasMore: false },
    },
  });

const asRole = (role: Role, uiLanguage: 'AR' | 'EN' = 'EN') =>
  signedIn({ id: LAWYER_ID, role, uiLanguage, permissions: [...permissionsFor(role)] });

type Write = { method: string; path: string; body: unknown };

/** The file, its two hearing lists, the directory and every session route; writes are recorded. */
function serve({ upcoming = [UPCOMING], past = [PAST] } = {}): Write[] {
  const writes: Write[] = [];
  const record =
    (method: string, answer: (body: unknown) => Response) =>
    async ({ request }: { request: Request }) => {
      const body: unknown = await request.json();
      writes.push({ method, path: new URL(request.url).pathname, body });
      return answer(body);
    };
  server.use(
    http.get(api(`cases/${FILE_ID}`), () => ok(FILE)),
    http.get(api(`cases/${FILE_ID}/sessions`), ({ request }) =>
      page(new URL(request.url).searchParams.get('when') === 'past' ? past : upcoming),
    ),
    http.get(api('users/directory'), () =>
      ok([{ id: LAWYER_ID, fullName: 'Sami Nasser', role: 'LAWYER' }]),
    ),
    http.get(api(`sessions/${SESSION_ID}`), () => ok(full(UPCOMING))),
    http.get(api(`sessions/${PAST_ID}`), () => ok(full(PAST, { reminders: [] }))),
    http.post(
      api('sessions'),
      record('POST', () => ok(full(UPCOMING), 201)),
    ),
    http.patch(
      api(`sessions/${SESSION_ID}`),
      record('PATCH', () => ok(full(UPCOMING))),
    ),
    http.post(
      api(`sessions/${SESSION_ID}/cancel`),
      record('POST', () => ok(full(UPCOMING))),
    ),
    http.post(
      api(`sessions/${PAST_ID}/outcome`),
      record('POST', () => ok(full(PAST))),
    ),
  );
  return writes;
}

const openTab = async (locale: 'en' | 'ar' = 'en') => {
  renderApp(`/cases/${FILE_ID}?tab=sessions`, locale);
  return screen.findByTestId('case-sessions', {}, { timeout: COLD });
};

/** Types into an AntD date or time picker and confirms with Enter. */
function typeInto(testId: string, value: string): void {
  const input = screen.getByTestId(testId).querySelector('input') ?? screen.getByTestId(testId);
  fireEvent.mouseDown(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
}

describe('hearings tab (MVP-69)', () => {
  it(
    'should list upcoming and past hearings with their details',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve();
      const tab = await openTab();
      const row = await within(tab).findByTestId(
        `session-row-${SESSION_ID}`,
        {},
        { timeout: COLD },
      );
      expect(plain(row)).toContain('Magistrate Court · Room 3 · Judge: Judge Hani');
      expect(plain(row)).toContain('Attending lawyer: Sami Nasser');
      expect(plain(row)).toContain('Reminders (days before): 7, 1');
      // 07:30 UTC is 09:30 in Hebron, the office zone.
      expect(row.textContent).toContain('9:30');
      const past = within(await screen.findByTestId(`session-row-${PAST_ID}`));
      expect(past.getByText('Outcome not recorded')).toBeTruthy();
      expect(screen.getByTestId(`session-row-${PAST_ID}`).textContent).toContain('No reminders');
    },
    SLOW,
  );

  it(
    'should schedule a hearing in office time and offer "schedule anyway" on a conflict',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const writes = serve();
      let conflict = true;
      server.use(
        http.post(api('sessions'), async ({ request }) => {
          const body: unknown = await request.json();
          writes.push({ method: 'POST', path: '/api/v1/sessions', body });
          if (conflict) {
            conflict = false;
            return HttpResponse.json(
              {
                success: false,
                error: {
                  code: 'BIZ-004',
                  message: 'dev BIZ-004',
                  details: [
                    {
                      field: 'startsAt',
                      message: 'validation.sessionConflict',
                      params: {
                        sessionId: 's1',
                        startsAt: '2099-11-02T07:00:00.000Z',
                        endsAt: null,
                        fileNumber: '2026-LIT-00099',
                      },
                    },
                    {
                      field: 'startsAt',
                      message: 'validation.sessionConflict',
                      params: {
                        sessionId: null,
                        startsAt: '2099-11-02T08:00:00.000Z',
                        endsAt: null,
                        fileNumber: null,
                      },
                    },
                  ],
                },
                meta: { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' },
              },
              { status: 409 },
            );
          }
          return ok(full(UPCOMING), 201);
        }),
      );
      await openTab();
      fireEvent.click(await screen.findByTestId('session-new'));
      const drawer = await screen.findByTestId('session-drawer');
      expect(within(drawer).getByTestId('session-time-zone').textContent).toContain('Asia/Hebron');
      typeInto('session-date', '02/11/2099');
      typeInto('session-start', '09:30');
      fireEvent.click(within(drawer).getByTestId('session-save'));
      const alert = await within(drawer).findByTestId('session-conflict');
      expect(alert.textContent).toContain('2026-LIT-00099');
      expect(alert.textContent).toContain('A hearing on a file you cannot open');
      expect(writes[0]?.body).toEqual({
        fileId: FILE_ID,
        sessionType: 'HEARING',
        startsAt: '2099-11-02T09:30:00+02:00',
        attendingLawyerId: LAWYER_ID,
        acknowledgeConflict: false,
      });
      fireEvent.click(within(alert).getByTestId('session-conflict-anyway'));
      await waitFor(() => expect(writes[1]?.body).toMatchObject({ acknowledgeConflict: true }));
      expect(await screen.findByText('Hearing scheduled.')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should add a court and a judge inline and pick them',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve();
      const court = {
        id: '01920000-0000-7000-8000-0000000000d9',
        jurisdiction: 'PALESTINE',
        courtType: 'MAGISTRATE',
        nameAr: 'محكمة صلح جنين',
        nameEn: null,
        city: null,
        address: null,
        phone: null,
        email: null,
        isActive: true,
        notes: null,
        isPlatform: false,
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:00:00.000Z',
      };
      const judge = {
        id: '01920000-0000-7000-8000-0000000000e9',
        courtId: court.id,
        fullName: 'Judge Amal',
        notes: null,
        isActive: true,
        isPlatform: false,
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:00:00.000Z',
      };
      const bodies: unknown[] = [];
      server.use(
        http.get(api('courts'), () => page([] as never)),
        http.post(api('courts'), async ({ request }) => {
          bodies.push(await request.json());
          return ok(court, 201);
        }),
        http.get(api(`courts/${court.id}/judges`), () => ok(bodies.length > 1 ? [judge] : [])),
        http.post(api(`courts/${court.id}/judges`), async ({ request }) => {
          bodies.push(await request.json());
          return ok(judge, 201);
        }),
      );
      await openTab();
      fireEvent.click(await screen.findByTestId('session-new'));
      const select = await screen.findByTestId('create-court');
      fireEvent.mouseDown(select.querySelector('.ant-select-selector') ?? select);
      fireEvent.click(await screen.findByTestId('create-court-new'));
      const modal = await screen.findByTestId('new-court-modal');
      fireEvent.change(within(modal).getByTestId('new-court-name'), {
        target: { value: 'محكمة صلح جنين' },
      });
      const type = within(modal).getByTestId('new-court-type');
      fireEvent.mouseDown(type.querySelector('.ant-select-selector') ?? type);
      fireEvent.click(await screen.findByTitle('Magistrate'));
      fireEvent.click(screen.getByTestId('new-court-save'));
      await waitFor(() =>
        expect(bodies[0]).toEqual({ nameAr: 'محكمة صلح جنين', courtType: 'MAGISTRATE' }),
      );
      await waitFor(() =>
        expect(screen.getByTestId('create-court').textContent).toContain('محكمة صلح جنين'),
      );
      const judges = screen.getByTestId('create-judge');
      fireEvent.mouseDown(judges.querySelector('.ant-select-selector') ?? judges);
      fireEvent.click(await screen.findByTestId('create-judge-new'));
      fireEvent.change(await screen.findByTestId('new-judge-name'), {
        target: { value: 'Judge Amal' },
      });
      fireEvent.click(screen.getByTestId('new-judge-save'));
      await waitFor(() => expect(bodies[1]).toEqual({ fullName: 'Judge Amal' }));
      await waitFor(() =>
        expect(screen.getByTestId('create-judge').textContent).toContain('Judge Amal'),
      );
    },
    SLOW,
  );

  it(
    'should open the drawer with Ctrl+Alt+H',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve();
      await openTab();
      fireEvent.keyDown(window, { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true });
      expect(await screen.findByTestId('session-create-form')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should be read-only for a trainee: no schedule button, the shortcut does nothing',
    async () => {
      setViewport(1280);
      asRole('TRAINEE');
      serve();
      const tab = await openTab();
      await within(tab).findByTestId(`session-row-${SESSION_ID}`, {}, { timeout: COLD });
      expect(screen.queryByTestId('session-new')).toBeNull();
      fireEvent.keyDown(window, { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true });
      expect(screen.queryByTestId('session-create-form')).toBeNull();
      fireEvent.click(screen.getByTestId(`session-row-${SESSION_ID}`));
      expect(await screen.findByTestId('session-summary')).toBeTruthy();
      expect(screen.queryByTestId('session-edit-form')).toBeNull();
    },
    SLOW,
  );

  it(
    'should edit only what changed, show the reminders, and cancel with a reason',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const writes = serve();
      await openTab();
      fireEvent.click(
        await screen.findByTestId(`session-row-${SESSION_ID}`, {}, { timeout: COLD }),
      );
      const form = await screen.findByTestId('session-edit-form');
      expect(plain(screen.getByTestId('session-reminders-list'))).toContain(
        '7 days before · Sami Nasser',
      );
      expect(screen.getByTestId('session-not-started')).toBeTruthy();
      fireEvent.change(within(form).getByTestId('session-room'), { target: { value: '5' } });
      fireEvent.click(within(form).getByTestId('session-save'));
      await waitFor(() =>
        expect(writes[0]).toEqual({
          method: 'PATCH',
          path: `/api/v1/sessions/${SESSION_ID}`,
          body: { courtRoom: '5', acknowledgeConflict: false },
        }),
      );
      fireEvent.click(await screen.findByTestId(`session-row-${SESSION_ID}`));
      fireEvent.click(await screen.findByTestId('session-cancel'));
      fireEvent.change(await screen.findByTestId('session-cancel-reason'), {
        target: { value: 'Court strike' },
      });
      fireEvent.click(screen.getByTestId('confirm-ok'));
      await waitFor(() =>
        expect(writes[1]).toEqual({
          method: 'POST',
          path: `/api/v1/sessions/${SESSION_ID}/cancel`,
          body: { reason: 'Court strike' },
        }),
      );
    },
    SLOW,
  );

  it(
    'should record the outcome and minutes of a past hearing, with the AI summary waiting',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const writes = serve();
      await openTab();
      fireEvent.click(await screen.findByTestId(`session-row-${PAST_ID}`, {}, { timeout: COLD }));
      const outcome = await screen.findByTestId('session-outcome');
      expect(within(outcome).getByTestId('session-ai-summary').closest('button')?.disabled).toBe(
        true,
      );
      fireEvent.mouseDown(
        within(outcome)
          .getByTestId('session-outcome-select')
          .querySelector('.ant-select-selector') ??
          within(outcome).getByTestId('session-outcome-select'),
      );
      fireEvent.click(await screen.findByTitle('Adjourned'));
      fireEvent.change(within(outcome).getByTestId('session-minutes'), {
        target: { value: '  Adjourned for witnesses. ' },
      });
      fireEvent.click(within(outcome).getByTestId('session-outcome-save'));
      await waitFor(() =>
        expect(writes[0]).toEqual({
          method: 'POST',
          path: `/api/v1/sessions/${PAST_ID}/outcome`,
          body: { outcome: 'ADJOURNED', minutes: 'Adjourned for witnesses.' },
        }),
      );
    },
    SLOW,
  );

  it(
    'should show the next scheduled hearing on the Details tab and open it',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve({ upcoming: [{ ...UPCOMING, id: PAST_ID, status: 'CANCELLED' }, UPCOMING] });
      renderApp(`/cases/${FILE_ID}`);
      const card = await screen.findByTestId('case-card-next-hearing', {}, { timeout: COLD });
      await within(card).findByText('Sami Nasser');
      fireEvent.click(within(card).getByTestId('next-hearing-open'));
      expect(await screen.findByTestId('session-summary')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should schedule the next hearing with the outcome, and resend a conflict as acknowledged',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const writes = serve();
      let conflict = true;
      server.use(
        http.post(api(`sessions/${PAST_ID}/outcome`), async ({ request }) => {
          writes.push({ method: 'POST', path: 'outcome', body: await request.json() });
          if (!conflict) return ok(full(PAST));
          conflict = false;
          return new HttpResponse(
            '{"success":false,"error":{"code":"BIZ-004","message":"dev BIZ-004","details":[{"field":"nextSession.startsAt","message":"validation.sessionConflict","params":{"sessionId":null,"startsAt":"2099-11-03T07:00:00.000Z","endsAt":null,"fileNumber":null}}]},"meta":{"timestamp":"2026-10-05T10:00:00.000Z","requestId":"req-12345678"}}',
            {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }),
      );
      await openTab();
      fireEvent.click(await screen.findByTestId(`session-row-${PAST_ID}`, {}, { timeout: COLD }));
      const outcome = await screen.findByTestId('session-outcome');
      const select = within(outcome).getByTestId('session-outcome-select');
      fireEvent.mouseDown(select.querySelector('.ant-select-selector') ?? select);
      fireEvent.click(await screen.findByTitle('Adjourned'));
      const next = within(outcome).getByTestId('session-schedule-next');
      fireEvent.click(next.querySelector('input') ?? next);
      await screen.findByTestId('session-next-date');
      typeInto('session-next-date', '03/11/2099');
      typeInto('session-next-start', '09:00');
      fireEvent.click(within(outcome).getByTestId('session-outcome-save'));
      fireEvent.click(await within(outcome).findByTestId('session-conflict-anyway'));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[0]?.body).toEqual({
        outcome: 'ADJOURNED',
        nextSession: { startsAt: '2099-11-03T09:00:00+02:00', acknowledgeConflict: false },
      });
      expect(writes[1]?.body).toMatchObject({ nextSession: { acknowledgeConflict: true } });
    },
    SLOW,
  );

  it(
    'should show a conflict on edit and resend only the changed fields as acknowledged',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      const writes = serve();
      let conflict = true;
      server.use(
        http.patch(api(`sessions/${SESSION_ID}`), async ({ request }) => {
          writes.push({ method: 'PATCH', path: 'edit', body: await request.json() });
          if (!conflict) return ok(full(UPCOMING));
          conflict = false;
          return new HttpResponse(
            '{"success":false,"error":{"code":"BIZ-004","message":"dev BIZ-004","details":[{"field":"startsAt","message":"validation.sessionConflict","params":{"sessionId":"s2","startsAt":"2099-11-02T08:00:00.000Z","endsAt":null,"fileNumber":"2026-LIT-00098"}}]},"meta":{"timestamp":"2026-10-05T10:00:00.000Z","requestId":"req-12345678"}}',
            {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }),
      );
      await openTab();
      fireEvent.click(
        await screen.findByTestId(`session-row-${SESSION_ID}`, {}, { timeout: COLD }),
      );
      const form = await screen.findByTestId('session-edit-form');
      typeInto('session-start', '10:00');
      fireEvent.click(within(form).getByTestId('session-save'));
      const alert = await within(form).findByTestId('session-conflict');
      expect(alert.textContent).toContain('2026-LIT-00098');
      fireEvent.click(within(alert).getByTestId('session-conflict-anyway'));
      await waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[0]?.body).toEqual({
        startsAt: '2099-11-02T10:00:00+02:00',
        acknowledgeConflict: false,
      });
      expect(writes[1]?.body).toEqual({
        startsAt: '2099-11-02T10:00:00+02:00',
        acknowledgeConflict: true,
      });
    },
    SLOW,
  );

  it(
    'should refuse a missing date before sending, and put server field errors on their fields',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve();
      server.use(
        http.post(
          api('sessions'),
          () =>
            new HttpResponse(
              '{"success":false,"error":{"code":"VAL-001","message":"dev VAL-001","details":[{"field":"endsAt","message":"validation.sessionTooLong"}]},"meta":{"timestamp":"2026-10-05T10:00:00.000Z","requestId":"req-12345678"}}',
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              },
            ),
        ),
      );
      await openTab();
      fireEvent.click(await screen.findByTestId('session-new'));
      const drawer = await screen.findByTestId('session-drawer');
      fireEvent.click(within(drawer).getByTestId('session-save'));
      expect(
        (await within(drawer).findAllByText('This field is required.')).length,
      ).toBeGreaterThan(0);
      typeInto('session-date', '02/11/2099');
      typeInto('session-start', '09:30');
      fireEvent.click(within(drawer).getByTestId('session-save'));
      expect(await within(drawer).findByText('A hearing can last at most 24 hours.')).toBeTruthy();
      expect(screen.getByTestId('session-create-form')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should offer nothing on an archived file: no scheduling, no shortcut, a read-only drawer',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serve();
      server.use(http.get(api(`cases/${FILE_ID}`), () => ok({ ...FILE, status: 'ARCHIVED' })));
      const tab = await openTab();
      await within(tab).findByTestId(`session-row-${SESSION_ID}`, {}, { timeout: COLD });
      expect(screen.queryByTestId('session-new')).toBeNull();
      fireEvent.keyDown(window, { key: 'h', code: 'KeyH', ctrlKey: true, altKey: true });
      expect(screen.queryByTestId('session-create-form')).toBeNull();
      fireEvent.click(screen.getByTestId(`session-row-${PAST_ID}`));
      expect(await screen.findByTestId('session-summary')).toBeTruthy();
      expect(screen.queryByTestId('session-outcome')).toBeNull();
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should label the tab and drawer in the language and pass axe (%s)',
    async (locale) => {
      setViewport(1280);
      asRole('LAWYER', locale === 'ar' ? 'AR' : 'EN');
      serve();
      const tab = await openTab(locale);
      await within(tab).findByTestId(`session-row-${SESSION_ID}`, {}, { timeout: COLD });
      if (locale === 'ar') {
        expect(document.documentElement.dir).toBe('rtl');
        expect(within(tab).getByText('القادمة')).toBeTruthy();
      }
      const { violations } = await axe.run(tab, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    180_000,
  );
});
