import type { Case, Note } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

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
const XSS = '<img src=x onerror=alert(1)>';

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

const note = (n: number, extra: Partial<Note> = {}): Note => ({
  id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  body: `Note ${n}`,
  isConfidential: false,
  pinned: false,
  author: { id: LAWYER, fullName: 'Sami Nasser' },
  canEdit: true,
  createdAt: '2026-11-09T07:00:00.000Z',
  updatedAt: '2026-11-09T07:00:00.000Z',
  ...extra,
});

function serve(notes: Note[]) {
  const posted: unknown[] = [];
  const deleted: string[] = [];
  server.use(
    http.get(api(`cases/${ID}`), () => ok(FILE)),
    http.get(api(`cases/${ID}/notes`), () => ok(notes)),
    http.post(api(`cases/${ID}/notes`), async ({ request }) => {
      posted.push(await request.json());
      return ok(note(9), 201);
    }),
    http.delete(api(`cases/${ID}/notes/:noteId`), ({ params }) => {
      deleted.push(String(params.noteId));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { posted, deleted };
}

async function openNotes(locale: 'en' | 'ar' = 'en') {
  setViewport(1280);
  signedIn({
    id: USER.id,
    role: 'OFFICE_MANAGER',
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor('OFFICE_MANAGER')],
  });
  renderApp(`/cases/${ID}?tab=notes`, locale);
  return screen.findByTestId('notes-tab', {}, { timeout: COLD });
}

describe('Notes tab (D-154)', () => {
  it(
    'should show notes as plain text, add one and delete one after a confirm',
    async () => {
      const calls = serve([
        note(1, { pinned: true, body: XSS }),
        note(2, { isConfidential: true, canEdit: false }),
      ]);
      const tab = await openNotes();
      // The payload is text, never markup.
      expect(within(tab).getByText(XSS)).toBeTruthy();
      expect(tab.querySelector('img')).toBeNull();
      expect(within(tab).getByText('Pinned')).toBeTruthy();
      expect(
        within(screen.getByTestId(`note-${note(2).id}`)).getByText('Confidential'),
      ).toBeTruthy();
      expect(screen.queryByTestId(`note-delete-${note(2).id}`)).toBeNull();
      fireEvent.change(screen.getByTestId('note-body'), { target: { value: 'Call the client' } });
      fireEvent.click(screen.getByTestId('note-confidential'));
      fireEvent.click(screen.getByTestId('note-add'));
      await waitFor(() =>
        expect(calls.posted).toEqual([
          { body: 'Call the client', isConfidential: true, pinned: false },
        ]),
      );
      fireEvent.click(screen.getByTestId(`note-delete-${note(1).id}`));
      fireEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
      );
      await waitFor(() => expect(calls.deleted).toEqual([note(1).id]));
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should have no accessibility violations (%s)',
    async (locale) => {
      serve([note(1, { pinned: true })]);
      const tab = await openNotes(locale);
      if (locale === 'ar') expect(within(tab).getByText('مثبتة')).toBeTruthy();
      const results = await axe.run(tab, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );
});
