import type { Client, ClientListItem, ContactPerson } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { LANGUAGE_STORAGE_KEY } from '@nexlegtiq/shared-ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { changesOf, createBody, valuesOf } from './client-form';
import { ClientSelect } from './components/ClientSelect';
import { readQuery, withChanges } from './list-params';
import { AppRoot } from '../../app/app-root';
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
} from '../../test/render-app';

setupTestServer();

const SLOW = 60_000;
/** axe over an AntD table takes up to a minute in jsdom on a busy machine. */
const AXE_SLOW = 180_000;
/** The first visit loads the page's chunk cold, which takes several seconds on a busy runner. */
const COLD = 20_000;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };

const ID = '01920000-0000-7000-8000-0000000000c1';
const CONTACT_ID = '01920000-0000-7000-8000-0000000000d1';

const row = (extra: Partial<ClientListItem> = {}): ClientListItem => ({
  id: ID,
  clientType: 'INDIVIDUAL',
  displayName: 'Omar Khalil',
  fullName: 'Omar Khalil',
  companyName: null,
  phone: '+970599000000',
  email: 'omar@example.test',
  isActive: true,
  primaryLawyer: null,
  openFiles: 2,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-05T09:00:00.000Z',
  ...extra,
});

const contact = (extra: Partial<ContactPerson> = {}): ContactPerson => ({
  id: CONTACT_ID,
  fullName: 'Sara Khalil',
  position: null,
  email: null,
  phone: null,
  isPrimary: true,
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-05T10:00:00.000Z',
  ...extra,
});

const detail = (extra: Partial<Client> = {}): Client => ({
  ...row(),
  nationalId: null,
  taxId: null,
  address: null,
  industry: null,
  closedFiles: 0,
  contacts: [],
  ...extra,
});

/** Answers `GET /clients` with `rows` and records every query string the page sends. */
function serveClients(rows: ClientListItem[]): URLSearchParams[] {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get(api('clients'), ({ request }) => {
      const query = new URL(request.url).searchParams;
      queries.push(query);
      const pagination = { page: 1, limit: 20, total: rows.length, totalPages: 1, hasMore: false };
      return HttpResponse.json({ success: true, data: rows, meta: { ...meta, pagination } });
    }),
  );
  return queries;
}

/** Records the bodies of every write to the client and its contacts. */
function serveWrites(client: Client): { method: string; path: string; body: unknown }[] {
  const writes: { method: string; path: string; body: unknown }[] = [];
  const record = async (request: Request) => {
    const body: unknown = request.method === 'DELETE' ? null : await request.json();
    writes.push({ method: request.method, path: new URL(request.url).pathname, body });
  };
  server.use(
    http.get(api(`clients/${client.id}`), () => ok(client)),
    http.post(api('clients'), async ({ request }) => {
      await record(request);
      return ok(client, 201);
    }),
    http.patch(api(`clients/${client.id}`), async ({ request }) => {
      await record(request);
      return ok(client);
    }),
    http.post(api(`clients/${client.id}/contacts`), async ({ request }) => {
      await record(request);
      return ok(contact(), 201);
    }),
    http.patch(api(`clients/${client.id}/contacts/${CONTACT_ID}`), async ({ request }) => {
      await record(request);
      return ok(contact({ isPrimary: true }));
    }),
    http.delete(api(`clients/${client.id}/contacts/${CONTACT_ID}`), async ({ request }) => {
      await record(request);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return writes;
}

/** Types into the input `testId` (or the input inside it: AntD puts some test ids on a wrapper). */
const type = (testId: string, value: string) => {
  const element = screen.getByTestId(testId);
  const input = element.matches('input, textarea') ? element : element.querySelector('input');
  fireEvent.change(input ?? element, { target: { value } });
};
const lastQuery = (queries: URLSearchParams[]) =>
  Object.fromEntries(queries.at(-1)?.entries() ?? []);
const table = () => screen.findByTestId('clients-table', {}, { timeout: COLD });

/** Picks `label` in the AntD select `testId`. */
async function choose(testId: string, label: string): Promise<void> {
  fireEvent.mouseDown(within(screen.getByTestId(testId)).getByRole('combobox'));
  fireEvent.click(await screen.findByTitle(label));
}

describe('list parameters and request bodies', () => {
  it('should keep only the parameters the contract accepts and go back to page 1 on a filter', () => {
    expect(
      readQuery(new URLSearchParams('clientType=NGO&isActive=maybe&sort=passwordHash&page=2&x=1')),
    ).toEqual({ clientType: 'NGO', page: '2' });
    expect(
      Object.fromEntries(withChanges(new URLSearchParams('page=3'), { isActive: 'true' })),
    ).toEqual({
      isActive: 'true',
    });
  });

  it('should send only the fields of the chosen type, with the name as the legal name', () => {
    const values = {
      displayName: ' Khalil Trading ',
      nationalId: '123',
      taxId: '562',
      industry: '',
      phone: '+970599000000',
    };
    expect(createBody({ clientType: 'CORPORATION', ...values })).toEqual({
      clientType: 'CORPORATION',
      displayName: 'Khalil Trading',
      companyName: 'Khalil Trading',
      taxId: '562',
      phone: '+970599000000',
    });
    expect(createBody({ clientType: 'INDIVIDUAL', ...values, displayName: 'Omar' })).toEqual({
      clientType: 'INDIVIDUAL',
      displayName: 'Omar',
      fullName: 'Omar',
      nationalId: '123',
      phone: '+970599000000',
    });
  });

  it('should send only what changed, clearing emptied fields and moving the name with the type', () => {
    const client = detail({ phone: '+970599000000', email: 'omar@example.test' });
    const values = {
      clientType: 'INDIVIDUAL',
      displayName: 'Omar Khalil',
      nationalId: '',
      phone: '+970599111111',
      email: '',
      address: '',
      isActive: true,
    };
    expect(changesOf(client, values)).toEqual({ phone: '+970599111111', email: null });
    expect(
      changesOf(client, { ...values, phone: client.phone, email: client.email, clientType: 'NGO' }),
    ).toEqual({
      clientType: 'NGO',
      companyName: 'Omar Khalil',
      fullName: null,
    });
  });

  it('should clear the old type identification on a type change and keep a different legal name', () => {
    const person = detail({ nationalId: '401234567' });
    expect(changesOf(person, { ...valuesOf(person), clientType: 'NGO', taxId: '562' })).toEqual({
      clientType: 'NGO',
      taxId: '562',
      nationalId: null,
      companyName: 'Omar Khalil',
      fullName: null,
    });
    // A legal name stored apart from the display name is not overwritten by a rename.
    const legal = detail({ displayName: 'Omar', fullName: 'Omar Ahmad Khalil' });
    expect(changesOf(legal, { ...valuesOf(legal), displayName: 'Omar K.' })).toEqual({
      displayName: 'Omar K.',
    });
    expect(changesOf(person, { ...valuesOf(person), displayName: 'Omar A. Khalil' })).toEqual({
      displayName: 'Omar A. Khalil',
      fullName: 'Omar A. Khalil',
      companyName: null,
    });
  });
});

describe('clients list', () => {
  it(
    'should list clients with their phone and email left-to-right and open one in the drawer',
    async () => {
      setViewport(1280);
      signedIn();
      serveClients([
        row(),
        row({
          id: '01920000-0000-7000-8000-0000000000c2',
          displayName: 'Nour NGO',
          isActive: false,
          clientType: 'NGO',
          phone: null,
          email: null,
        }),
      ]);
      serveWrites(detail());
      renderApp('/clients');
      const grid = await table();
      expect(within(grid).getByText('+970599000000').closest('[dir="ltr"]')).toBeTruthy();
      expect(within(grid).getByText('omar@example.test').closest('[dir="ltr"]')).toBeTruthy();
      expect(within(grid).getByText('Inactive')).toBeTruthy();
      expect(screen.getByText('2 clients')).toBeTruthy();

      fireEvent.click(within(grid).getByText('Omar Khalil'));
      expect(await screen.findByText('Edit client')).toBeTruthy();
      expect((await screen.findByTestId('client-name-input')).getAttribute('value')).toBe(
        'Omar Khalil',
      );
      expect(screen.getByTestId('client-contacts')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should search as the user types (once it settles) and filter by type and status in the URL',
    async () => {
      setViewport(1280);
      signedIn();
      const queries = serveClients([row()]);
      const { router } = renderApp('/clients');
      await table();

      type('clients-search', 'om');
      type('clients-search', 'omar ');
      await waitFor(() => expect(lastQuery(queries)).toEqual({ search: 'omar' }));
      expect(queries.filter((query) => query.get('search') === 'om')).toHaveLength(0);

      await choose('clients-filter-type', 'Company');
      fireEvent.click(within(screen.getByTestId('clients-filter-status')).getByText('Inactive'));
      await waitFor(() =>
        expect(lastQuery(queries)).toEqual({
          search: 'omar',
          clientType: 'CORPORATION',
          isActive: 'false',
        }),
      );
      expect(new URLSearchParams(router.state.location.search).get('isActive')).toBe('false');
    },
    SLOW,
  );

  it(
    'should offer the first client when there are none, and clearing the filters when nothing matches',
    async () => {
      setViewport(1280);
      signedIn();
      const queries = serveClients([]);
      const { router } = renderApp('/clients?clientType=NGO&search=zz');
      expect(await screen.findByTestId('clients-clear', {}, { timeout: COLD })).toBeTruthy();
      fireEvent.click(screen.getByTestId('clients-clear'));
      await waitFor(() => expect(router.state.location.search).toBe(''));
      expect(lastQuery(queries)).toEqual({});
      expect(within(screen.getByTestId('clients-search')).getByRole('searchbox')).toHaveProperty(
        'value',
        '',
      );

      fireEvent.click(await screen.findByTestId('clients-empty-new'));
      expect(await screen.findByTestId('client-name-input')).toBeTruthy();
    },
    SLOW,
  );
});

describe('clients list states and permissions', () => {
  it(
    'should explain a failed load with a reference and recover on retry',
    async () => {
      setViewport(1280);
      signedIn();
      server.use(http.get(api('clients'), () => fail(503, 'SYS-002')));
      renderApp('/clients');
      expect(await screen.findByTestId('clients-error', {}, { timeout: COLD })).toBeTruthy();
      serveClients([row()]);
      fireEvent.click(within(screen.getByTestId('clients-error')).getByRole('button'));
      expect(await table()).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should write the sort order to the URL and the request',
    async () => {
      setViewport(1280);
      signedIn();
      const queries = serveClients([row()]);
      const { router } = renderApp('/clients');
      const grid = await table();
      fireEvent.click(within(grid).getByRole('columnheader', { name: /Open cases/ }));
      await waitFor(() => expect(lastQuery(queries).sort).toBe('openFiles:asc'));
      expect(new URLSearchParams(router.state.location.search).get('sort')).toBe('openFiles:asc');
    },
    SLOW,
  );

  it(
    'should show the 403 page, ask nothing and hide the menu item for a role without manage:clients',
    async () => {
      setViewport(1280);
      signedIn({ role: 'TRAINEE', permissions: [...permissionsFor('TRAINEE')] });
      const queries = serveClients([row()]);
      renderApp('/clients');
      expect(await screen.findByTestId('page-forbidden', {}, { timeout: COLD })).toBeTruthy();
      expect(queries).toHaveLength(0);
      expect(screen.queryByTestId('nav-clients')).toBeNull();
    },
    SLOW,
  );
});

describe('client drawer', () => {
  it(
    'should create a person, then stay open on the new client so contact persons can be added',
    async () => {
      setViewport(1280);
      signedIn();
      serveClients([]);
      const writes = serveWrites(detail({ nationalId: '401234567' }));
      // StrictMode, as in main.tsx: its dev remount must not wipe the new client's starting values.
      renderApp('/clients', 'en', { strict: true });
      fireEvent.click(await screen.findByTestId('clients-new', {}, { timeout: COLD }));
      await screen.findByTestId('client-name-input');
      expect(screen.queryByTestId('client-tax-id-input')).toBeNull();
      expect(screen.queryByTestId('client-contacts')).toBeNull();

      type('client-name-input', 'Omar Khalil');
      type('client-national-id-input', '401234567');
      type('client-email-input', 'not-an-email');
      fireEvent.click(screen.getByTestId('client-save'));
      expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
      expect(writes).toHaveLength(0);

      type('client-email-input', '');
      fireEvent.click(screen.getByTestId('client-save'));
      expect(await screen.findByTestId('client-contacts')).toBeTruthy();
      expect(writes[0]).toEqual({
        method: 'POST',
        path: '/api/v1/clients',
        body: {
          clientType: 'INDIVIDUAL',
          displayName: 'Omar Khalil',
          fullName: 'Omar Khalil',
          nationalId: '401234567',
        },
      });
      expect(screen.getByText('Edit client')).toBeTruthy();

      type('contact-name-input', 'Sara Khalil');
      fireEvent.click(screen.getByTestId('contact-save'));
      await waitFor(() =>
        expect(writes[1]).toEqual({
          method: 'POST',
          path: `/api/v1/clients/${ID}/contacts`,
          body: { fullName: 'Sara Khalil', isPrimary: false },
        }),
      );
    },
    SLOW,
  );

  it(
    'should ask an organisation for its tax id and industry instead of a national id',
    async () => {
      setViewport(1280);
      signedIn();
      serveClients([]);
      renderApp('/clients');
      fireEvent.click(await screen.findByTestId('clients-new', {}, { timeout: COLD }));
      await screen.findByTestId('client-name-input');
      await choose('client-type-input', 'Company');
      expect(await screen.findByTestId('client-tax-id-input')).toBeTruthy();
      expect(screen.getByTestId('client-industry-input')).toBeTruthy();
      expect(screen.queryByTestId('client-national-id-input')).toBeNull();
      expect(screen.getByText('Organization name')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should save only what changed, promote a contact and remove one after confirming',
    async () => {
      setViewport(1280);
      signedIn();
      serveClients([row()]);
      const second = contact({
        id: '01920000-0000-7000-8000-0000000000d2',
        fullName: 'Ali Khalil',
        isPrimary: false,
      });
      const writes = serveWrites(detail({ contacts: [contact({ isPrimary: false }), second] }));
      renderApp('/clients');
      fireEvent.click(within(await table()).getByText('Omar Khalil'));
      await screen.findByTestId('client-name-input');

      fireEvent.click(screen.getByTestId(`contact-primary-${CONTACT_ID}`));
      await waitFor(() =>
        expect(writes.at(-1)).toEqual({
          method: 'PATCH',
          path: `/api/v1/clients/${ID}/contacts/${CONTACT_ID}`,
          body: { isPrimary: true },
        }),
      );

      fireEvent.click(screen.getByTestId(`contact-remove-${CONTACT_ID}`));
      const confirm = (await screen.findByText('Remove this contact person?')).closest(
        '.ant-modal',
      );
      fireEvent.click(within(confirm as HTMLElement).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(writes.at(-1)?.method).toBe('DELETE'));

      type('client-phone-input', '+970599111111');
      fireEvent.click(screen.getByTestId('client-save'));
      await waitFor(() =>
        expect(writes.at(-1)).toEqual({
          method: 'PATCH',
          path: `/api/v1/clients/${ID}`,
          body: { phone: '+970599111111' },
        }),
      );
    },
    SLOW,
  );
});

describe('client drawer errors and contact edits', () => {
  it(
    "should put the API's field errors on their fields, without a banner",
    async () => {
      setViewport(1280);
      signedIn();
      serveClients([]);
      server.use(
        http.post(api('clients'), () =>
          fail(400, 'VAL-001', [{ field: 'phone', message: 'validation.phone' }]),
        ),
      );
      renderApp('/clients');
      fireEvent.click(await screen.findByTestId('clients-new', {}, { timeout: COLD }));
      type('client-name-input', 'Omar Khalil');
      type('client-phone-input', '+970599000000');
      fireEvent.click(screen.getByTestId('client-save'));
      expect(await screen.findByText('Enter a valid phone number.')).toBeTruthy();
      expect(screen.queryByTestId('client-error')).toBeNull();
    },
    SLOW,
  );

  it(
    'should edit a contact person, sending only the changed fields',
    async () => {
      setViewport(1280);
      signedIn();
      serveClients([row()]);
      const writes = serveWrites(detail({ contacts: [contact()] }));
      renderApp('/clients');
      fireEvent.click(within(await table()).getByText('Omar Khalil'));
      fireEvent.click(await screen.findByTestId(`contact-edit-${CONTACT_ID}`));
      expect(screen.getByTestId('contact-name-input')).toHaveProperty('value', 'Sara Khalil');
      type('contact-position-input', 'CFO');
      fireEvent.click(screen.getByTestId('contact-save'));
      await waitFor(() =>
        expect(writes.at(-1)).toEqual({
          method: 'PATCH',
          path: `/api/v1/clients/${ID}/contacts/${CONTACT_ID}`,
          body: { position: 'CFO' },
        }),
      );
    },
    SLOW,
  );
});

describe('client picker', () => {
  it(
    'should search active clients as the user types, pick one, and create one inline',
    async () => {
      signedIn();
      localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
      const queries = serveClients([row()]);
      const writes = serveWrites(
        detail({ id: '01920000-0000-7000-8000-0000000000c9', displayName: 'Rami Saleh' }),
      );
      const picked = vi.fn();
      render(
        <AppRoot>
          <ClientSelect onChange={picked} />
        </AppRoot>,
      );
      const combobox = within(screen.getByTestId('client-select')).getByRole('combobox');
      fireEvent.mouseDown(combobox);
      fireEvent.change(combobox, { target: { value: 'omar' } });
      await waitFor(() => expect(lastQuery(queries)).toMatchObject({ search: 'omar' }));
      fireEvent.click(await screen.findByTitle('Omar Khalil'));
      expect(picked).toHaveBeenLastCalledWith(ID, { id: ID, displayName: 'Omar Khalil' });
      expect(lastQuery(queries)).toEqual({ isActive: 'true', limit: '20', search: 'omar' });

      fireEvent.mouseDown(combobox);
      fireEvent.change(combobox, { target: { value: 'Rami Saleh' } });
      fireEvent.click(await screen.findByTestId('client-select-create'));
      expect((await screen.findByTestId('client-name-input')).getAttribute('value')).toBe(
        'Rami Saleh',
      );
      fireEvent.click(screen.getByTestId('client-save'));
      await waitFor(() =>
        expect(picked).toHaveBeenLastCalledWith('01920000-0000-7000-8000-0000000000c9', {
          id: '01920000-0000-7000-8000-0000000000c9',
          displayName: 'Rami Saleh',
        }),
      );
      expect(writes[0]?.body).toMatchObject({
        displayName: 'Rami Saleh',
        clientType: 'INDIVIDUAL',
      });
    },
    SLOW,
  );
});

describe('clients in Arabic', () => {
  it(
    'should label the drawer in Arabic and pass axe with it open',
    async () => {
      setViewport(1280);
      signedIn({ uiLanguage: 'AR' });
      serveClients([]);
      renderApp('/clients', 'ar');
      fireEvent.click(await screen.findByTestId('clients-new', {}, { timeout: COLD }));
      await screen.findByTestId('client-name-input');
      expect(screen.getByText('الاسم الكامل')).toBeTruthy();
      expect(screen.getByText('رقم الهوية')).toBeTruthy();
      const drawer = document.querySelector('.ant-drawer') ?? document.body;
      const { violations } = await axe.run(drawer, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    AXE_SLOW,
  );

  it(
    'should lay the list out right-to-left with Arabic labels and pass axe',
    async () => {
      setViewport(1280);
      signedIn({ uiLanguage: 'AR' });
      serveClients([row()]);
      renderApp('/clients', 'ar');
      const grid = await table();
      expect(document.documentElement.dir).toBe('rtl');
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('الموكلون');
      expect(within(grid).getByText('فرد')).toBeTruthy();
      expect(within(grid).getByText('+970599000000').closest('[dir="ltr"]')).toBeTruthy();
      const { violations } = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    AXE_SLOW,
  );
});
