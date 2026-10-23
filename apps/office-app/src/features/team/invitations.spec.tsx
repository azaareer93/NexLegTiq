import type { Invitation, TeamMember } from '@nexlegtiq/shared-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';

import {
  api,
  fail,
  http,
  ok,
  renderApp,
  server,
  SESSION,
  setupTestServer,
  setViewport,
  signedIn,
  USER,
} from '../../test/render-app';
import { useSession } from '../auth';

setupTestServer();

const COLD = 20_000;
const SLOW = 60_000;

const ME: TeamMember = {
  id: USER.id,
  fullName: USER.fullName,
  email: USER.email,
  role: 'OFFICE_MANAGER',
  isActive: true,
  openFiles: 0,
  lastLoginAt: null,
};
const PENDING: Invitation = {
  id: '01920000-0000-7000-8000-0000000000b1',
  email: 'nadia@example.test',
  role: 'LAWYER',
  fullName: 'Nadia',
  status: 'PENDING',
  expiresAt: '2026-10-30T10:00:00.000Z',
  createdAt: '2026-10-23T10:00:00.000Z',
  invitedBy: { id: USER.id, fullName: USER.fullName },
};
const EXPIRED: Invitation = {
  ...PENDING,
  id: '01920000-0000-7000-8000-0000000000b2',
  email: 'old@example.test',
  fullName: null,
  status: 'EXPIRED',
};

const type = (testId: string, value: string) =>
  fireEvent.change(screen.getByTestId(testId), { target: { value } });

async function openTeam(invitations: Invitation[], locale: 'en' | 'ar' = 'en') {
  server.use(
    http.get(api('users'), () => ok([ME])),
    http.get(api('users/invitations'), () => ok(invitations)),
  );
  setViewport(1280);
  signedIn(locale === 'ar' ? { uiLanguage: 'AR' } : {});
  renderApp('/team', locale);
  return screen.findByTestId('invitations-table', {}, { timeout: COLD });
}

describe('Team invitations (D-134)', () => {
  it(
    'should invite several people, keep a refused row with its reason and list pending invitations',
    async () => {
      const bodies: unknown[] = [];
      server.use(
        http.post(api('users/invite'), async ({ request }) => {
          const body = (await request.json()) as { email: string };
          bodies.push(body);
          return body.email === 'taken@example.test'
            ? fail(409, 'RES-002')
            : ok({ ...PENDING, email: body.email }, 201);
        }),
      );
      const table = await openTeam([PENDING, EXPIRED]);
      expect(await within(table).findByText('Pending')).toBeTruthy();
      expect(within(table).getByText('Expired')).toBeTruthy();

      fireEvent.click(screen.getByTestId('team-invite'));
      type('invite-email-0', 'new@example.test');
      fireEvent.click(screen.getByTestId('invite-add-row'));
      type('invite-email-1', 'taken@example.test');
      type('invite-message', 'Welcome');
      fireEvent.click(screen.getByTestId('invite-submit'));

      await waitFor(() => expect(bodies).toHaveLength(2));
      expect(bodies[0]).toEqual({ email: 'new@example.test', role: 'LAWYER', message: 'Welcome' });
      expect(await screen.findByText('1 invitation sent')).toBeTruthy();
      // The refused row stays, alone, with the server's reason.
      await waitFor(() =>
        expect((screen.getByTestId('invite-email-0') as HTMLInputElement).value).toBe(
          'taken@example.test',
        ),
      );
      expect(screen.queryByTestId('invite-email-1')).toBeNull();
    },
    SLOW,
  );

  it(
    'should refuse a bad email before sending anything',
    async () => {
      let sent = false;
      server.use(
        http.post(api('users/invite'), () => {
          sent = true;
          return ok(PENDING, 201);
        }),
      );
      await openTeam([]);
      fireEvent.click(screen.getByTestId('team-invite'));
      type('invite-email-0', 'not-an-email');
      fireEvent.click(screen.getByTestId('invite-submit'));
      expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
      expect(sent).toBe(false);
    },
    SLOW,
  );

  it(
    'should resend and, after confirming, revoke an invitation',
    async () => {
      let resent = false;
      let revoked = false;
      server.use(
        http.post(api(`users/invitations/${EXPIRED.id}/resend`), () => {
          resent = true;
          return ok({ ...EXPIRED, status: 'PENDING' });
        }),
        http.delete(api(`users/invitations/${PENDING.id}`), () => {
          revoked = true;
          return new Response(null, { status: 204 });
        }),
      );
      await openTeam([PENDING, EXPIRED]);
      fireEvent.click(await screen.findByTestId(`invitation-resend-${EXPIRED.id}`));
      expect(await screen.findByText('Invitation sent again')).toBeTruthy();
      expect(resent).toBe(true);

      fireEvent.click(screen.getByTestId(`invitation-revoke-${PENDING.id}`));
      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('nadia@example.test');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
      expect(await screen.findByText('Invitation revoked')).toBeTruthy();
      expect(revoked).toBe(true);
    },
    SLOW,
  );

  it(
    'should render in Arabic, right to left, and pass axe',
    async () => {
      const table = await openTeam([PENDING], 'ar');
      await within(table).findByText('بانتظار القبول');
      expect(document.documentElement.dir).toBe('rtl');
      const { violations } = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    SLOW,
  );
});

describe('Accept invitation page (D-134)', () => {
  const token = 'i'.repeat(43);
  const preview = {
    officeName: 'Adel & Partners',
    inviterName: 'Basma',
    email: 'nadia@example.test',
    role: 'LAWYER',
    fullName: 'Nadia',
    expiresAt: '2026-10-30T10:00:00.000Z',
  };

  it(
    'should show the office and role, create the account and sign in',
    async () => {
      let body: unknown;
      server.use(
        http.get(api(`auth/invites/${token}`), () => ok(preview)),
        http.post(api('auth/accept-invite'), async ({ request }) => {
          body = await request.json();
          return ok(SESSION, 201);
        }),
        http.get(api('offices/me/subscription'), () => fail(500, 'SYS-001')),
      );
      const { router } = renderApp(`/accept-invite?token=${token}`);
      const intro = await screen.findByTestId('invite-intro', {}, { timeout: COLD });
      expect(intro.textContent).toContain('Adel & Partners');
      await waitFor(() => expect(router.state.location.search).toBe(''));
      expect((screen.getByTestId('invite-full-name') as HTMLInputElement).value).toBe('Nadia');

      type('invite-password', 'Testtesttest1');
      fireEvent.click(screen.getByTestId('invite-accept-terms'));
      fireEvent.click(screen.getByTestId('invite-accept-privacy'));
      fireEvent.click(screen.getByTestId('invite-submit'));
      await waitFor(() => expect(useSession.getState().status).toBe('authenticated'));
      expect(body).toEqual({
        token,
        fullName: 'Nadia',
        password: 'Testtesttest1',
        acceptTerms: true,
        acceptPrivacy: true,
      });
      await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    },
    SLOW,
  );

  it(
    'should explain a used or expired link',
    async () => {
      server.use(http.get(api(`auth/invites/${token}`), () => fail(410, 'RES-004')));
      renderApp(`/accept-invite?token=${token}`);
      expect(await screen.findByTestId('invite-invalid', {}, { timeout: COLD })).toBeTruthy();
      expect(screen.getByText('This invitation is no longer valid')).toBeTruthy();
    },
    SLOW,
  );
});
