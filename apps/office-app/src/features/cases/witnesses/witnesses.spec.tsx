import type { Case, Witness, WitnessStatement } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse } from 'msw';

import { statementChanges } from './StatementForm';
import { witnessChanges } from './WitnessModal';
import {
  api,
  http,
  ok,
  renderApp,
  server,
  setupTestServer,
  signedIn,
} from '../../../test/render-app';

setupTestServer();

const SLOW = 60_000;
const COLD = 20_000;

const FILE_ID = '01920000-0000-7000-8000-0000000002f1';
const LAWYER_ID = '01920000-0000-7000-8000-0000000002a1';
const WITNESS_ID = '01920000-0000-7000-8000-0000000002b1';
const STATEMENT_ID = '01920000-0000-7000-8000-0000000002c1';
const XSS = '<img src=x onerror=alert(1)> شهد بأن العقد وُقّع';

const FILE: Case = {
  id: FILE_ID,
  fileNumber: '2026-LIT-00009',
  title: 'Contract dispute',
  fileType: 'LITIGATION',
  status: 'OPEN',
  priority: 'MEDIUM',
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

const WITNESS: Witness = {
  id: WITNESS_ID,
  fileId: FILE_ID,
  fullName: 'Nour Khalil',
  isExpert: true,
  expertiseArea: 'Handwriting',
  phone: '+970599000111',
  email: null,
  address: null,
  notes: null,
  statementCount: 1,
  createdAt: '2026-10-02T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
};

const STATEMENT: WitnessStatement = {
  id: STATEMENT_ID,
  witnessId: WITNESS_ID,
  statementDate: '2026-10-03',
  text: XSS,
  isUnderOath: true,
  recordedBy: { id: LAWYER_ID, fullName: 'Sami Nasser' },
  session: null,
  createdAt: '2026-10-03T09:00:00.000Z',
  updatedAt: '2026-10-03T09:00:00.000Z',
};

const asRole = (role: Role, uiLanguage: 'AR' | 'EN' = 'EN') =>
  signedIn({ id: LAWYER_ID, role, uiLanguage, permissions: [...permissionsFor(role)] });

function serve(): { writes: { path: string; body: unknown }[] } {
  const calls = { writes: [] as { path: string; body: unknown }[] };
  const record =
    (answer: unknown) =>
    async ({ request }: { request: Request }) => {
      calls.writes.push({ path: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json({ success: true, data: answer }, { status: 201 });
    };
  server.use(
    http.get(api(`cases/${FILE_ID}`), () => ok(FILE)),
    http.get(api(`cases/${FILE_ID}/parties`), () => ok([])),
    http.get(api(`cases/${FILE_ID}/witnesses`), () => ok([WITNESS])),
    http.get(api(`cases/${FILE_ID}/sessions`), () =>
      HttpResponse.json({
        success: true,
        data: [],
        meta: { pagination: { page: 1, limit: 50, total: 0, totalPages: 0, hasMore: false } },
      }),
    ),
    http.get(api(`witnesses/${WITNESS_ID}/statements`), () => ok([STATEMENT])),
    http.post(api(`cases/${FILE_ID}/witnesses`), record(WITNESS)),
    http.post(api(`witnesses/${WITNESS_ID}/statements`), record(STATEMENT)),
  );
  return calls;
}

const openSection = async (locale: 'en' | 'ar' = 'en') => {
  renderApp(`/cases/${FILE_ID}?tab=parties`, locale);
  const section = await screen.findByTestId('case-witnesses', {}, { timeout: COLD });
  await within(section).findByTestId(`witness-row-${WITNESS_ID}`, {}, { timeout: COLD });
  return section;
};

describe('witness form changes', () => {
  const values = {
    fullName: ' Nour ',
    isExpert: false,
    expertiseArea: '',
    phone: '',
    email: '',
    address: '',
    notes: '',
  };
  it('should send only filled fields on create and clear emptied ones on edit', () => {
    expect(witnessChanges(values, null)).toEqual({ fullName: 'Nour' });
    expect(witnessChanges({ ...values, fullName: 'Nour Khalil', phone: '' }, WITNESS)).toEqual({
      phone: null,
      isExpert: false,
      expertiseArea: null,
    });
  });
});

describe('statement form changes', () => {
  it('should send only what changed, and null for a hearing taken off', () => {
    const body = { statementDate: '2026-10-03', text: XSS, isUnderOath: false };
    expect(statementChanges(body, STATEMENT)).toEqual({ isUnderOath: false });
    expect(
      statementChanges(body, {
        ...STATEMENT,
        isUnderOath: false,
        session: { id: WITNESS_ID, startsAt: '2026-10-03T08:00:00.000Z' },
      }),
    ).toEqual({ sessionId: null });
  });
});

describe('witnesses section', () => {
  it(
    'should list witnesses, add one and record a statement shown as plain text',
    async () => {
      asRole('LAWYER');
      const calls = serve();
      const section = await openSection();
      expect(within(section).getByText('Expert')).toBeTruthy();
      expect(within(section).getByText('1 statement')).toBeTruthy();

      fireEvent.click(within(section).getByTestId('witness-add'));
      fireEvent.change(await screen.findByTestId('witness-name'), { target: { value: 'Rami' } });
      fireEvent.click(screen.getByTestId('witness-save'));
      await waitFor(() =>
        expect(calls.writes).toContainEqual({
          path: `/api/v1/cases/${FILE_ID}/witnesses`,
          body: { fullName: 'Rami' },
        }),
      );

      fireEvent.click(within(section).getByTestId(`witness-statements-${WITNESS_ID}`));
      const drawer = await screen.findByTestId('statements-drawer');
      const shown = await within(drawer).findByTestId('statement-text-view');
      // Rendered as text, never as markup.
      expect(shown.textContent).toBe(XSS);
      expect(drawer.querySelector('img')).toBeNull();

      fireEvent.click(within(drawer).getByTestId('statement-add'));
      fireEvent.change(within(drawer).getByTestId('statement-text'), {
        target: { value: '  Saw the signing  ' },
      });
      fireEvent.click(within(drawer).getByTestId('statement-save'));
      await waitFor(() =>
        expect(calls.writes).toContainEqual({
          path: `/api/v1/witnesses/${WITNESS_ID}/statements`,
          body: expect.objectContaining({ text: 'Saw the signing', isUnderOath: false }),
        }),
      );
    },
    SLOW,
  );

  it(
    'should be read-only for a trainee and read right to left in Arabic',
    async () => {
      asRole('TRAINEE', 'AR');
      serve();
      const section = await openSection('ar');
      expect(within(section).queryByTestId('witness-add')).toBeNull();
      expect(within(section).queryByTestId(`witness-edit-${WITNESS_ID}`)).toBeNull();
      expect(within(section).getByText('الشهود والخبراء')).toBeTruthy();
      expect(document.documentElement.dir).toBe('rtl');
      fireEvent.click(within(section).getByTestId(`witness-statements-${WITNESS_ID}`));
      const drawer = await screen.findByTestId('statements-drawer');
      await within(drawer).findByTestId('statement-text-view');
      expect(within(drawer).queryByTestId('statement-add')).toBeNull();
    },
    SLOW,
  );
});
