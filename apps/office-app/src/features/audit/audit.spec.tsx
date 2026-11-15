import type { AuditEntry } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
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
} from '../../test/render-app';

setupTestServer();
const COLD = 20_000;
const SLOW = 60_000;
const USER_ID = '01920000-0000-7000-8000-0000000000a1';

const entry = (n: number, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  occurredAt: '2026-11-11T08:00:00.000Z',
  actor: { type: 'USER', id: USER_ID, name: 'Omar Lawyer' },
  action: 'UPDATE',
  entityType: 'Task',
  entityId: null,
  changes: [{ field: 'title', old: 'A', new: 'B' }],
  ...extra,
});

function serve(pages: AuditEntry[][]) {
  const seen: string[] = [];
  let exported = '';
  server.use(
    http.get(api('audit'), ({ request }) => {
      const url = new URL(request.url);
      seen.push(url.search);
      const page = url.searchParams.get('cursor') ? 1 : 0;
      return ok({
        items: pages[page] ?? [],
        nextCursor: page === 0 && pages.length > 1 ? (pages[0]?.at(-1)?.id ?? null) : null,
      });
    }),
    http.get(api('audit/export'), ({ request }) => {
      exported = new URL(request.url).search;
      return new HttpResponse('"occurredAt"\r\n', { headers: { 'content-type': 'text/csv' } });
    }),
    http.get(api('users/directory'), () =>
      ok([{ id: USER_ID, fullName: 'Omar Lawyer', role: 'LAWYER' }]),
    ),
  );
  return { seen, exported: () => exported };
}

function open(path: string, role: Role = 'OFFICE_MANAGER', locale: 'en' | 'ar' = 'en') {
  setViewport(1280);
  signedIn({
    role,
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor(role)],
  });
  renderApp(path, locale);
}

describe('audit log page (MVP-105)', () => {
  it(
    'should list entries in words, page by cursor, and write filters into the query',
    { timeout: SLOW },
    async () => {
      const calls = serve([
        [entry(1), entry(2, { action: 'DELETE', actor: { type: 'SYSTEM', id: null, name: null } })],
        [entry(3)],
      ]);
      open('/settings/audit');
      const table = await screen.findByTestId('audit-table', {}, { timeout: COLD });
      await waitFor(() => expect(table.textContent).toContain('Omar Lawyer'));
      expect(table.textContent).toContain('Updated');
      expect(table.textContent).toContain('Deleted');
      expect(table.textContent).toContain('System');
      expect(table.textContent).toContain('Task');
      expect(table.textContent).toContain('title');
      fireEvent.click(screen.getByTestId('audit-more'));
      await waitFor(() => expect(calls.seen.some((s) => s.includes('cursor='))).toBe(true));
      fireEvent.mouseDown(within(screen.getByTestId('audit-filter-action')).getByRole('combobox'));
      fireEvent.click(await screen.findByTitle('Signed in'));
      await waitFor(() => expect(calls.seen.at(-1)).toContain('action=LOGIN'));
    },
  );

  it('should export the filtered log as a CSV download', { timeout: SLOW }, async () => {
    const calls = serve([[entry(1)]]);
    const clicks: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });
    URL.createObjectURL = vi.fn(() => 'blob:audit');
    URL.revokeObjectURL = vi.fn();
    open('/settings/audit?action=EXPORT');
    fireEvent.click(await screen.findByTestId('audit-export', {}, { timeout: COLD }));
    await waitFor(() => expect(clicks).toEqual(['audit-log.csv']));
    expect(calls.exported()).toContain('action=EXPORT');
    expect(calls.exported()).toContain('format=csv');
    click.mockRestore();
  });

  it('should refuse a lawyer', { timeout: SLOW }, async () => {
    serve([[entry(1)]]);
    open('/settings/audit', 'LAWYER');
    expect(await screen.findByTestId('page-forbidden', {}, { timeout: COLD })).toBeTruthy();
  });

  it('should be accessible in Arabic for an Admin', { timeout: SLOW }, async () => {
    serve([[entry(1)]]);
    open('/settings/audit', 'ADMIN', 'ar');
    const table = await screen.findByTestId('audit-table', {}, { timeout: COLD });
    await waitFor(() => expect(table.textContent).toContain('تعديل'));
    expect(document.documentElement.dir).toBe('rtl');
    const { violations } = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(violations.map((v) => v.id)).toEqual([]);
  });
});
