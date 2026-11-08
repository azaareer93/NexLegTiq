import type { Notification } from '@nexlegtiq/shared-contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';

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

/** The notifications shown in a list (one title link each; action buttons are list items too). */
const shown = (list: HTMLElement) => list.querySelectorAll('[data-testid^="notification-open-"]');

const COLD = 20_000;
const SLOW = 60_000;

const note = (n: number, extra: Partial<Notification> = {}): Notification => ({
  id: `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  type: 'DOCUMENT_PROCESSED',
  titleKey: 'shell.notifications.documentProcessed',
  params: { name: `claim-${n}.pdf` },
  link: '/cases/01920000-0000-7000-8000-0000000000f1?tab=documents',
  readAt: null,
  createdAt: new Date(Date.now() - n * 60_000).toISOString(),
  ...extra,
});

function serve(items: Notification[], unread = items.filter((i) => !i.readAt).length) {
  const calls: string[] = [];
  server.use(
    http.get(api('notifications/unread-count'), () => ok({ count: unread })),
    http.get(api('notifications'), ({ request }) => {
      const query = new URL(request.url).searchParams;
      calls.push(query.toString());
      const cursor = query.get('cursor');
      const limit = Number(query.get('limit') ?? 20);
      const pool = query.get('unread') === 'true' ? items.filter((i) => !i.readAt) : items;
      const start = cursor ? pool.findIndex((i) => i.id === cursor) + 1 : 0;
      const page = pool.slice(start, start + limit);
      const nextCursor = start + limit < pool.length ? (page.at(-1)?.id ?? null) : null;
      return ok({ items: page, nextCursor });
    }),
    http.post(api('notifications/read-all'), () => {
      calls.push('read-all');
      return ok({ count: unread });
    }),
    http.post(`${api('notifications')}/:id/read`, ({ params }) => {
      calls.push(`read ${String(params.id)}`);
      return ok({ ...note(0), id: String(params.id), readAt: new Date().toISOString() });
    }),
  );
  return calls;
}

describe('notifications (D-149)', () => {
  it(
    'should show the unread count on the bell and the latest ten in its panel, read in the reader language',
    async () => {
      setViewport(1280);
      const calls = serve(Array.from({ length: 12 }, (_, i) => note(i + 1)));
      signedIn();
      renderApp('/');
      const bell = await screen.findByTestId('notifications', {}, { timeout: COLD });
      await waitFor(() => expect(bell.getAttribute('aria-label')).toBe('Notifications, 12 unread'));
      fireEvent.click(bell);
      const list = await screen.findByTestId('notifications-bell-list');
      expect(shown(list)).toHaveLength(10);
      expect(within(list).getByText('The text of ⁨claim-1.pdf⁩ is ready')).toBeTruthy();
      expect(calls[0]).toContain('limit=10');
      fireEvent.click(screen.getByTestId('notifications-bell-read-all'));
      await waitFor(() => expect(calls).toContain('read-all'));
    },
    SLOW,
  );

  it(
    'should mark a notification read when opened and follow its link',
    async () => {
      setViewport(1280);
      const first = note(1);
      const calls = serve([first]);
      signedIn();
      const { router } = renderApp('/');
      fireEvent.click(await screen.findByTestId('notifications', {}, { timeout: COLD }));
      fireEvent.click(await screen.findByTestId(`notification-open-${first.id}`));
      await waitFor(() => expect(calls).toContain(`read ${first.id}`));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe('/cases/01920000-0000-7000-8000-0000000000f1'),
      );
    },
    SLOW,
  );

  it(
    'should list every notification on the page, page by page, and filter the unread ones',
    async () => {
      setViewport(1280);
      const items = Array.from({ length: 25 }, (_, i) =>
        note(i + 1, i % 2 ? { readAt: new Date().toISOString() } : {}),
      );
      serve(items);
      signedIn();
      renderApp('/notifications');
      const list = await screen.findByTestId('notifications-page-list', {}, { timeout: COLD });
      expect(shown(list)).toHaveLength(20);
      fireEvent.click(screen.getByTestId('notifications-more'));
      await waitFor(() =>
        expect(shown(screen.getByTestId('notifications-page-list'))).toHaveLength(25),
      );
      expect(screen.queryByTestId('notifications-more')).toBeNull();
      fireEvent.click(within(screen.getByTestId('notifications-filter')).getByText('Unread'));
      await waitFor(() =>
        expect(shown(screen.getByTestId('notifications-page-list'))).toHaveLength(13),
      );
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should have no accessibility violations on the page (%s)',
    async (locale) => {
      setViewport(1280);
      serve([note(1), note(2, { readAt: new Date().toISOString() })]);
      signedIn(locale === 'ar' ? { uiLanguage: 'AR' } : {});
      renderApp('/notifications', locale);
      await screen.findByTestId('notifications-page-list', {}, { timeout: COLD });
      if (locale === 'ar') {
        expect(document.documentElement.dir).toBe('rtl');
        expect(screen.getByText('أصبح نص المستند ⁨claim-1.pdf⁩ جاهزًا')).toBeTruthy();
      }
      const results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );
});
