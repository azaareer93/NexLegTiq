import type { Case } from '@nexlegtiq/shared-contracts';
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
  signedIn,
} from '../../test/render-app';

setupTestServer();

const SLOW = 60_000;
const COLD = 20_000;
const ID = '01920000-0000-7000-8000-0000000001f1';
const LAWYER_ID = '01920000-0000-7000-8000-0000000000a1';
const PARALEGAL_ID = '01920000-0000-7000-8000-0000000000a2';
const MANAGER_ID = '01920000-0000-7000-8000-0000000000a9';
const COLLEAGUE_ID = '01920000-0000-7000-8000-0000000000a3';
const PRIMARY_ID = '01920000-0000-7000-8000-0000000000c1';
const SECOND_ID = '01920000-0000-7000-8000-0000000000c2';

const FILE: Case = {
  id: ID,
  fileNumber: '2026-LIT-00007',
  title: 'Land dispute',
  fileType: 'LITIGATION',
  status: 'OPEN',
  priority: 'HIGH',
  openingDate: '2026-10-01',
  isConfidential: false,
  primaryClient: { id: PRIMARY_ID, displayName: 'Omar Khalil' },
  responsibleLawyer: { id: LAWYER_ID, fullName: 'Sami Nasser' },
  updatedAt: '2026-10-05T09:00:00.000Z',
  description: null,
  subType: null,
  closingDate: null,
  responsibleParalegal: { id: PARALEGAL_ID, fullName: 'Rana Odeh' },
  courtCaseNumber: null,
  court: null,
  judge: null,
  jurisdiction: 'PALESTINE',
  billingMethod: null,
  hourlyRate: null,
  fixedFee: null,
  retainerBalance: null,
  currency: 'ILS',
  clients: [
    { id: PRIMARY_ID, displayName: 'Omar Khalil', clientType: 'INDIVIDUAL', isPrimary: true },
    { id: SECOND_ID, displayName: 'Nour Trading', clientType: 'CORPORATION', isPrimary: false },
  ],
  team: [
    { id: LAWYER_ID, fullName: 'Sami Nasser', role: 'RESPONSIBLE_LAWYER' },
    { id: PARALEGAL_ID, fullName: 'Rana Odeh', role: 'PARALEGAL' },
  ],
  counts: { parties: 0, notes: 0 },
  createdAt: '2026-10-01T09:00:00.000Z',
};

const DIRECTORY = [
  { id: LAWYER_ID, fullName: 'Sami Nasser', role: 'LAWYER' },
  { id: PARALEGAL_ID, fullName: 'Rana Odeh', role: 'PARALEGAL' },
  { id: COLLEAGUE_ID, fullName: 'Hadi Saleh', role: 'LAWYER' },
  { id: MANAGER_ID, fullName: 'Lina Haddad', role: 'OFFICE_MANAGER' },
];

const EMPTY_PAGE = {
  success: true,
  data: [],
  meta: {
    timestamp: '2026-10-05T10:00:00.000Z',
    requestId: 'req-12345678',
    pagination: { page: 1, limit: 10, total: 0, totalPages: 0, hasMore: false },
  },
};

const asRole = (role: Role, id: string) =>
  signedIn({ id, role, uiLanguage: 'EN', permissions: [...permissionsFor(role)] });

function serveFile(file: Case = FILE) {
  server.use(
    http.get(api(`cases/${ID}`), () => ok(file)),
    http.get(api(`cases/${ID}/sessions`), () => HttpResponse.json(EMPTY_PAGE)),
    http.get(api('users/directory'), () => ok(DIRECTORY)),
  );
}

const card = async (testId: string) =>
  within(await screen.findByTestId(testId, {}, { timeout: COLD }));

describe('file clients and team (D-140)', () => {
  it(
    'should add a colleague to the team with the role their office role allows',
    async () => {
      asRole('OFFICE_MANAGER', MANAGER_ID);
      serveFile();
      let body: unknown;
      server.use(
        http.post(api(`cases/${ID}/team`), async ({ request }) => {
          body = await request.json();
          return ok([], 201);
        }),
      );
      renderApp(`/cases/${ID}`);
      fireEvent.click((await card('case-card-team')).getByTestId('add-member'));
      const dialog = within(await screen.findByRole('dialog'));
      fireEvent.mouseDown(dialog.getByRole('combobox', { name: 'Colleague' }));
      fireEvent.click(await screen.findByTitle(/Hadi Saleh.*Lawyer/));
      fireEvent.mouseDown(dialog.getByRole('combobox', { name: 'Role on the case' }));
      // A lawyer may become the responsible lawyer (the manager may reassign), not the paralegal.
      expect(await screen.findByTitle('Responsible lawyer')).toBeTruthy();
      // Only the dropdown's options: the team card's own role select also shows "Paralegal".
      expect(document.querySelector('.ant-select-item-option[title="Paralegal"]')).toBeNull();
      fireEvent.click(screen.getByTitle('Responsible lawyer'));
      expect(dialog.getByText(/stays on the team as a member/)).toBeTruthy();
      fireEvent.click(screen.getByTestId('add-member-submit'));
      await waitFor(() =>
        expect(body).toEqual({ userId: COLLEAGUE_ID, role: 'RESPONSIBLE_LAWYER' }),
      );
    },
    SLOW,
  );

  it(
    'should change a member role and remove a member after a confirm, never the responsible lawyer',
    async () => {
      asRole('OFFICE_MANAGER', MANAGER_ID);
      serveFile();
      const calls: string[] = [];
      server.use(
        http.patch(api(`cases/${ID}/team/${PARALEGAL_ID}`), async ({ request }) => {
          calls.push(`PATCH ${JSON.stringify(await request.json())}`);
          return ok([]);
        }),
        http.delete(api(`cases/${ID}/team/${PARALEGAL_ID}`), () => {
          calls.push('DELETE');
          return new HttpResponse(null, { status: 204 });
        }),
      );
      renderApp(`/cases/${ID}`);
      const team = await card('case-card-team');
      expect(team.queryByTestId(`remove-member-${LAWYER_ID}`)).toBeNull();
      expect(team.queryByTestId(`member-role-${LAWYER_ID}`)).toBeNull();

      fireEvent.mouseDown(team.getByRole('combobox', { name: 'Role of ⁨Rana Odeh⁩ on the case' }));
      fireEvent.click(await screen.findByTitle('Team member'));
      await waitFor(() => expect(calls).toEqual(['PATCH {"role":"MEMBER"}']));

      fireEvent.click(team.getByTestId(`remove-member-${PARALEGAL_ID}`));
      const dialog = within(await screen.findByRole('dialog'));
      expect(dialog.getByText(/will no longer be assigned to this case/)).toBeTruthy();
      fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(calls).toContain('DELETE'));
    },
    SLOW,
  );

  it(
    'should make a client primary, remove one after a confirm, and explain a refusal',
    async () => {
      asRole('OFFICE_MANAGER', MANAGER_ID);
      serveFile();
      const calls: string[] = [];
      server.use(
        http.patch(api(`cases/${ID}/clients/${SECOND_ID}`), () => {
          calls.push('PATCH');
          return ok([]);
        }),
        http.delete(api(`cases/${ID}/clients/${SECOND_ID}`), () => {
          calls.push('DELETE');
          return fail(422, 'BIZ-018');
        }),
      );
      renderApp(`/cases/${ID}`);
      const clients = await card('case-card-clients');
      expect(clients.queryByTestId(`make-primary-${PRIMARY_ID}`)).toBeNull();
      fireEvent.click(clients.getByTestId(`make-primary-${SECOND_ID}`));
      await waitFor(() => expect(calls).toEqual(['PATCH']));

      fireEvent.click(clients.getByTestId(`remove-client-${SECOND_ID}`));
      const dialog = within(await screen.findByRole('dialog'));
      fireEvent.click(dialog.getByRole('button', { name: 'Remove' }));
      expect(await screen.findByText('The last client of a case cannot be removed.')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should offer nothing to a trainee',
    async () => {
      asRole('TRAINEE', COLLEAGUE_ID);
      serveFile();
      renderApp(`/cases/${ID}`);
      const team = await card('case-card-team');
      expect(team.queryByTestId('add-member')).toBeNull();
      expect(team.queryByTestId(`remove-member-${PARALEGAL_ID}`)).toBeNull();
      expect((await card('case-card-clients')).queryByTestId('add-client')).toBeNull();
    },
    SLOW,
  );

  it(
    'should let the paralegal of a confidential file edit its team but add nobody to it',
    async () => {
      asRole('PARALEGAL', PARALEGAL_ID);
      serveFile({ ...FILE, isConfidential: true });
      renderApp(`/cases/${ID}`);
      const confidential = await card('case-card-team');
      // The paralegal edits the file (remove buttons) but cannot expose it to someone new (D-096).
      expect(confidential.getByTestId(`remove-member-${PARALEGAL_ID}`)).toBeTruthy();
      expect(confidential.queryByTestId('add-member')).toBeNull();
      expect((await card('case-card-clients')).getByTestId('add-client')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show the cards in Arabic, right to left',
    async () => {
      signedIn({
        id: MANAGER_ID,
        role: 'OFFICE_MANAGER',
        uiLanguage: 'AR',
        permissions: [...permissionsFor('OFFICE_MANAGER')],
      });
      serveFile();
      renderApp(`/cases/${ID}`, 'ar');
      const team = await card('case-card-team');
      expect(team.getByTestId('add-member').textContent).toContain('إضافة عضو إلى الفريق');
      expect((await card('case-card-clients')).getByTestId('add-client').textContent).toContain(
        'إضافة موكل',
      );
      expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    },
    SLOW,
  );
});
