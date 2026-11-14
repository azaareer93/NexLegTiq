import type { SearchResults } from '@nexlegtiq/shared-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';

import { useRecentSearches } from './use-search';
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

const COLD = 20_000;
const SLOW = 60_000;
const id = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FILE = { id: id(1), fileNumber: '2026-LIT-00001', title: 'Haddad v. Nour' };
const EMPTY = { items: [], hasMore: false };

const RESULTS: SearchResults = {
  cases: { items: [{ ...FILE, status: 'OPEN' }], hasMore: false },
  clients: {
    items: [{ id: id(2), displayName: 'Omar Haddad', clientType: 'INDIVIDUAL' }],
    hasMore: false,
  },
  parties: { items: [{ id: id(3), name: 'Nour Trading', isIndividual: false }], hasMore: false },
  documents: {
    items: [
      {
        id: id(4),
        name: 'claim.pdf',
        file: FILE,
        snippet: [
          { text: 'the ', match: false },
          { text: 'claim', match: true },
          { text: ' was filed', match: false },
        ],
      },
    ],
    hasMore: true,
  },
  tasks: {
    items: [{ id: id(5), title: 'Draft the claim', status: 'TODO', dueDate: null, file: null }],
    hasMore: false,
  },
};

function serve(results: SearchResults = RESULTS) {
  const calls: URLSearchParams[] = [];
  server.use(
    http.get(api('search'), ({ request }) => {
      calls.push(new URL(request.url).searchParams);
      return ok(results);
    }),
  );
  return calls;
}

async function openSearch() {
  await screen.findByTestId('page-dashboard', {}, { timeout: COLD });
  fireEvent.click(screen.getByTestId('search-open'));
  return screen.findByTestId('search-input');
}

const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

beforeEach(() => {
  setViewport(1280);
  useRecentSearches.setState({ userId: null, queries: [] });
});

describe('search overlay (D-172)', () => {
  it(
    'should search once after typing stops, group the results and open one with the arrow keys and Enter',
    async () => {
      const calls = serve();
      signedIn();
      const { router } = renderApp('/');
      const input = await openSearch();
      type(input, 'c');
      expect(screen.getByText('Type at least 2 characters to search.')).toBeTruthy();
      type(input, 'cl');
      type(input, 'claim');
      const list = await screen.findByTestId('search-option-cases-' + FILE.id);
      expect(calls.map((c) => c.get('q'))).toEqual(['claim']);
      expect(calls[0]?.get('limit')).toBe('5');

      const results = screen.getByTestId('search-results');
      const titles = within(results)
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label'));
      expect(titles).toEqual(['Cases', 'Clients', 'Documents', 'Tasks']);
      expect(within(results).queryByText('Nour Trading')).toBeNull();
      expect(list.querySelector('[dir="ltr"]')?.textContent).toBe('2026-LIT-00001');
      expect(within(results).getByText('claim', { selector: 'mark' })).toBeTruthy();
      expect(within(results).getByText('Personal task')).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByTestId('search-status').textContent).toBe('4 results'),
      );

      expect(input.getAttribute('aria-activedescendant')).toContain('cases-');
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(input.getAttribute('aria-activedescendant')).toContain('clients-');
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(input.getAttribute('aria-activedescendant')).toContain('tasks-');
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
      await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull());

      fireEvent.click(screen.getByTestId('search-open'));
      const again = await screen.findByTestId('search-input');
      const recent = await screen.findByTestId('search-option-recent-claim');
      fireEvent.click(recent);
      expect((again as HTMLInputElement).value).toBe('claim');
    },
    SLOW,
  );

  it(
    'should show every match of one type from "see all", and go back to all results',
    async () => {
      const calls = serve();
      signedIn();
      renderApp('/');
      type(await openSearch(), 'claim');
      fireEvent.click(await screen.findByTestId('search-option-more-documents'));
      await waitFor(() => expect(calls.at(-1)?.get('type')).toBe('documents'));
      expect(calls.at(-1)?.get('limit')).toBe('20');
      fireEvent.click(await screen.findByTestId('search-option-back'));
      await waitFor(() => expect(calls.at(-1)?.get('type')).toBeNull());

      fireEvent.click(await screen.findByTestId('search-option-more-documents'));
      await screen.findByTestId('search-option-back');
      const before = calls.length;
      type(screen.getByTestId('search-input'), 'claims');
      await waitFor(() => expect(calls.at(-1)?.get('q')).toBe('claims'));
      expect(calls.slice(before).map((c) => c.get('type'))).not.toContain('documents');
    },
    SLOW,
  );

  it(
    'should not open a result of the previous query while typing, and show a failed search',
    async () => {
      serve();
      signedIn();
      const { router } = renderApp('/');
      const input = await openSearch();
      type(input, 'claim');
      await screen.findByTestId('search-option-cases-' + FILE.id);
      type(input, 'claim form');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(router.state.location.pathname).toBe('/');

      server.use(http.get(api('search'), () => fail(500, 'SYS-001')));
      type(input, 'contract');
      expect(await screen.findByTestId('search-error', {}, { timeout: 5000 })).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should pass axe with results shown',
    async () => {
      serve();
      signedIn();
      renderApp('/');
      type(await openSearch(), 'claim');
      await screen.findByTestId('search-option-more-documents');
      const results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );

  it(
    'should keep recent searches to the user who made them',
    async () => {
      useRecentSearches.setState({ userId: id(99), queries: ['someone else'] });
      serve();
      signedIn();
      renderApp('/');
      await openSearch();
      expect(screen.queryByTestId('search-option-recent-someone else')).toBeNull();
    },
    SLOW,
  );

  it(
    'should search in Arabic, right to left, say when nothing matches and pass axe',
    async () => {
      const calls = serve({
        cases: EMPTY,
        clients: EMPTY,
        parties: EMPTY,
        documents: EMPTY,
        tasks: EMPTY,
      });
      signedIn({ uiLanguage: 'AR' });
      renderApp('/', 'ar');
      const input = await openSearch();
      expect(document.documentElement.dir).toBe('rtl');
      type(input, 'عقد Haddad');
      await waitFor(() => expect(calls[0]?.get('q')).toBe('عقد Haddad'));
      await waitFor(() =>
        expect(screen.getByTestId('search-status').textContent).toBe(
          'لا توجد نتائج لعبارة «⁨عقد Haddad⁩».',
        ),
      );
      const results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );
});
