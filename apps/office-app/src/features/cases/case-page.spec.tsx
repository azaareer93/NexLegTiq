import type { Case } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { changesOf } from './components/EditCaseDrawer';
import { fileActions, readTab, visibleTabs } from './file-page';
import type { FileActions } from './file-page';
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

const SLOW = 60_000;
const AXE_SLOW = 180_000;
const COLD = 20_000;

const ID = '01920000-0000-7000-8000-0000000001f1';
const LAWYER_ID = '01920000-0000-7000-8000-0000000000a1';
const PARALEGAL_ID = '01920000-0000-7000-8000-0000000000a2';

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
  responsibleLawyer: { id: LAWYER_ID, fullName: 'Sami Nasser' },
  updatedAt: '2026-10-05T09:00:00.000Z',
  description: 'Boundary of the olive grove',
  subType: null,
  closingDate: null,
  responsibleParalegal: { id: PARALEGAL_ID, fullName: 'Rana Odeh' },
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
    { id: LAWYER_ID, fullName: 'Sami Nasser', role: 'RESPONSIBLE_LAWYER' },
    { id: PARALEGAL_ID, fullName: 'Rana Odeh', role: 'PARALEGAL' },
  ],
  counts: { parties: 2, notes: 3 },
  createdAt: '2026-10-01T09:00:00.000Z',
};

const userAs = (role: Role, id = USER.id) => ({ id, role, permissions: permissionsFor(role) });
const asRole = (role: Role, id = USER.id, uiLanguage: 'AR' | 'EN' = 'EN') =>
  signedIn({ id, role, uiLanguage, permissions: [...permissionsFor(role)] });

function serveFile(file: Case = FILE) {
  server.use(http.get(api(`cases/${ID}`), () => ok(file)));
}
const page = () => screen.findByTestId('page-case', {}, { timeout: COLD });

describe('file page rules', () => {
  const none: FileActions = {
    edit: false,
    reassign: false,
    changeStatus: false,
    archive: false,
    delete: false,
    confidentiality: false,
    billing: false,
  };

  it('should offer each role only its actions', () => {
    expect(fileActions(FILE, userAs('OFFICE_MANAGER'))).toEqual({
      edit: true,
      reassign: true,
      changeStatus: true,
      archive: true,
      delete: true,
      confidentiality: true,
      billing: true,
    });
    // A lawyer: edits assigned files only; close/reopen only as the responsible lawyer (D-052).
    expect(fileActions(FILE, userAs('LAWYER', LAWYER_ID))).toMatchObject({
      edit: true,
      changeStatus: true,
      confidentiality: true,
      delete: false,
    });
    expect(fileActions(FILE, userAs('LAWYER'))).toMatchObject({ edit: false, changeStatus: false });
    // The paralegal on the team edits, but cannot touch confidentiality or billing (D-096).
    expect(fileActions(FILE, userAs('PARALEGAL', PARALEGAL_ID))).toMatchObject({
      edit: true,
      confidentiality: false,
      billing: false,
    });
    expect(fileActions(FILE, userAs('TRAINEE'))).toEqual(none);
    expect(fileActions({ ...FILE, status: 'ARCHIVED' }, userAs('OFFICE_MANAGER'))).toEqual(none);
  });

  it('should read the tab from the URL and fall back to Details', () => {
    const lawyer = visibleTabs((p) => permissionsFor('LAWYER').includes(p));
    expect(lawyer).not.toContain('audit');
    expect(readTab(new URLSearchParams('tab=parties'), lawyer)).toBe('parties');
    expect(readTab(new URLSearchParams('tab=audit'), lawyer)).toBe('details');
    expect(readTab(new URLSearchParams('tab=pizza'), lawyer)).toBe('details');
    expect(readTab(new URLSearchParams(), lawyer)).toBe('details');
  });

  it('should send only the changed fields the user may edit, clearing emptied ones', () => {
    const manager = fileActions(FILE, userAs('OFFICE_MANAGER'));
    const values = {
      title: ' Land dispute (appeal) ',
      description: '',
      subType: '',
      courtCaseNumber: '123/2026',
      priority: 'HIGH',
      billingMethod: 'HOURLY',
      hourlyRate: '200',
      fixedFee: '',
      isConfidential: true,
    };
    expect(changesOf(FILE, values, manager)).toEqual({
      title: 'Land dispute (appeal)',
      description: null,
      hourlyRate: '200',
      isConfidential: true,
    });
    const paralegal = fileActions(FILE, userAs('PARALEGAL', PARALEGAL_ID));
    expect(changesOf(FILE, values, paralegal)).toEqual({
      title: 'Land dispute (appeal)',
      description: null,
    });
  });
});

describe('file page', () => {
  it(
    'should show the header and the Details cards',
    async () => {
      setViewport(1280);
      asRole('OFFICE_MANAGER');
      serveFile();
      renderApp(`/cases/${ID}`);
      await page();
      const heading = screen.getByTestId('case-heading');
      expect(within(heading).getByText('2026-LIT-00007').closest('[dir="ltr"]')).toBeTruthy();
      expect(within(heading).getByText('Land dispute')).toBeTruthy();
      expect(screen.getAllByText('Open').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Sami Nasser').length).toBeGreaterThan(0);
      expect(
        within(screen.getByTestId('case-card-court')).getByText('Ramallah Court of First Instance'),
      ).toBeTruthy();
      expect(within(screen.getByTestId('case-card-billing')).getByText('₪150.00')).toBeTruthy();
      expect(
        within(screen.getByTestId('case-card-clients')).getByText('Primary client'),
      ).toBeTruthy();
      expect(screen.getByTestId('case-card-next-hearing')).toBeTruthy();
      expect(screen.getByTestId('case-edit')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should keep the tab in the URL',
    async () => {
      setViewport(1280);
      asRole('LAWYER', LAWYER_ID);
      serveFile();
      const { router } = renderApp(`/cases/${ID}?tab=audit`);
      await page();
      // A lawyer cannot open Audit: the link falls back to Details, and the tab is not offered.
      expect(screen.getByTestId('case-details')).toBeTruthy();
      expect(screen.queryByTestId('tab-audit')).toBeNull();
      fireEvent.click(screen.getByTestId('tab-parties'));
      await waitFor(() => expect(router.state.location.search).toBe('?tab=parties'));
      expect(await screen.findByText('Coming soon')).toBeTruthy();
      fireEvent.click(screen.getByTestId('tab-details'));
      await waitFor(() => expect(router.state.location.search).toBe(''));
      // Tab switches replace the history entry, so "back" leaves the file.
      expect(router.state.historyAction).toBe('REPLACE');
    },
    SLOW,
  );

  it(
    'should offer a responsible lawyer the lifecycle actions but not reassign or delete',
    async () => {
      setViewport(1280);
      asRole('LAWYER', LAWYER_ID);
      serveFile();
      renderApp(`/cases/${ID}`);
      await page();
      fireEvent.click(screen.getByTestId('case-actions'));
      expect(await screen.findByTestId('case-action-status')).toBeTruthy();
      expect(screen.getByTestId('case-action-archive')).toBeTruthy();
      expect(screen.getByTestId('case-action-edit')).toBeTruthy();
      expect(screen.queryByTestId('case-action-reassign')).toBeNull();
      expect(screen.queryByTestId('case-action-delete')).toBeNull();
      // Lifecycle routes arrive with their own story.
      fireEvent.click(screen.getByTestId('case-action-status'));
      expect(await screen.findByTestId('case-coming-soon')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should offer nothing to a lawyer not assigned to the file',
    async () => {
      setViewport(1280);
      asRole('LAWYER');
      serveFile();
      renderApp(`/cases/${ID}`);
      await page();
      expect(screen.queryByTestId('case-actions')).toBeNull();
      expect(screen.queryByTestId('case-edit')).toBeNull();
    },
    SLOW,
  );

  it(
    'should hide the actions from a trainee and the billing card without its terms',
    async () => {
      setViewport(1280);
      asRole('TRAINEE');
      serveFile({
        ...FILE,
        billingMethod: null,
        hourlyRate: null,
        fixedFee: null,
        retainerBalance: null,
      });
      renderApp(`/cases/${ID}`);
      await page();
      expect(screen.queryByTestId('case-actions')).toBeNull();
      expect(screen.queryByTestId('case-edit')).toBeNull();
      expect(screen.queryByTestId('case-card-billing')).toBeNull();
    },
    SLOW,
  );

  it(
    'should show the 404 page for a file the user cannot see',
    async () => {
      asRole('OFFICE_MANAGER');
      server.use(http.get(api(`cases/${ID}`), () => fail(404, 'RES-001')));
      renderApp(`/cases/${ID}`);
      expect(await screen.findByTestId('page-not-found', {}, { timeout: COLD })).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show the 404 page for a malformed id without asking the API',
    async () => {
      asRole('OFFICE_MANAGER');
      let asked = false;
      server.use(
        http.get(api('cases/not-a-uuid'), () => {
          asked = true;
          return fail(404, 'RES-001');
        }),
      );
      renderApp('/cases/not-a-uuid');
      expect(await screen.findByTestId('page-not-found', {}, { timeout: COLD })).toBeTruthy();
      expect(asked).toBe(false);
    },
    SLOW,
  );

  it(
    'should show an error with a reference and retry when the file cannot load',
    async () => {
      asRole('OFFICE_MANAGER');
      let calls = 0;
      server.use(
        http.get(api(`cases/${ID}`), () => {
          calls += 1;
          return calls <= 2 ? fail(500, 'SYS-001') : ok(FILE);
        }),
      );
      renderApp(`/cases/${ID}`);
      const error = await screen.findByTestId('case-error', {}, { timeout: COLD });
      expect(within(error).getByText(/req-12345678/)).toBeTruthy();
      fireEvent.click(within(error).getByRole('button'));
      expect(await page()).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should make an archived file read-only',
    async () => {
      asRole('OFFICE_MANAGER');
      serveFile({ ...FILE, status: 'ARCHIVED' });
      renderApp(`/cases/${ID}`);
      await page();
      expect(screen.getByTestId('case-archived-banner')).toBeTruthy();
      expect(screen.queryByTestId('case-actions')).toBeNull();
      expect(screen.queryByTestId('case-edit')).toBeNull();
    },
    SLOW,
  );

  it(
    'should save an edit with only the changed fields',
    async () => {
      setViewport(1280);
      asRole('OFFICE_MANAGER');
      serveFile();
      let body: unknown;
      server.use(
        http.patch(api(`cases/${ID}`), async ({ request }) => {
          body = await request.json();
          return ok({ ...FILE, title: 'Olive grove boundary' });
        }),
      );
      renderApp(`/cases/${ID}`);
      await page();
      fireEvent.click(screen.getByTestId('case-edit'));
      const title = await screen.findByTestId('case-title-input');
      fireEvent.change(title, { target: { value: 'Olive grove boundary' } });
      fireEvent.click(screen.getByTestId('case-edit-save'));
      await waitFor(() => expect(body).toEqual({ title: 'Olive grove boundary' }));
      await waitFor(() =>
        expect(
          within(screen.getByTestId('case-heading')).getByText('Olive grove boundary'),
        ).toBeTruthy(),
      );
    },
    SLOW,
  );

  it(
    'should put API field errors on the form and start clean after a cancel',
    async () => {
      setViewport(1280);
      asRole('OFFICE_MANAGER');
      serveFile();
      server.use(
        http.patch(api(`cases/${ID}`), () =>
          fail(400, 'VAL-001', [{ field: 'title', message: 'validation.tooLong' }]),
        ),
      );
      renderApp(`/cases/${ID}`);
      await page();
      fireEvent.click(screen.getByTestId('case-edit'));
      fireEvent.change(await screen.findByTestId('case-title-input'), {
        target: { value: 'Rejected title' },
      });
      fireEvent.click(screen.getByTestId('case-edit-save'));
      const drawer = screen.getByTestId('case-edit-drawer');
      expect(await within(drawer).findByText('This is too long.')).toBeTruthy();
      expect(within(screen.getByTestId('case-heading')).getByText('Land dispute')).toBeTruthy();

      fireEvent.click(screen.getByTestId('case-edit-cancel'));
      await waitFor(() => expect(screen.queryByTestId('case-title-input')).toBeNull());
      fireEvent.click(screen.getByTestId('case-edit'));
      expect(((await screen.findByTestId('case-title-input')) as HTMLInputElement).value).toBe(
        'Land dispute',
      );
    },
    SLOW,
  );

  it(
    'should stay on the file and explain a refused delete',
    async () => {
      setViewport(1280);
      asRole('OFFICE_MANAGER');
      serveFile();
      server.use(http.delete(api(`cases/${ID}`), () => fail(422, 'BIZ-007')));
      const { router } = renderApp(`/cases/${ID}`);
      await page();
      fireEvent.click(screen.getByTestId('case-actions'));
      fireEvent.click(await screen.findByTestId('case-action-delete'));
      fireEvent.click(await screen.findByTestId('confirm-ok'));
      await waitFor(() => expect(document.querySelector('.ant-notification-notice')).toBeTruthy());
      expect(router.state.location.pathname).toBe(`/cases/${ID}`);
      expect(screen.getByTestId('page-case')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should delete after confirmation and go back to the list',
    async () => {
      setViewport(1280);
      asRole('OFFICE_MANAGER');
      serveFile();
      let deleted = false;
      server.use(
        http.delete(api(`cases/${ID}`), () => {
          deleted = true;
          return new HttpResponse(null, { status: 204 });
        }),
        http.get(api('cases'), () =>
          HttpResponse.json({
            success: true,
            data: [],
            meta: {
              timestamp: '2026-10-05T10:00:00.000Z',
              requestId: 'req-12345678',
              pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasMore: false },
            },
          }),
        ),
      );
      const { router } = renderApp(`/cases/${ID}`);
      await page();
      fireEvent.click(screen.getByTestId('case-actions'));
      fireEvent.click(await screen.findByTestId('case-action-delete'));
      fireEvent.click(await screen.findByTestId('confirm-ok'));
      await waitFor(() => expect(deleted).toBe(true));
      await waitFor(() => expect(router.state.location.pathname).toBe('/cases'));
    },
    SLOW,
  );

  it(
    'should render right to left in Arabic with the Arabic court name',
    async () => {
      setViewport(1280);
      asRole('OFFICE_MANAGER', USER.id, 'AR');
      serveFile();
      renderApp(`/cases/${ID}`, 'ar');
      await page();
      expect(document.documentElement.getAttribute('dir')).toBe('rtl');
      expect(screen.getByTestId('tab-details').textContent).toBe('التفاصيل');
      expect(
        within(screen.getByTestId('case-card-court')).getByText('محكمة بداية رام الله'),
      ).toBeTruthy();
    },
    SLOW,
  );

  it.each([['en'], ['ar']] as const)(
    'should have no accessibility violations (%s)',
    async (locale) => {
      setViewport(1280);
      asRole('OFFICE_MANAGER', USER.id, locale === 'ar' ? 'AR' : 'EN');
      serveFile();
      renderApp(`/cases/${ID}`, locale);
      const section = await page();
      const { violations } = await axe.run(section, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(
        violations.map(
          (violation) =>
            `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
        ),
      ).toEqual([]);
    },
    AXE_SLOW,
  );
});
