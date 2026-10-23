import type { TeamMember, UserOpenFile } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';

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

/** The first visit loads the page's chunk cold, which takes several seconds on a busy runner. */
const COLD = 20_000;
const SLOW = 60_000;

const member = (id: string, extra: Partial<TeamMember>): TeamMember => ({
  id,
  fullName: 'Someone',
  email: `${id.slice(-2)}@example.test`,
  role: 'LAWYER',
  isActive: true,
  openFiles: 0,
  lastLoginAt: null,
  ...extra,
});

const ADEL = '01920000-0000-7000-8000-0000000000a1';
const SALMA = '01920000-0000-7000-8000-0000000000a2';
const OLD = '01920000-0000-7000-8000-0000000000a3';
const TEAM = [
  member(ADEL, { fullName: 'Adel Lawyer', openFiles: 2, lastLoginAt: '2026-10-01T10:00:00.000Z' }),
  member(USER.id, { fullName: USER.fullName, role: 'OFFICE_MANAGER' }),
  member(SALMA, { fullName: 'Salma Senior', role: 'SENIOR_LAWYER' }),
  member(OLD, { fullName: 'Old Paralegal', role: 'PARALEGAL', isActive: false }),
];
const FILES: UserOpenFile[] = [
  { id: '01920000-0000-7000-8000-0000000000f1', fileNumber: '2026-LIT-00001', title: 'Land' },
  { id: '01920000-0000-7000-8000-0000000000f2', fileNumber: '2026-LIT-00002', title: 'Lease' },
];

function serveTeam(team: TeamMember[] = TEAM): void {
  server.use(
    http.get(api('users'), () => ok(team)),
    http.get(api('users/invitations'), () => ok([])),
  );
}

async function openTeam(locale: 'en' | 'ar' = 'en'): Promise<HTMLElement> {
  setViewport(1280);
  signedIn(locale === 'ar' ? { uiLanguage: 'AR' } : {});
  renderApp('/team', locale);
  return screen.findByTestId('team-table', {}, { timeout: COLD });
}

describe('Team management (D-124)', () => {
  it(
    'should list the team with role, status, open files and last sign-in; your own row is read-only',
    async () => {
      serveTeam();
      const table = await openTeam();
      const adel = await within(table).findByTestId(`team-row-${ADEL}`);
      expect(adel.textContent).toContain('Adel Lawyer');
      expect(adel.textContent).toContain('Active');
      expect(within(adel).getByTestId(`team-role-${ADEL}`)).toBeTruthy();
      const me = within(table).getByTestId(`team-row-${USER.id}`);
      expect(me.textContent).toContain('You');
      expect(me.textContent).toContain('Never');
      expect(within(me).queryByTestId(`team-role-${USER.id}`)).toBeNull();
      expect(within(me).queryByRole('button')).toBeNull();
      const old = within(table).getByTestId(`team-row-${OLD}`);
      expect(old.textContent).toContain('Inactive');
      expect(within(old).getByTestId(`team-reactivate-${OLD}`)).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should change a role and show what the API refuses',
    async () => {
      serveTeam();
      let body: unknown;
      server.use(
        http.patch(api(`users/${SALMA}/role`), async ({ request }) => {
          body = await request.json();
          return fail(422, 'BIZ-001');
        }),
      );
      const table = await openTeam();
      const select = await within(table).findByTestId(`team-role-${SALMA}`);
      fireEvent.mouseDown(select.querySelector('.ant-select-selector') ?? select);
      fireEvent.click(await screen.findByTitle('Paralegal'));
      await waitFor(() => expect(body).toEqual({ role: 'PARALEGAL' }));
      expect(
        await screen.findByText('The office must keep at least one office manager.'),
      ).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should deactivate after giving every open file to a new lawyer',
    async () => {
      serveTeam();
      let body: unknown;
      server.use(
        http.get(api(`users/${ADEL}/open-files`), () => ok(FILES)),
        http.post(api(`users/${ADEL}/deactivate`), async ({ request }) => {
          body = await request.json();
          return ok({ ...TEAM[0], isActive: false, openFiles: 0 });
        }),
      );
      const table = await openTeam();
      fireEvent.click(await within(table).findByTestId(`team-deactivate-${ADEL}`));
      const modal = await screen.findByTestId('deactivate-modal');
      await within(modal).findByText('2026-LIT-00001');

      // Confirming without choosing is refused on the form.
      fireEvent.click(screen.getByTestId('deactivate-confirm'));
      expect(
        await within(modal).findAllByText('Choose an active lawyer from your office.'),
      ).toHaveLength(2);
      expect(body).toBeUndefined();

      const all = within(modal).getByTestId('deactivate-all');
      fireEvent.mouseDown(all.querySelector('.ant-select-selector') ?? all);
      const options = await screen.findAllByTitle(/Salma Senior/);
      // The leaver and inactive people are not offered.
      expect(screen.queryByTitle(/Adel Lawyer/)).toBeNull();
      expect(screen.queryByTitle(/Old Paralegal/)).toBeNull();
      fireEvent.click(options[0] as HTMLElement);
      fireEvent.click(screen.getByTestId('deactivate-confirm'));
      await waitFor(() =>
        expect(body).toEqual({
          reassignments: FILES.map((file) => ({ fileId: file.id, newResponsibleLawyerId: SALMA })),
        }),
      );
      await waitFor(() => expect(screen.queryByTestId('deactivate-modal')).toBeNull());
    },
    SLOW,
  );

  it(
    'should keep a lawyer role for a responsible lawyer of open files, and say why the API refuses',
    async () => {
      serveTeam();
      server.use(
        http.patch(api(`users/${SALMA}/role`), () =>
          fail(400, 'VAL-001', [{ field: 'role', message: 'validation.roleHasOpenFiles' }]),
        ),
      );
      const table = await openTeam();
      const adel = await within(table).findByTestId(`team-role-${ADEL}`);
      fireEvent.mouseDown(adel.querySelector('.ant-select-selector') ?? adel);
      const paralegal = await screen.findByTitle('Paralegal');
      expect(paralegal.getAttribute('aria-disabled')).toBe('true');
      fireEvent.mouseDown(adel.querySelector('.ant-select-selector') ?? adel);

      const salma = within(table).getByTestId(`team-role-${SALMA}`);
      fireEvent.mouseDown(salma.querySelector('.ant-select-selector') ?? salma);
      await waitFor(() => expect(screen.getAllByTitle('Paralegal').length).toBeGreaterThan(1));
      const options = screen.getAllByTitle('Paralegal');
      fireEvent.click(options.at(-1) as HTMLElement);
      expect(await screen.findByText(/responsible for open files/)).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show a refused reassignment on the file, or the whole-list rule, and pass axe with the wizard open',
    async () => {
      serveTeam();
      let calls = 0;
      server.use(
        http.get(api(`users/${ADEL}/open-files`), () => ok(FILES)),
        http.post(api(`users/${ADEL}/deactivate`), () => {
          calls += 1;
          return calls === 1
            ? fail(400, 'VAL-001', [
                {
                  field: 'reassignments.1.newResponsibleLawyerId',
                  message: 'validation.responsibleLawyer',
                },
              ])
            : fail(400, 'VAL-001', [
                { field: 'reassignments', message: 'validation.reassignAllFiles' },
              ]);
        }),
      );
      const table = await openTeam();
      fireEvent.click(await within(table).findByTestId(`team-deactivate-${ADEL}`));
      const modal = await screen.findByTestId('deactivate-modal');
      await within(modal).findByText('2026-LIT-00001');
      const all = within(modal).getByTestId('deactivate-all');
      fireEvent.mouseDown(all.querySelector('.ant-select-selector') ?? all);
      fireEvent.click((await screen.findAllByTitle(/Salma Senior/))[0] as HTMLElement);

      fireEvent.click(screen.getByTestId('deactivate-confirm'));
      expect(
        await within(modal).findByText('Choose an active lawyer from your office.'),
      ).toBeTruthy();
      expect(within(modal).queryByTestId('deactivate-error')).toBeNull();

      fireEvent.click(screen.getByTestId('deactivate-confirm'));
      expect((await within(modal).findByTestId('deactivate-error')).textContent).toContain(
        'Choose a new responsible lawyer for every open file.',
      );
      const { violations } = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    SLOW,
  );

  it(
    'should reactivate, and explain a full plan',
    async () => {
      serveTeam();
      server.use(http.post(api(`users/${OLD}/reactivate`), () => fail(422, 'BIZ-008')));
      const table = await openTeam();
      fireEvent.click(await within(table).findByTestId(`team-reactivate-${OLD}`));
      expect(await screen.findByText(/user limit/i)).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show the 403 page to a role without manage:users',
    async () => {
      setViewport(1280);
      signedIn({ role: 'LAWYER', permissions: [...permissionsFor('LAWYER')] });
      renderApp('/team');
      expect(await screen.findByTestId('page-forbidden', {}, { timeout: COLD })).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should render in Arabic, right to left, and pass axe',
    async () => {
      serveTeam();
      const table = await openTeam('ar');
      await within(table).findByText('غير نشط');
      expect(document.documentElement.dir).toBe('rtl');
      const { violations } = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    SLOW,
  );
});
