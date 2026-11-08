import type { Case, TimelineEvent } from '@nexlegtiq/shared-contracts';
import { createI18n } from '@nexlegtiq/shared-i18n';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { eventSentence } from './timeline-text';
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
} from '../../../test/render-app';

setupTestServer();

const COLD = 20_000;
const SLOW = 60_000;
const ID = '01920000-0000-7000-8000-0000000001f1';
const LAWYER = '01920000-0000-7000-8000-0000000000a1';
const CLIENT = '01920000-0000-7000-8000-0000000000c1';
const SESSION = '01920000-0000-7000-8000-0000000000e9';

const FILE: Case = {
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
  description: 'Boundary of the olive grove',
  subType: null,
  closingDate: null,
  responsibleParalegal: { id: '01920000-0000-7000-8000-0000000000a2', fullName: 'Rana Odeh' },
  courtCaseNumber: '123/2026',
  court: {
    id: '01920000-0000-7000-8000-0000000000d1',
    nameAr: 'محكمة بداية رام الله',
    nameEn: 'Ramallah Court of First Instance',
    courtType: 'FIRST_INSTANCE',
  },
  judge: { id: '01920000-0000-7000-8000-0000000000e1', fullName: 'Judge Hani' },
  jurisdiction: 'PALESTINE',
  billingMethod: 'HOURLY',
  hourlyRate: '150.00',
  fixedFee: null,
  retainerBalance: '500.00',
  currency: 'ILS',
  clients: [
    {
      id: '01920000-0000-7000-8000-0000000000c1',
      displayName: 'Omar Khalil',
      clientType: 'INDIVIDUAL',
      isPrimary: true,
    },
  ],
  team: [
    { id: LAWYER, fullName: 'Sami Nasser', role: 'RESPONSIBLE_LAWYER' },
    { id: '01920000-0000-7000-8000-0000000000a2', fullName: 'Rana Odeh', role: 'PARALEGAL' },
  ],
  counts: { parties: 2, notes: 3 },
  createdAt: '2026-10-01T09:00:00.000Z',
};

const event = (n: number, eventType: string, payload: object, extra: Partial<TimelineEvent> = {}) =>
  ({
    id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    eventType,
    sourceType: null,
    sourceId: null,
    occurredAt: '2026-11-05T09:00:00.000Z',
    actor: { id: LAWYER, fullName: 'Sami Nasser' },
    payload,
    portalVisible: false,
    ...extra,
  }) as TimelineEvent;

const EVENTS = [
  event(
    5,
    'SESSION_CREATED',
    { sessionType: 'HEARING', startsAt: '2026-12-01T07:30:00.000Z' },
    {
      sourceType: 'Session',
      sourceId: SESSION,
      portalVisible: true,
    },
  ),
  event(
    4,
    'DOCUMENT_UPLOADED',
    { name: 'claim.pdf', versionNumber: 1 },
    { sourceType: 'Document' },
  ),
  event(3, 'CLIENT_ADDED', { clientId: CLIENT }),
  event(
    2,
    'FILE_OPENED',
    { fileNumber: '2026-LIT-00007' },
    {
      occurredAt: '2026-10-01T09:00:00.000Z',
      actor: null,
      portalVisible: true,
    },
  ),
];

function serve(pages: TimelineEvent[][] = [EVENTS]) {
  const queries: string[] = [];
  server.use(
    http.get(api(`cases/${ID}`), () => ok(FILE)),
    http.get(api(`cases/${ID}/sessions`), () =>
      HttpResponse.json({
        success: true,
        data: [],
        meta: {
          timestamp: '2026-11-05T10:00:00.000Z',
          requestId: 'req-12345678',
          pagination: { page: 1, limit: 10, total: 0, totalPages: 0, hasMore: false },
        },
      }),
    ),
    http.get(api(`cases/${ID}/timeline`), ({ request }) => {
      const query = new URL(request.url).searchParams;
      queries.push(query.toString());
      const index = query.get('cursor') ? 1 : 0;
      const page = pages[index] ?? [];
      return ok({
        items: page,
        nextCursor: index + 1 < pages.length ? (page.at(-1)?.id ?? null) : null,
        names: { [CLIENT]: 'Omar Khalil' },
      });
    }),
  );
  return queries;
}

async function openTimeline(locale: 'en' | 'ar' = 'en') {
  setViewport(1280);
  signedIn({
    id: USER.id,
    role: 'OFFICE_MANAGER',
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor('OFFICE_MANAGER')],
  });
  const view = renderApp(`/cases/${ID}?tab=timeline`, locale);
  await screen.findByTestId('timeline-history', {}, { timeout: COLD });
  return view;
}

describe('timeline sentences (D-150)', () => {
  it('should read every event type in both languages, with names, labels and dates', async () => {
    const format = {
      dateTime: (value: Date | string | number) => `<${String(value)}>`,
      number: (value: number | string) => String(value),
    };
    for (const locale of ['en', 'ar'] as const) {
      const t = createI18n(locale).t;
      expect(eventSentence(t, format, EVENTS[2] as TimelineEvent, { [CLIENT]: 'Omar' })).toContain(
        'Omar',
      );
    }
    const t = createI18n('en').t;
    expect(eventSentence(t, format, EVENTS[0] as TimelineEvent, {})).toBe(
      'Hearing scheduled for ⁨<2026-12-01T07:30:00.000Z>⁩',
    );
    expect(eventSentence(t, format, event(9, 'DOCUMENT_UPLOADED', { versionNumber: 2 }), {})).toBe(
      'Version 2 of a confidential document uploaded',
    );
    expect(
      eventSentence(
        t,
        format,
        event(9, 'SESSION_UPDATED', {
          change: 'OUTCOME',
          sessionType: 'HEARING',
          outcome: 'POSTPONED',
          startsAt: '2026-12-01T07:30:00.000Z',
        }),
        {},
      ),
    ).toContain('Outcome of the Hearing');
    expect(
      eventSentence(t, format, event(9, 'FILE_REASSIGNED', { fromUserId: 'x', toUserId: LAWYER }), {
        [LAWYER]: 'Sami',
      }),
    ).toBe('File reassigned from ⁨a colleague⁩ to ⁨Sami⁩');
    expect(eventSentence(t, format, event(9, 'INVOICE_PAID', {}), {})).toBe('Invoice paid');
  });
});

describe('Timeline tab (D-150)', () => {
  it(
    'should group the history by month, name who did what, and open the source',
    async () => {
      serve();
      const { router } = await openTimeline();
      const history = screen.getByTestId('timeline-history');
      expect(within(history).getByText('November 2026')).toBeTruthy();
      expect(within(history).getByText('October 2026')).toBeTruthy();
      expect(within(history).getByText('Client ⁨Omar Khalil⁩ added')).toBeTruthy();
      expect(within(history).getByText('File ⁦2026-LIT-00007⁩ opened')).toBeTruthy();
      expect(within(history).getAllByText('Visible on the client portal')).toHaveLength(2);
      expect(screen.getByText('No hearing coming up.')).toBeTruthy();
      fireEvent.click(screen.getByTestId(`timeline-open-${EVENTS[1]?.id}`));
      await waitFor(() => expect(router.state.location.search).toBe('?tab=documents'));
    },
    SLOW,
  );

  it(
    'should load older events on demand and filter by type',
    async () => {
      const queries = serve([EVENTS.slice(0, 2), EVENTS.slice(2)]);
      await openTimeline();
      expect(screen.queryByText('File ⁦2026-LIT-00007⁩ opened')).toBeNull();
      fireEvent.click(screen.getByTestId('timeline-more'));
      expect(await screen.findByText('File ⁦2026-LIT-00007⁩ opened')).toBeTruthy();
      expect(queries[1]).toContain(`cursor=${EVENTS[1]?.id}`);
      const filter = screen.getByTestId('timeline-filter');
      fireEvent.mouseDown(filter.querySelector('input') ?? filter);
      fireEvent.click(await screen.findByTitle('File opened'));
      await waitFor(() => expect(queries.at(-1)).toContain('types=FILE_OPENED'));
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should have no accessibility violations (%s)',
    async (locale) => {
      serve();
      await openTimeline(locale);
      if (locale === 'ar') {
        expect(document.documentElement.dir).toBe('rtl');
        expect(screen.getByText('إضافة الموكل ⁨Omar Khalil⁩')).toBeTruthy();
      }
      const results = await axe.run(screen.getByTestId('timeline-tab'), {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );
});
