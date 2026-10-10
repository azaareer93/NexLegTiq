import type { CaseListItem } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { activeView, CONTRACT_TYPES, readQuery, withChanges, withView } from './list-params';
import {
  api,
  fail,
  http,
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

const row = (n: number, extra: Partial<CaseListItem> = {}): CaseListItem => ({
  id: `01920000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`,
  fileNumber: `2026-LIT-${String(n).padStart(5, '0')}`,
  title: `Land dispute ${n}`,
  fileType: 'LITIGATION',
  status: 'OPEN',
  priority: 'HIGH',
  openingDate: '2026-10-01',
  isConfidential: false,
  primaryClient: { id: '01920000-0000-7000-8000-0000000000c1', displayName: 'Omar Khalil' },
  responsibleLawyer: { id: '01920000-0000-7000-8000-000000000001', fullName: 'Layla Haddad' },
  updatedAt: '2026-10-05T09:00:00.000Z',
  ...extra,
});

/** Answers `GET /cases` with `rows` and records every query string the page sends. */
function serveCases(rows: CaseListItem[], total = rows.length): URLSearchParams[] {
  const queries: URLSearchParams[] = [];
  server.use(
    http.get(api('cases'), ({ request }) => {
      const query = new URL(request.url).searchParams;
      queries.push(query);
      const page = Number(query.get('page') ?? 1);
      const limit = Number(query.get('limit') ?? 20);
      const pagination = {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      };
      return HttpResponse.json({ success: true, data: rows, meta: { ...meta, pagination } });
    }),
  );
  return queries;
}

const lastQuery = (queries: URLSearchParams[]) =>
  Object.fromEntries(queries.at(-1)?.entries() ?? []);
const table = () => screen.findByTestId('cases-table', {}, { timeout: COLD });

describe('list parameters', () => {
  it('should keep only the parameters the contract accepts', () => {
    expect(
      readQuery(
        new URLSearchParams(
          'status=OPEN&fileType=LITIGATION,PIZZA&priority=URGENT&sort=passwordHash&page=2&limit=500&x=1&search=%20land',
        ),
      ),
    ).toEqual({ status: 'OPEN', priority: 'URGENT', page: '2', search: ' land' });
  });

  it('should recognise the views and replace the filters with a view', () => {
    const contracts = withView(
      new URLSearchParams('status=OPEN&search=x&sort=title:asc&page=3'),
      'contracts',
    );
    expect(Object.fromEntries(contracts)).toEqual({
      search: 'x',
      sort: 'title:asc',
      fileType: CONTRACT_TYPES.join(','),
    });
    expect(activeView(readQuery(contracts))).toBe('contracts');
    expect(activeView(readQuery(new URLSearchParams('scope=all&search=x')))).toBe('all');
    expect(
      activeView(readQuery(new URLSearchParams('priority=URGENT&status=OPEN'))),
    ).toBeUndefined();
  });

  it('should go back to page 1 when a filter changes, but not when the page does', () => {
    const params = new URLSearchParams('page=3&status=OPEN');
    expect(withChanges(params, { status: 'CLOSED' }).get('page')).toBeNull();
    expect(withChanges(params, { page: '4' }).get('page')).toBe('4');
    expect(withChanges(params, { status: undefined }).has('status')).toBe(false);
  });
});

describe('cases list page', () => {
  it(
    'should show the rows with their tags and open a file from its row',
    async () => {
      setViewport(1280);
      signedIn();
      serveCases(
        [row(1), row(2, { isConfidential: true, primaryClient: null, priority: 'URGENT' })],
        2,
      );
      const { router } = renderApp('/cases');
      const grid = await table();
      expect(within(grid).getByText('2026-LIT-00001').closest('[dir="ltr"]')).toBeTruthy();
      expect(within(grid).getByText('Land dispute 2')).toBeTruthy();
      expect(within(grid).getByText('Confidential')).toBeTruthy();
      expect(within(grid).getAllByText('Open')).toHaveLength(2);
      expect(within(grid).getByText('Urgent')).toBeTruthy();
      expect(screen.getByText('2 cases')).toBeTruthy();
      fireEvent.click(within(grid).getByText('Omar Khalil'));
      await waitFor(() => expect(router.state.location.pathname).toBe(`/cases/${row(1).id}`));
    },
    SLOW,
  );

  it(
    'should map the views, search, filters, sort and page to the query and the URL',
    async () => {
      setViewport(1280);
      signedIn();
      const queries = serveCases([row(1)], 45);
      const { router } = renderApp('/cases?status=OPEN&page=2');
      await table();
      expect(lastQuery(queries)).toEqual({ status: 'OPEN', page: '2' });

      fireEvent.click(screen.getByTestId('cases-view-contracts'));
      await waitFor(() =>
        expect(lastQuery(queries)).toEqual({ fileType: CONTRACT_TYPES.join(',') }),
      );
      expect(screen.getByTestId('cases-view-contracts').getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByTestId('cases-view-all').getAttribute('aria-pressed')).toBe('false');

      fireEvent.click(screen.getByTestId('cases-view-mine'));
      await waitFor(() => expect(lastQuery(queries)).toEqual({ scope: 'mine' }));

      const search = within(screen.getByTestId('cases-search')).getByRole('searchbox');
      fireEvent.change(search, { target: { value: ' القدس ' } });
      fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' });
      await waitFor(() => expect(lastQuery(queries)).toEqual({ scope: 'mine', search: 'القدس' }));

      fireEvent.click(within(await table()).getByRole('columnheader', { name: /^Title/ }));
      await waitFor(() => expect(lastQuery(queries)['sort']).toBe('title:asc'));

      fireEvent.click(await screen.findByTitle('3'));
      await waitFor(() => expect(lastQuery(queries)['page']).toBe('3'));
      expect(router.state.location.search).toContain('page=3');
      expect(router.state.location.search).toContain('sort=title%3Aasc');
    },
    SLOW,
  );

  it(
    'should show a removable tag for a client filter from the URL',
    async () => {
      setViewport(1280);
      signedIn();
      const queries = serveCases([row(1)]);
      renderApp(`/cases?clientId=${row(1).primaryClient?.id ?? ''}`);
      await table();
      expect(lastQuery(queries)['clientId']).toBe(row(1).primaryClient?.id);
      const tag = screen.getByText('Filtered by client').closest('.ant-tag') as HTMLElement;
      fireEvent.click(within(tag).getByRole('button'));
      await waitFor(() => expect(lastQuery(queries)).toEqual({}));
    },
    SLOW,
  );

  it(
    'should explain an empty office, and an empty search with a way back',
    async () => {
      setViewport(1280);
      signedIn();
      serveCases([]);
      const { router } = renderApp('/cases');
      expect(await screen.findByText('No cases yet', {}, { timeout: COLD })).toBeTruthy();
      router.navigate('/cases?priority=URGENT').catch(() => undefined);
      expect(await screen.findByText('No matching cases')).toBeTruthy();
      fireEvent.click(screen.getByTestId('cases-clear'));
      expect(await screen.findByText('No cases yet')).toBeTruthy();
      expect(router.state.location.search).toBe('');
    },
    SLOW,
  );

  it(
    'should go to the last page when the address asks for a page past the end',
    async () => {
      setViewport(1280);
      signedIn();
      const queries = serveCases([], 45);
      const { router } = renderApp('/cases?page=9');
      await waitFor(() => expect(lastQuery(queries)['page']).toBe('3'), { timeout: COLD });
      expect(router.state.location.search).toBe('?page=3');
    },
    SLOW,
  );

  it(
    'should show the error with a retry that loads the list',
    async () => {
      setViewport(1280);
      signedIn();
      server.use(http.get(api('cases'), () => fail(500, 'SYS-001')));
      renderApp('/cases');
      const error = await screen.findByTestId('cases-error', {}, { timeout: COLD });
      expect(within(error).getByText('req-12345678')).toBeTruthy();
      serveCases([row(1)]);
      fireEvent.click(within(error).getByRole('button'));
      expect(await table()).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should offer "new case" only to who may create one',
    async () => {
      setViewport(1280);
      signedIn({ role: 'TRAINEE', permissions: [...permissionsFor('TRAINEE')] });
      serveCases([row(1)]);
      renderApp('/cases');
      await table();
      expect(screen.queryByTestId('cases-new')).toBeNull();
    },
    SLOW,
  );

  it(
    'should show cards on a phone, in Arabic',
    async () => {
      setViewport(390);
      signedIn({ uiLanguage: 'AR' });
      serveCases([row(1)], 3);
      renderApp('/cases', 'ar');
      const cards = await screen.findByTestId('cases-cards', {}, { timeout: COLD });
      expect(within(cards).getByText('2026-LIT-00001')).toBeTruthy();
      expect(within(cards).getByText('مفتوح')).toBeTruthy();
      expect(screen.getByText('3 ملفات')).toBeTruthy();
      expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    },
    SLOW,
  );

  it.each([
    ['ar', 1280],
    ['en', 390],
  ] as const)(
    'should be accessible in %s at %i px',
    async (locale, width) => {
      setViewport(width);
      signedIn({ uiLanguage: locale === 'ar' ? 'AR' : 'EN' });
      serveCases([row(1), row(2, { isConfidential: true })]);
      renderApp('/cases', locale);
      await screen.findByTestId(width < 768 ? 'cases-cards' : 'cases-table', {}, { timeout: COLD });
      // The page only: the shell around it has its own check, and axe over the whole app is slow in jsdom.
      const { violations } = await axe.run(screen.getByTestId('page-cases'), {
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
