import type { Dashboard } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';

import {
  api,
  EMPTY_DASHBOARD,
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
const FILE = {
  id: '01920000-0000-7000-8000-0000000001f1',
  fileNumber: '2026-LIT-00007',
  title: 'Rent claim',
};
const LAWYER = '01920000-0000-7000-8000-0000000000a1';

const FULL: Dashboard = {
  today: '2026-11-09',
  openFiles: { count: 4, openedThisWeek: 1 },
  todayHearings: [
    {
      id: '01920000-0000-7000-8000-0000000000e1',
      file: FILE,
      sessionType: 'HEARING',
      startsAt: '2026-11-09T08:30:00.000Z',
    },
  ],
  nextHearingId: '01920000-0000-7000-8000-0000000000e1',
  overdueTasks: 2,
  newDocuments: 3,
  newClientsThisMonth: 5,
  deadlines: [
    {
      kind: 'TASK',
      id: '01920000-0000-7000-8000-0000000000b1',
      title: 'File the appeal',
      dueDate: '2026-11-11',
      file: null,
    },
  ],
  activity: {
    items: [
      {
        id: '01920000-0000-7000-8000-0000000000c1',
        eventType: 'FILE_OPENED',
        sourceType: null,
        sourceId: null,
        occurredAt: '2026-11-09T07:00:00.000Z',
        actor: null,
        payload: { fileNumber: FILE.fileNumber },
        portalVisible: true,
        file: FILE,
      },
    ],
    names: {},
  },
  team: {
    workload: [{ userId: LAWYER, fullName: 'Omar Lawyer', openFiles: 4, overdueTasks: 2 }],
    hearingsThisWeek: 6,
  },
  finance: {
    unpaid: [
      { currency: 'ILS', amount: '1500.50', count: 3 },
      { currency: 'JOD', amount: '20.000', count: 1 },
    ],
    overdueCount: 2,
    revenueThisMonth: [],
  },
};

async function openDashboard(role: Role, data: Dashboard, locale: 'en' | 'ar' = 'en') {
  setViewport(1280);
  server.use(http.get(api('dashboard'), () => ok(data)));
  signedIn({
    id: USER.id,
    role,
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor(role)],
  });
  const view = renderApp('/', locale);
  await screen.findByTestId('kpi-open-files', {}, { timeout: 20_000 });
  return view;
}

describe('Dashboard (D-151)', () => {
  it(
    "should show the office manager's KPIs, hearings, deadlines, activity and team, each linking on",
    async () => {
      const { router } = await openDashboard('OFFICE_MANAGER', FULL);
      expect(
        within(screen.getByTestId('kpi-open-files')).getByText('1 opened this week'),
      ).toBeTruthy();
      expect(within(screen.getByTestId('kpi-clients')).getByText('5')).toBeTruthy();
      expect(within(screen.getByTestId('kpi-office-hearings')).getByText('6')).toBeTruthy();
      expect(
        within(screen.getByTestId('dashboard-today')).getByText('Within the hour'),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId('dashboard-deadlines')).getByText('Personal task'),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId('dashboard-activity')).getByText('File ⁦2026-LIT-00007⁩ opened'),
      ).toBeTruthy();
      expect(within(screen.getByTestId('dashboard-team')).getByText('⁨Omar Lawyer⁩')).toBeTruthy();
      const unpaid = within(screen.getByTestId('kpi-unpaid'));
      expect(unpaid.getByText('₪1,500.50')).toBeTruthy();
      expect(unpaid.getByText('2 overdue')).toBeTruthy();
      expect(within(screen.getByTestId('kpi-revenue')).getByText('None')).toBeTruthy();
      expect(screen.queryByTestId('dashboard-new-case')).toBeNull();
      fireEvent.click(screen.getByTestId('kpi-overdue'));
      await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
    },
    SLOW,
  );

  it(
    'should leave out the client, office and money cards a trainee does not get',
    async () => {
      await openDashboard('TRAINEE', {
        ...FULL,
        newClientsThisMonth: null,
        team: null,
        finance: null,
      });
      expect(screen.queryByTestId('kpi-clients')).toBeNull();
      expect(screen.queryByTestId('kpi-unpaid')).toBeNull();
      expect(screen.queryByTestId('dashboard-team')).toBeNull();
    },
    SLOW,
  );

  it(
    'should offer a new office its first case',
    async () => {
      await openDashboard('OFFICE_MANAGER', EMPTY_DASHBOARD);
      fireEvent.click(screen.getByTestId('dashboard-new-case'));
      expect(await screen.findByRole('dialog')).toBeTruthy();
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should have no accessibility violations (%s)',
    async (locale) => {
      await openDashboard('OFFICE_MANAGER', FULL, locale);
      if (locale === 'ar') {
        expect(document.documentElement.dir).toBe('rtl');
        expect(screen.getByText('مهام متأخرة')).toBeTruthy();
      }
      const results = await axe.run(screen.getByTestId('page-dashboard'), {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );
});
