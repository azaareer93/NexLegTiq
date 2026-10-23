import type { Case, Conflict, FileParty, Party } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { addRequest } from './AddPartyModal';
import { otherFileOf } from './ConflictsModal';
import { groupByRole } from './PartiesTab';
import {
  api,
  fail,
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

const FILE_ID = '01920000-0000-7000-8000-0000000001f1';
const OTHER_FILE_ID = '01920000-0000-7000-8000-0000000001f2';
const LAWYER_ID = '01920000-0000-7000-8000-0000000000a1';
const PARTY_ID = '01920000-0000-7000-8000-0000000009a1';
const FP_PLAINTIFF = '01920000-0000-7000-8000-0000000009b1';
const FP_DEFENDANT = '01920000-0000-7000-8000-0000000009b2';
const FP_NEW = '01920000-0000-7000-8000-0000000009b3';
const CONFLICT_ID = '01920000-0000-7000-8000-0000000009c1';

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
  counts: { parties: 2, notes: 0 },
  createdAt: '2026-10-01T09:00:00.000Z',
};

const party = (id: string, name: string, extra: Partial<FileParty['party']> = {}) => ({
  id,
  isIndividual: true,
  name,
  fullName: name,
  companyName: null,
  phone: null,
  email: null,
  nationalId: null,
  taxId: null,
  address: null,
  legalRepresentative: null,
  notes: null,
  ...extra,
});

const fileParty = (
  id: string,
  partyType: FileParty['partyType'],
  p: FileParty['party'],
): FileParty => ({
  id,
  partyType,
  roleLabel: null,
  joinedAt: '2026-10-02T09:00:00.000Z',
  party: p,
});

const PARTIES: FileParty[] = [
  fileParty(FP_DEFENDANT, 'DEFENDANT', party(PARTY_ID, 'Omar Haddad', { nationalId: '401234567' })),
  fileParty(
    FP_PLAINTIFF,
    'PLAINTIFF',
    party('01920000-0000-7000-8000-0000000009a2', 'Lina Saleh', { phone: '+970599123456' }),
  ),
];

const CONFLICT: Conflict = {
  id: CONFLICT_ID,
  reason: 'ADVERSE_ON_OTHER_FILE',
  party: { id: PARTY_ID, name: 'Omar Haddad' },
  file: { id: FILE_ID, fileNumber: '2026-LIT-00007', title: 'Land dispute' },
  otherFile: { id: OTHER_FILE_ID, fileNumber: '2026-LIT-00003', title: 'Lease' },
  detectedAt: '2026-10-05T09:00:00.000Z',
  resolved: false,
  resolutionNotes: null,
  resolvedAt: null,
};

const REGISTRY: Party[] = [
  {
    id: PARTY_ID,
    isIndividual: true,
    name: 'Omar Haddad',
    fullName: 'Omar Haddad',
    companyName: null,
    phone: null,
    email: null,
  },
];

const page = (items: Conflict[]) =>
  HttpResponse.json({
    success: true,
    data: items,
    meta: {
      timestamp: '2026-10-05T10:00:00.000Z',
      requestId: 'req-12345678',
      pagination: { page: 1, limit: 100, total: items.length, totalPages: 1, hasMore: false },
    },
  });

const asRole = (role: Role, uiLanguage: 'AR' | 'EN' = 'EN') =>
  signedIn({ id: LAWYER_ID, role, uiLanguage, permissions: [...permissionsFor(role)] });

interface Calls {
  writes: { method: string; path: string; body: unknown }[];
  conflictQueries: URLSearchParams[];
}

function serve({ open = [] as Conflict[], raised = [] as Conflict[] } = {}): Calls {
  const calls: Calls = { writes: [], conflictQueries: [] };
  const record =
    (method: string, answer: () => Response) =>
    async ({ request }: { request: Request }) => {
      const text = await request.text();
      calls.writes.push({
        method,
        path: new URL(request.url).pathname,
        body: text ? (JSON.parse(text) as unknown) : null,
      });
      return answer();
    };
  server.use(
    http.get(api(`cases/${FILE_ID}`), () => ok(FILE)),
    http.get(api(`cases/${FILE_ID}/parties`), () => ok(PARTIES)),
    http.get(api('parties'), () => ok(REGISTRY)),
    http.get(api('conflicts'), ({ request }) => {
      calls.conflictQueries.push(new URL(request.url).searchParams);
      return page(open);
    }),
    http.post(
      api(`cases/${FILE_ID}/parties`),
      record('POST', () =>
        ok(
          {
            fileParty: fileParty(FP_NEW, 'DEFENDANT', party(PARTY_ID, 'Omar Haddad')),
            conflicts: raised,
          },
          201,
        ),
      ),
    ),
    http.patch(
      api(`conflicts/${CONFLICT_ID}/resolve`),
      record('PATCH', () => ok({ ...CONFLICT, resolved: true })),
    ),
    http.delete(
      api(`cases/${FILE_ID}/parties/${FP_NEW}`),
      record('DELETE', () => new HttpResponse(null, { status: 204 })),
    ),
  );
  return calls;
}

const openTab = async (locale: 'en' | 'ar' = 'en') => {
  renderApp(`/cases/${FILE_ID}?tab=parties`, locale);
  const tab = await screen.findByTestId('case-parties', {}, { timeout: COLD });
  await within(tab).findByTestId(`party-row-${FP_DEFENDANT}`, {}, { timeout: COLD });
  return tab;
};

const addExisting = async () => {
  fireEvent.click(screen.getByTestId('party-add'));
  const dialog = await screen.findByTestId('add-party-modal');
  const picker = within(dialog).getAllByRole('combobox')[0] as HTMLElement;
  fireEvent.change(picker, { target: { value: 'Omar' } });
  fireEvent.click(await screen.findByTitle('Omar Haddad', {}, { timeout: COLD }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
};

describe('parties helpers', () => {
  it('should group parties by role in the order of the roles, without empty roles', () => {
    expect(groupByRole(PARTIES).map(([type, rows]) => [type, rows.length])).toEqual([
      ['PLAINTIFF', 1],
      ['DEFENDANT', 1],
    ]);
  });

  it('should send an existing party or a new one, without empty fields', () => {
    expect(
      addRequest('existing', { partyId: PARTY_ID, partyType: 'DEFENDANT', roleLabel: ' ' }),
    ).toEqual({
      partyId: PARTY_ID,
      partyType: 'DEFENDANT',
    });
    expect(
      addRequest('new', {
        partyType: 'PLAINTIFF',
        party: { isIndividual: false, companyName: 'Al-Noor Co.', email: '' },
      }),
    ).toEqual({
      partyType: 'PLAINTIFF',
      party: { isIndividual: false, companyName: 'Al-Noor Co.' },
    });
  });

  it('should name the other file of a conflict, or none when it is hidden', () => {
    expect(otherFileOf(CONFLICT, FILE_ID)?.id).toBe(OTHER_FILE_ID);
    expect(otherFileOf(CONFLICT, OTHER_FILE_ID)?.id).toBe(FILE_ID);
    expect(otherFileOf({ ...CONFLICT, file: null }, OTHER_FILE_ID)).toBeNull();
  });
});

describe('parties tab', () => {
  it(
    'should list parties grouped by role with their details',
    async () => {
      asRole('LAWYER');
      serve();
      const tab = await openTab();
      const groups = within(tab).getAllByTestId(/^party-group-/);
      expect(groups.map((group) => group.dataset['testid'])).toEqual([
        'party-group-PLAINTIFF',
        'party-group-DEFENDANT',
      ]);
      expect(within(tab).getByText('Plaintiff')).toBeTruthy();
      expect(within(tab).getByText(/National ID:/).textContent).toContain('401234567');
      expect(screen.queryByTestId('conflict-banner')).toBeNull();
    },
    SLOW,
  );

  it(
    'should add an existing party, show the conflict it raised and record the note',
    async () => {
      asRole('LAWYER');
      const calls = serve({ raised: [CONFLICT] });
      await openTab();
      await addExisting();
      const modal = await screen.findByTestId('conflicts-modal', {}, { timeout: COLD });
      expect(within(modal).getByTestId(`conflict-${CONFLICT_ID}`).textContent).toContain(
        'Omar Haddad is on the other side of the dispute in 2026-LIT-00003.',
      );
      expect(within(modal).getByRole('link', { name: '2026-LIT-00003' }).getAttribute('href')).toBe(
        `/cases/${OTHER_FILE_ID}`,
      );
      fireEvent.click(within(modal).getByTestId('conflicts-proceed'));
      expect(await within(modal).findByText('This field is required.')).toBeTruthy();
      fireEvent.change(within(modal).getByTestId('conflicts-notes'), {
        target: { value: 'Different matter, client consented.' },
      });
      fireEvent.click(within(modal).getByTestId('conflicts-proceed'));
      await waitFor(() =>
        expect(calls.writes.map((write) => write.method)).toEqual(['POST', 'PATCH']),
      );
      expect(calls.writes[0]?.body).toEqual({ partyId: PARTY_ID, partyType: 'DEFENDANT' });
      expect(calls.writes[1]?.body).toEqual({ notes: 'Different matter, client consented.' });
    },
    SLOW,
  );

  it(
    'should take the party off the file again when the conflict is cancelled',
    async () => {
      asRole('LAWYER');
      const calls = serve({ raised: [{ ...CONFLICT, otherFile: null }] });
      await openTab();
      await addExisting();
      const modal = await screen.findByTestId('conflicts-modal', {}, { timeout: COLD });
      expect(modal.textContent).toContain('a file you cannot open');
      fireEvent.click(within(modal).getByTestId('conflicts-cancel-add'));
      await waitFor(() =>
        expect(calls.writes.at(-1)).toMatchObject({
          method: 'DELETE',
          path: `/api/v1/cases/${FILE_ID}/parties/${FP_NEW}`,
        }),
      );
    },
    SLOW,
  );

  it(
    'should add a new party with only the fields filled in',
    async () => {
      asRole('LAWYER');
      const calls = serve();
      await openTab();
      fireEvent.click(screen.getByTestId('party-add'));
      const dialog = await screen.findByTestId('add-party-modal');
      fireEvent.click(within(dialog).getByText('New party'));
      fireEvent.change(await within(dialog).findByTestId('party-full-name'), {
        target: { value: 'Rami Khoury' },
      });
      fireEvent.change(within(dialog).getByTestId('party-national-id'), {
        target: { value: '987654321' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
      await waitFor(() => expect(calls.writes).toHaveLength(1));
      expect(calls.writes[0]?.body).toEqual({
        partyType: 'DEFENDANT',
        party: { isIndividual: true, fullName: 'Rami Khoury', nationalId: '987654321' },
      });
      expect(screen.queryByTestId('conflicts-modal')).toBeNull();
    },
    SLOW,
  );

  it(
    'should offer no changes to a trainee',
    async () => {
      asRole('TRAINEE');
      serve();
      const tab = await openTab();
      expect(within(tab).queryByTestId('party-add')).toBeNull();
      expect(within(tab).queryByTestId(`party-edit-${FP_DEFENDANT}`)).toBeNull();
    },
    SLOW,
  );
});

describe('parties tab changes', () => {
  const SECOND = '01920000-0000-7000-8000-0000000009c2';

  it(
    'should retype a party, send only the change, and show the conflicts it raised without "cancel"',
    async () => {
      asRole('LAWYER');
      const calls = serve();
      const patches: unknown[] = [];
      server.use(
        http.patch(api(`cases/${FILE_ID}/parties/${FP_DEFENDANT}`), async ({ request }) => {
          patches.push(await request.json());
          return ok({ fileParty: PARTIES[0], conflicts: [CONFLICT] });
        }),
      );
      await openTab();
      fireEvent.click(screen.getByTestId(`party-edit-${FP_DEFENDANT}`));
      const dialog = await screen.findByTestId('edit-party-modal');
      fireEvent.mouseDown(within(dialog).getAllByRole('combobox')[0] as HTMLElement);
      fireEvent.click(await screen.findByTitle('Plaintiff'));
      fireEvent.change(within(dialog).getByTestId('edit-party-role-label'), {
        target: { value: 'Second defendant' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      const modal = await screen.findByTestId('conflicts-modal', {}, { timeout: COLD });
      expect(patches).toEqual([{ partyType: 'PLAINTIFF', roleLabel: 'Second defendant' }]);
      expect(within(modal).queryByTestId('conflicts-cancel-add')).toBeNull();
      expect(within(modal).getByTestId('conflicts-reassign').closest('button')?.disabled).toBe(
        true,
      );
      expect(calls.writes).toEqual([]);
    },
    SLOW,
  );

  it(
    'should remove a party after asking',
    async () => {
      asRole('LAWYER');
      serve();
      let removed = false;
      server.use(
        http.delete(api(`cases/${FILE_ID}/parties/${FP_DEFENDANT}`), () => {
          removed = true;
          return new HttpResponse(null, { status: 204 });
        }),
      );
      await openTab();
      fireEvent.click(screen.getByTestId(`party-remove-${FP_DEFENDANT}`));
      expect(removed).toBe(false);
      fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(removed).toBe(true));
    },
    SLOW,
  );

  it(
    'should finish the remaining conflicts on retry after one failed',
    async () => {
      asRole('LAWYER');
      serve({ open: [CONFLICT, { ...CONFLICT, id: SECOND }] });
      const attempts: string[] = [];
      let failSecond = true;
      server.use(
        http.patch(api(`conflicts/${CONFLICT_ID}/resolve`), () => {
          attempts.push('first');
          // Already recorded on the first try.
          return attempts.length > 1 ? fail(422, 'BIZ-017') : ok({ ...CONFLICT, resolved: true });
        }),
        http.patch(api(`conflicts/${SECOND}/resolve`), () => {
          attempts.push('second');
          if (failSecond) {
            failSecond = false;
            return fail(500, 'SYS-001');
          }
          return ok({ ...CONFLICT, id: SECOND, resolved: true });
        }),
      );
      renderApp(`/cases/${FILE_ID}`, 'en');
      fireEvent.click(await screen.findByTestId('conflict-banner-review', {}, { timeout: COLD }));
      const modal = await screen.findByTestId('conflicts-modal');
      fireEvent.change(within(modal).getByTestId('conflicts-notes'), {
        target: { value: 'Consented' },
      });
      fireEvent.click(within(modal).getByTestId('conflicts-proceed'));
      await waitFor(() => expect(attempts).toEqual(['first', 'second']));
      fireEvent.click(within(modal).getByTestId('conflicts-proceed'));
      await waitFor(() => expect(attempts).toEqual(['first', 'second', 'first', 'second']));
      await waitFor(() => expect(screen.queryByTestId('conflicts-modal')).toBeNull());
    },
    SLOW,
  );

  it(
    'should keep an archived file read-only and hide the banner when conflicts cannot be loaded',
    async () => {
      asRole('OFFICE_MANAGER');
      serve();
      server.use(
        http.get(api(`cases/${FILE_ID}`), () => ok({ ...FILE, status: 'ARCHIVED' })),
        http.get(api('conflicts'), () => fail(500, 'SYS-001')),
      );
      const tab = await openTab();
      expect(within(tab).queryByTestId('party-add')).toBeNull();
      expect(within(tab).queryByTestId(`party-remove-${FP_DEFENDANT}`)).toBeNull();
      expect(screen.queryByTestId('conflict-banner')).toBeNull();
    },
    SLOW,
  );
});

describe('conflict banner', () => {
  it(
    'should warn on the file page while a conflict is open, in Arabic, and resolve it from there',
    async () => {
      asRole('LAWYER', 'AR');
      const calls = serve({ open: [CONFLICT] });
      renderApp(`/cases/${FILE_ID}`, 'ar');
      const banner = await screen.findByTestId('conflict-banner', {}, { timeout: COLD });
      expect(document.documentElement.getAttribute('dir')).toBe('rtl');
      expect(banner.textContent).toContain('في هذا الملف تعارض مصالح لم يُحسم.');
      expect(calls.conflictQueries[0]?.get('fileId')).toBe(FILE_ID);
      expect(calls.conflictQueries[0]?.get('resolved')).toBe('false');
      fireEvent.click(within(banner).getByTestId('conflict-banner-review'));
      const modal = await screen.findByTestId('conflicts-modal');
      expect(within(modal).queryByTestId('conflicts-cancel-add')).toBeNull();
      fireEvent.change(within(modal).getByTestId('conflicts-notes'), {
        target: { value: 'تمت الموافقة' },
      });
      fireEvent.click(within(modal).getByTestId('conflicts-proceed'));
      await waitFor(() => expect(calls.writes).toHaveLength(1));
      expect(calls.writes[0]).toMatchObject({
        method: 'PATCH',
        path: `/api/v1/conflicts/${CONFLICT_ID}/resolve`,
      });
    },
    SLOW,
  );

  it(
    'should show the banner without "proceed" to someone who cannot edit the file',
    async () => {
      asRole('TRAINEE');
      serve({ open: [CONFLICT, { ...CONFLICT, id: '01920000-0000-7000-8000-0000000009c2' }] });
      renderApp(`/cases/${FILE_ID}`, 'en');
      const banner = await screen.findByTestId('conflict-banner', {}, { timeout: COLD });
      expect(banner.textContent).toContain('This file has 2 unresolved conflicts of interest.');
      fireEvent.click(within(banner).getByTestId('conflict-banner-review'));
      const modal = await screen.findByTestId('conflicts-modal');
      expect(within(modal).queryByTestId('conflicts-proceed')).toBeNull();
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should have no accessibility violations on the tab (%s)',
    async (locale) => {
      asRole('LAWYER', locale === 'ar' ? 'AR' : 'EN');
      serve({ open: [CONFLICT] });
      const tab = await openTab(locale);
      if (locale === 'ar') expect(within(tab).getByText('المدعي')).toBeTruthy();
      const { violations } = await axe.run(tab, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    SLOW,
  );
});
