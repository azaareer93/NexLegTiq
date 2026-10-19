import type { Case, ClientListItem, DirectoryUser } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { createBody, defaultLawyer } from './case-form';
import { isNewCaseShortcut } from './quick-create';
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
/** The modal is its own chunk: the first opening loads it cold. */
const COLD = 20_000;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };

const CLIENT_ID = '01920000-0000-7000-8000-0000000000c1';
const FILE_ID = '01920000-0000-7000-8000-0000000000f1';
const PARALEGAL_ID = '01920000-0000-7000-8000-0000000000a3';

const people: DirectoryUser[] = [
  { id: USER.id, fullName: USER.fullName, role: 'OFFICE_MANAGER' },
  { id: '01920000-0000-7000-8000-0000000000a2', fullName: 'Omar Lawyer', role: 'LAWYER' },
  { id: PARALEGAL_ID, fullName: 'Sami Paralegal', role: 'PARALEGAL' },
  { id: '01920000-0000-7000-8000-0000000000a4', fullName: 'Tala Trainee', role: 'TRAINEE' },
];

const client: ClientListItem = {
  id: CLIENT_ID,
  clientType: 'INDIVIDUAL',
  displayName: 'Omar Khalil',
  fullName: 'Omar Khalil',
  companyName: null,
  phone: null,
  email: null,
  isActive: true,
  primaryLawyer: null,
  openFiles: 0,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-05T09:00:00.000Z',
};

const created: Case = {
  id: FILE_ID,
  fileNumber: '2026-LIT-00042',
  title: 'Land dispute',
  fileType: 'LITIGATION',
  status: 'OPEN',
  priority: 'MEDIUM',
  openingDate: '2026-10-19',
  isConfidential: false,
  primaryClient: null,
  responsibleLawyer: { id: USER.id, fullName: USER.fullName },
  updatedAt: '2026-10-19T10:00:00.000Z',
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
  team: [],
  counts: { parties: 0, notes: 0 },
  createdAt: '2026-10-19T10:00:00.000Z',
};

/** Answers the pickers and records every `POST /cases` body. */
function serve(): unknown[] {
  const bodies: unknown[] = [];
  const pagination = { page: 1, limit: 20, total: 1, totalPages: 1, hasMore: false };
  server.use(
    http.get(api('users/directory'), () => ok(people)),
    http.get(api('clients'), () =>
      HttpResponse.json({ success: true, data: [client], meta: { ...meta, pagination } }),
    ),
    http.get(api('cases'), () =>
      HttpResponse.json({
        success: true,
        data: [],
        meta: { ...meta, pagination: { ...pagination, total: 0, totalPages: 0 } },
      }),
    ),
    http.post(api('cases'), async ({ request }) => {
      bodies.push(await request.json());
      return ok(created, 201);
    }),
    http.get(api(`cases/${FILE_ID}`), () => ok(created)),
  );
  return bodies;
}

async function openFromList(locale: 'en' | 'ar' = 'en'): Promise<HTMLElement> {
  renderApp('/cases', locale);
  fireEvent.click(await screen.findByTestId('cases-new', {}, { timeout: COLD }));
  return screen.findByTestId('create-case-modal', {}, { timeout: COLD });
}

/** Picks the first option of an AntD Select opened by mouse-down on its control. */
async function pick(testId: string, label: string): Promise<void> {
  const select = screen.getByTestId(testId);
  fireEvent.mouseDown(select.querySelector('.ant-select-selector') ?? select);
  fireEvent.click(await screen.findByTitle(label));
}

async function fillEssentials(): Promise<void> {
  fireEvent.change(screen.getByTestId('create-title'), { target: { value: '  Land dispute ' } });
  const clientSelect = screen.getByTestId('create-client');
  fireEvent.mouseDown(clientSelect.querySelector('.ant-select-selector') ?? clientSelect);
  fireEvent.click(await screen.findByTitle('Omar Khalil'));
  await pick('create-type', 'Litigation');
}

describe('quick-create case (D-123)', () => {
  it('should build the body from the form and default the lawyer to an eligible caller', () => {
    expect(
      createBody({
        title: ' T ',
        clientId: CLIENT_ID,
        subType: '  ',
        judgeId: null,
        fileType: 'LITIGATION',
      }),
    ).toEqual({
      title: 'T',
      fileType: 'LITIGATION',
      clientIds: [CLIENT_ID],
      primaryClientId: CLIENT_ID,
    });
    expect(defaultLawyer({ id: 'u1', role: 'LAWYER' })).toBe('u1');
    expect(defaultLawyer({ id: 'u2', role: 'PARALEGAL' })).toBeUndefined();
    expect(defaultLawyer(null)).toBeUndefined();
  });

  it('should recognise Ctrl+Alt+N only outside text fields', () => {
    const key = (init: KeyboardEventInit, target?: EventTarget) => {
      const event = new KeyboardEvent('keydown', init);
      if (target) Object.defineProperty(event, 'target', { value: target });
      return isNewCaseShortcut(event);
    };
    expect(key({ ctrlKey: true, altKey: true, code: 'KeyN' })).toBe(true);
    expect(key({ ctrlKey: true, code: 'KeyN' })).toBe(false);
    expect(key({ ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyN' })).toBe(false);
    expect(key({ ctrlKey: true, altKey: true, code: 'KeyN', repeat: true })).toBe(false);
    expect(
      key({ ctrlKey: true, altKey: true, code: 'KeyN' }, document.createElement('input')),
    ).toBe(false);
  });

  it(
    'should create a case with "Create & open", show its number and open it',
    async () => {
      setViewport(1280);
      signedIn();
      const bodies = serve();
      await openFromList();
      await waitFor(() =>
        expect(screen.getByTestId('create-lawyer').textContent).toContain(USER.fullName),
      );
      await fillEssentials();
      await pick('create-paralegal', 'Sami Paralegal');
      fireEvent.click(screen.getByTestId('create-submit-open'));
      await screen.findByText(/Case .*2026-LIT-00042.* created\./);
      expect(bodies).toEqual([
        {
          title: 'Land dispute',
          fileType: 'LITIGATION',
          priority: 'MEDIUM',
          responsibleLawyerId: USER.id,
          responsibleParalegalId: PARALEGAL_ID,
          clientIds: [CLIENT_ID],
          primaryClientId: CLIENT_ID,
          isConfidential: false,
        },
      ]);
      await screen.findByTestId('page-case', {}, { timeout: COLD });
      expect(screen.queryByTestId('create-case-modal')).toBeNull();
    },
    SLOW,
  );

  it(
    'should stay on the page with "Create", and refuse an empty form without calling the API',
    async () => {
      setViewport(1280);
      signedIn();
      const bodies = serve();
      const modal = await openFromList();
      fireEvent.click(screen.getByTestId('create-submit'));
      expect(await within(modal).findAllByText('This field is required.')).not.toHaveLength(0);
      expect(bodies).toHaveLength(0);
      await fillEssentials();
      fireEvent.click(screen.getByTestId('create-submit'));
      await screen.findByText(/Case .*2026-LIT-00042.* created\./);
      expect(bodies).toHaveLength(1);
      await waitFor(() => expect(screen.queryByTestId('create-case-modal')).toBeNull());
      expect(screen.getByTestId('page-cases')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should show an API validation error on its field',
    async () => {
      setViewport(1280);
      signedIn();
      serve();
      server.use(
        http.post(api('cases'), () =>
          fail(400, 'VAL-001', [
            { field: 'responsibleLawyerId', message: 'validation.responsibleLawyer' },
          ]),
        ),
      );
      const modal = await openFromList();
      await waitFor(() =>
        expect(screen.getByTestId('create-lawyer').textContent).toContain(USER.fullName),
      );
      await fillEssentials();
      fireEvent.click(screen.getByTestId('create-submit'));
      await waitFor(() =>
        expect(
          modal.querySelector('.ant-form-item-has-error [data-testid="create-lawyer"]'),
        ).toBeTruthy(),
      );
    },
    SLOW,
  );

  it(
    'should open with Ctrl+Alt+N anywhere, but not for a role that cannot create files',
    async () => {
      setViewport(1280);
      signedIn();
      serve();
      renderApp('/tasks');
      await screen.findByTestId('page-tasks', {}, { timeout: COLD });
      fireEvent.keyDown(window, { ctrlKey: true, altKey: true, code: 'KeyN', key: 'n' });
      expect(await screen.findByTestId('create-case-modal', {}, { timeout: COLD })).toBeTruthy();
      fireEvent.click(screen.getByTestId('create-cancel'));
      await waitFor(() => expect(screen.queryByTestId('create-case-modal')).toBeNull());
    },
    SLOW,
  );

  it(
    'should ignore the shortcut for a trainee',
    async () => {
      setViewport(1280);
      signedIn({ role: 'TRAINEE', permissions: [...permissionsFor('TRAINEE')] });
      renderApp('/tasks');
      await screen.findByTestId('page-tasks', {}, { timeout: COLD });
      fireEvent.keyDown(window, { ctrlKey: true, altKey: true, code: 'KeyN', key: 'n' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByTestId('create-case-modal')).toBeNull();
    },
    SLOW,
  );

  it(
    'should label the form in Arabic and pass axe with it open',
    async () => {
      setViewport(1280);
      signedIn({ uiLanguage: 'AR' });
      serve();
      const modal = await openFromList('ar');
      expect(within(modal).getAllByText('ملف جديد').length).toBeGreaterThan(0);
      expect(within(modal).getByText('المحامي المسؤول')).toBeTruthy();
      const { violations } = await axe.run(modal, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    AXE_SLOW,
  );
});
