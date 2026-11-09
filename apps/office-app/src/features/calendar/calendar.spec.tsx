import 'dayjs/locale/ar';

import type { SessionListItem, Task } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import { wallClock } from '@nexlegtiq/shared-utils';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import dayjs from 'dayjs';
import { HttpResponse } from 'msw';

import { rangeOf } from './CalendarPage';
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
} from '../../test/render-app';

setupTestServer();

const COLD = 20_000;
const SLOW = 60_000;
const FILE = {
  id: '01920000-0000-7000-8000-0000000001f1',
  fileNumber: '2026-LIT-00007',
  title: 'Land dispute',
};
const ME = { id: USER.id, fullName: USER.fullName };
const today = wallClock(new Date(), 'Asia/Hebron').date;

const hearing: SessionListItem = {
  id: '01920000-0000-7000-8000-0000000000e1',
  file: FILE,
  sessionType: 'HEARING',
  status: 'SCHEDULED',
  startsAt: `${today}T08:00:00.000Z`,
  endsAt: null,
  court: null,
  judge: null,
  courtRoom: null,
  attendingLawyer: ME,
  reminderDays: [],
  outcome: null,
  nextSessionId: null,
  previousSessionId: null,
  cancellationReason: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

const task: Task = {
  id: '01920000-0000-7000-8000-00000000a001',
  title: 'File the appeal',
  description: null,
  file: FILE,
  dueDate: today,
  priority: 'MEDIUM',
  status: 'TODO',
  assignedTo: ME,
  createdBy: ME,
  completedAt: null,
  sortOrder: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

function serve() {
  const sessions: URLSearchParams[] = [];
  const tasks: URLSearchParams[] = [];
  server.use(
    http.get(api('sessions'), ({ request }) => {
      sessions.push(new URL(request.url).searchParams);
      return ok([hearing]);
    }),
    http.get(api('tasks'), ({ request }) => {
      tasks.push(new URL(request.url).searchParams);
      return HttpResponse.json({
        success: true,
        data: [task],
        meta: {
          timestamp: '2026-11-09T10:00:00.000Z',
          requestId: 'req-12345678',
          pagination: { page: 1, limit: 100, total: 1, totalPages: 1, hasMore: false },
        },
      });
    }),
    http.get(api('users/directory'), () =>
      ok([{ id: USER.id, fullName: 'Layla', role: 'OFFICE_MANAGER' }]),
    ),
  );
  return { sessions, tasks };
}

async function openCalendar(role: Role, width = 1280, locale: 'en' | 'ar' = 'en') {
  setViewport(width);
  signedIn({
    role,
    uiLanguage: locale === 'ar' ? 'AR' : 'EN',
    permissions: [...permissionsFor(role)],
  });
  renderApp('/calendar', locale);
  return screen.findByTestId('page-calendar', {}, { timeout: COLD });
}

describe('calendar ranges (D-155)', () => {
  it('should start weeks on Saturday in Arabic and on Sunday in English', () => {
    const day = dayjs('2026-11-11');
    expect(rangeOf('week', day.locale('ar'))).toEqual({ first: '2026-11-07', last: '2026-11-13' });
    expect(rangeOf('week', day.locale('en'))).toEqual({ first: '2026-11-08', last: '2026-11-14' });
    // Six weeks, as the month grid shows them (November 2026 needs only five).
    expect(rangeOf('month', day.locale('en'))).toEqual({ first: '2026-11-01', last: '2026-12-12' });
    expect(rangeOf('agenda', day)).toEqual({ first: '2026-11-11', last: '2026-12-10' });
  });
});

describe('Calendar page (D-155)', () => {
  it(
    'should show hearings and due tasks of the month, query each view’s range and open a task',
    async () => {
      const calls = serve();
      await openCalendar('OFFICE_MANAGER');
      expect(await screen.findByTestId(`calendar-hearing-${hearing.id}`)).toBeTruthy();
      expect(screen.getByTestId(`calendar-task-${task.id}`)).toBeTruthy();
      expect(screen.getByTestId('calendar-lawyer')).toBeTruthy();
      const month = calls.tasks.at(-1);
      expect(month?.get('dueFrom')).toBe(rangeOf('month', dayjs(today)).first);
      expect(calls.sessions.at(-1)?.get('from')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      fireEvent.click(within(screen.getByTestId('calendar-view')).getByText('Week'));
      await waitFor(() =>
        expect(calls.tasks.at(-1)?.get('dueFrom')).toBe(rangeOf('week', dayjs(today)).first),
      );
      fireEvent.click(screen.getByTestId(`calendar-task-${task.id}`));
      expect(await screen.findByTestId('task-drawer')).toBeTruthy();
    },
    SLOW,
  );

  it(
    'should start on the agenda on a phone and offer no lawyer filter to a lawyer',
    async () => {
      const calls = serve();
      await openCalendar('LAWYER', 360);
      expect(await screen.findByTestId(`calendar-day-${today}`)).toBeTruthy();
      expect(screen.queryByTestId('calendar-lawyer')).toBeNull();
      expect(calls.tasks.at(-1)?.get('dueBefore')).toBe(rangeOf('agenda', dayjs(today)).last);
    },
    SLOW,
  );

  it.each(['en', 'ar'] as const)(
    'should have no accessibility violations (%s)',
    async (locale) => {
      serve();
      const page = await openCalendar('OFFICE_MANAGER', 1280, locale);
      await screen.findByTestId(`calendar-hearing-${hearing.id}`);
      if (locale === 'ar') expect(document.documentElement.dir).toBe('rtl');
      const results = await axe.run(page, {
        rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
    },
    SLOW,
  );
});
