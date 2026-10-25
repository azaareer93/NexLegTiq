import type { Case, Task } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Role, TaskStatus } from '@nexlegtiq/shared-types';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { HttpResponse } from 'msw';

import { isOverdue, planMove } from './board';
import type { Columns } from './board';
import { createRequest, updateRequest } from './components/TaskDrawer';
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
const COLD = 20_000;

const FILE_ID = '01920000-0000-7000-8000-0000000001f1';
const T1 = '01920000-0000-7000-8000-00000000a001';
const T2 = '01920000-0000-7000-8000-00000000a002';
const T3 = '01920000-0000-7000-8000-00000000a003';
const ME = { id: USER.id, fullName: USER.fullName };

const task = (id: string, status: TaskStatus, extra: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id.slice(-1)}`,
  description: null,
  file: { id: FILE_ID, fileNumber: '2026-LIT-00007', title: 'Land dispute' },
  dueDate: null,
  priority: 'MEDIUM',
  status,
  assignedTo: ME,
  createdBy: ME,
  completedAt: null,
  sortOrder: 0,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...extra,
});

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
  responsibleLawyer: ME,
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
  team: [{ ...ME, role: 'RESPONSIBLE_LAWYER' }],
  counts: { parties: 0, notes: 0 },
  createdAt: '2026-10-01T09:00:00.000Z',
};

const page = (items: Task[]) =>
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
  signedIn({ role, uiLanguage, permissions: [...permissionsFor(role)] });

interface Calls {
  lists: URLSearchParams[];
  writes: { method: string; path: string; body: unknown }[];
}

/** A tiny task store: lists filter by status; a status change moves the task unless `refuseMoves`. */
function serve({ refuseMoves = false, refuseReorder = false } = {}): Calls {
  const calls: Calls = { lists: [], writes: [] };
  const store = [
    task(T1, 'TODO', { dueDate: '2020-01-01', priority: 'URGENT' }),
    task(T2, 'TODO', { sortOrder: 1 }),
    task(T3, 'IN_PROGRESS'),
  ];
  const record = async (method: string, request: Request) => {
    const text = await request.text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    calls.writes.push({ method, path: new URL(request.url).pathname, body });
    return body;
  };
  server.use(
    http.get(api(`cases/${FILE_ID}`), () => ok(FILE)),
    http.get(api('users/directory'), () => ok([{ ...ME, role: 'OFFICE_MANAGER' }])),
    http.get(api('tasks'), ({ request }) => {
      const params = new URL(request.url).searchParams;
      calls.lists.push(params);
      const status = params.get('status');
      return page(store.filter((item) => !status || item.status === status));
    }),
    http.patch(api('tasks/reorder'), async ({ request }) => {
      await record('REORDER', request);
      return refuseReorder ? fail(422, 'BIZ-007') : new HttpResponse(null, { status: 204 });
    }),
    http.patch(api(`tasks/:id/status`), async ({ request, params }) => {
      const body = (await record('STATUS', request)) as { status: TaskStatus };
      if (refuseMoves) return fail(403, 'AUTH-100');
      const moved = store.find((item) => item.id === params['id']);
      if (moved) moved.status = body.status;
      return ok(moved);
    }),
    http.post(api('tasks'), async ({ request }) => {
      await record('POST', request);
      return ok(task(T3, 'TODO'), 201);
    }),
    http.patch(api(`tasks/${T2}`), async ({ request }) => {
      await record('PATCH', request);
      return ok(task(T2, 'TODO'));
    }),
  );
  return calls;
}

const column = (status: TaskStatus) => screen.getByTestId(`task-column-${status}`);

const openFileTab = async () => {
  setViewport(1280);
  renderApp(`/cases/${FILE_ID}?tab=tasks`);
  await screen.findByTestId(`task-card-${T1}`, {}, { timeout: COLD });
};

const moveVia = async (id: string, to: TaskStatus) => {
  fireEvent.click(screen.getByTestId(`task-menu-${id}`));
  fireEvent.click(await screen.findByTestId(`task-move-${id}-${to}`));
};

const openMyTasks = async (locale: 'en' | 'ar' = 'en') => {
  setViewport(1280);
  renderApp('/tasks', locale);
  await screen.findByTestId(`task-card-${T1}`, {}, { timeout: COLD });
};

describe('board moves (D-012)', () => {
  const columns: Columns = {
    TODO: [task(T1, 'TODO'), task(T2, 'TODO')],
    IN_PROGRESS: [task(T3, 'IN_PROGRESS')],
    BLOCKED: [],
    DONE: [],
  };

  it('should place a card before the card it is dropped on, or at the end of a column', () => {
    expect(planMove(columns, T1, T3)).toMatchObject({ to: 'IN_PROGRESS', order: [T1, T3] });
    expect(planMove(columns, T1, 'column-BLOCKED')).toMatchObject({ to: 'BLOCKED', order: [T1] });
    expect(planMove(columns, T3, 'column-TODO')).toMatchObject({ to: 'TODO', order: [T1, T2, T3] });
  });

  it('should reorder within a column, and ignore a drop that changes nothing or unknown ids', () => {
    expect(planMove(columns, T1, T2)).toMatchObject({ to: 'TODO', order: [T2, T1] });
    expect(planMove(columns, T2, T1)).toMatchObject({ to: 'TODO', order: [T2, T1] });
    expect(planMove(columns, T1, T1)).toBeNull();
    expect(planMove(columns, T1, 'column-TODO')).toMatchObject({ order: [T2, T1] });
    expect(planMove(columns, 'nope', T1)).toBeNull();
    expect(planMove(columns, T1, 'nowhere')).toBeNull();
  });

  it('should call open tasks due before today overdue, never done ones', () => {
    expect(isOverdue({ dueDate: '2026-10-23', status: 'TODO' }, '2026-10-24')).toBe(true);
    expect(isOverdue({ dueDate: '2026-10-24', status: 'TODO' }, '2026-10-24')).toBe(false);
    expect(isOverdue({ dueDate: '2026-10-01', status: 'DONE' }, '2026-10-24')).toBe(false);
    expect(isOverdue({ dueDate: null, status: 'TODO' }, '2026-10-24')).toBe(false);
  });

  it('should send only what a form holds or changed', () => {
    const values = {
      title: ' Call court ',
      priority: 'HIGH' as const,
      description: '',
      dueDate: null,
    };
    expect(createRequest({ ...values, assignedToId: USER.id }, FILE_ID, USER.id)).toEqual({
      title: 'Call court',
      priority: 'HIGH',
      fileId: FILE_ID,
    });
    expect(createRequest({ ...values, assignedToId: 'other' }, null, USER.id)).toMatchObject({
      assignedToId: 'other',
    });
    const before = task(T2, 'TODO', { description: 'Old' });
    expect(updateRequest(before, { ...values, title: 'Task 2', priority: 'MEDIUM' })).toEqual({
      description: null,
    });
  });
});

describe('tasks board and list (MVP-77)', () => {
  it(
    'should show my tasks in their columns with the overdue warning',
    async () => {
      asRole('LAWYER');
      const calls = serve();
      await openMyTasks();
      expect(within(column('TODO')).getByTestId(`task-card-${T1}`)).toBeTruthy();
      expect(within(column('IN_PROGRESS')).getByTestId(`task-card-${T3}`)).toBeTruthy();
      expect(screen.getByTestId(`overdue-${T1}`).textContent).toContain('Overdue');
      expect(screen.queryByTestId(`overdue-${T2}`)).toBeNull();
      expect(calls.lists.every((params) => params.get('assignee') === 'me')).toBe(true);
      // My tasks name each task's file.
      expect(within(column('TODO')).getAllByText('2026-LIT-00007').length).toBe(2);
    },
    SLOW,
  );

  it(
    "should move a card on a file's board and save its status and the column's new order",
    async () => {
      asRole('LAWYER');
      const calls = serve();
      await openFileTab();
      fireEvent.click(screen.getByTestId(`task-menu-${T1}`));
      fireEvent.click(await screen.findByTestId(`task-move-${T1}-IN_PROGRESS`));
      await waitFor(() =>
        expect(within(column('IN_PROGRESS')).queryByTestId(`task-card-${T1}`)).toBeTruthy(),
      );
      await waitFor(() =>
        expect(calls.writes.map((write) => write.method)).toEqual(['STATUS', 'REORDER']),
      );
      expect(calls.writes[0]?.body).toEqual({ status: 'IN_PROGRESS' });
      expect(calls.writes[1]?.body).toEqual({ status: 'IN_PROGRESS', taskIds: [T3, T1] });
    },
    SLOW,
  );

  it(
    'should put the card back and explain when the move is refused (403)',
    async () => {
      asRole('LAWYER');
      const calls = serve({ refuseMoves: true });
      await openMyTasks();
      fireEvent.click(screen.getByTestId(`task-menu-${T2}`));
      fireEvent.click(await screen.findByTestId(`task-move-${T2}-DONE`));
      expect(await screen.findByText(/permission/i, {}, { timeout: COLD })).toBeTruthy();
      await waitFor(() =>
        expect(within(column('TODO')).queryByTestId(`task-card-${T2}`)).toBeTruthy(),
      );
      expect(within(column('DONE')).queryByTestId(`task-card-${T2}`)).toBeNull();
      // The order is not saved after a refused move.
      expect(calls.writes.map((write) => write.method)).toEqual(['STATUS']);
    },
    SLOW,
  );

  it(
    'should switch to the list and send its filters',
    async () => {
      asRole('LAWYER');
      const calls = serve();
      await openMyTasks();
      fireEvent.click(screen.getByText('List'));
      await screen.findByTestId('task-list', {}, { timeout: COLD });
      fireEvent.click(screen.getByTestId('task-filter-overdue'));
      await waitFor(() => expect(calls.lists.at(-1)?.get('overdue')).toBe('true'));
      expect(calls.lists.at(-1)?.get('assignee')).toBe('me');
      expect(calls.lists.at(-1)?.get('limit')).toBe('20');
    },
    SLOW,
  );

  it(
    'should start on the list on a phone',
    async () => {
      asRole('PARALEGAL');
      serve();
      setViewport(390);
      renderApp('/tasks');
      expect(await screen.findByTestId('task-list', {}, { timeout: COLD })).toBeTruthy();
      expect(screen.queryByTestId('task-board')).toBeNull();
    },
    SLOW,
  );
});

describe('task moves by role (D-098, D-138)', () => {
  it(
    'should only change the column on My tasks, never the office-wide positions',
    async () => {
      asRole('LAWYER');
      const calls = serve();
      await openMyTasks();
      await moveVia(T1, 'IN_PROGRESS');
      await waitFor(() => expect(calls.writes.map((write) => write.method)).toEqual(['STATUS']));
    },
    SLOW,
  );

  it(
    'should keep a move whose status was saved when the new order is refused',
    async () => {
      asRole('LAWYER');
      const calls = serve({ refuseReorder: true });
      await openFileTab();
      await moveVia(T1, 'IN_PROGRESS');
      await waitFor(() =>
        expect(calls.writes.map((write) => write.method)).toEqual(['STATUS', 'REORDER']),
      );
      await waitFor(() =>
        expect(within(column('IN_PROGRESS')).queryByTestId(`task-card-${T1}`)).toBeTruthy(),
      );
      expect(screen.queryByText(/archived/i)).toBeNull();
    },
    SLOW,
  );

  it(
    'should let a trainee move cards but not save positions or add tasks',
    async () => {
      asRole('TRAINEE');
      const calls = serve();
      await openFileTab();
      expect(screen.queryByTestId('task-add')).toBeNull();
      await moveVia(T2, 'BLOCKED');
      await waitFor(() => expect(calls.writes.map((write) => write.method)).toEqual(['STATUS']));
    },
    SLOW,
  );

  it(
    'should let an outside collaborator move only the tasks assigned to them',
    async () => {
      asRole('EXTERNAL_COLLABORATOR');
      serve();
      server.use(
        http.get(api('tasks'), ({ request }) => {
          const status = new URL(request.url).searchParams.get('status');
          const items = [
            task(T1, 'TODO'),
            task(T2, 'TODO', {
              assignedTo: { id: '01920000-0000-7000-8000-0000000000b9', fullName: 'Sami' },
            }),
          ];
          return page(items.filter((item) => !status || item.status === status));
        }),
      );
      await openFileTab();
      expect(screen.getByTestId(`task-menu-${T1}`)).toBeTruthy();
      expect(screen.queryByTestId(`task-menu-${T2}`)).toBeNull();
      expect(screen.queryByTestId(`task-drag-${T2}`)).toBeNull();
    },
    SLOW,
  );
});

describe('task drawer (MVP-77)', () => {
  it(
    'should create a task on the file from its Tasks tab, and open with Ctrl+Alt+T there',
    async () => {
      asRole('LAWYER');
      const calls = serve();
      setViewport(1280);
      renderApp(`/cases/${FILE_ID}?tab=tasks`);
      await screen.findByTestId(`task-card-${T1}`, {}, { timeout: COLD });
      // The file's own tab does not repeat its number on every card.
      expect(within(column('TODO')).queryByText('2026-LIT-00007')).toBeNull();
      expect(calls.lists[0]?.get('fileId')).toBe(FILE_ID);
      fireEvent.keyDown(window, { ctrlKey: true, altKey: true, code: 'KeyT', key: 't' });
      const drawer = await screen.findByTestId('task-drawer', {}, { timeout: COLD });
      fireEvent.change(within(drawer).getByTestId('task-title'), {
        target: { value: 'File the appeal' },
      });
      fireEvent.click(within(drawer).getByTestId('task-save'));
      await waitFor(() => expect(calls.writes).toHaveLength(1));
      expect(calls.writes[0]?.body).toEqual({
        title: 'File the appeal',
        priority: 'MEDIUM',
        fileId: FILE_ID,
      });
    },
    SLOW,
  );

  it(
    'should save only the changed fields of a task',
    async () => {
      asRole('LAWYER');
      const calls = serve();
      await openMyTasks();
      fireEvent.click(screen.getByTestId(`task-open-${T2}`));
      const drawer = await screen.findByTestId('task-drawer', {}, { timeout: COLD });
      expect(drawer.textContent).toContain('2026-LIT-00007');
      fireEvent.change(within(drawer).getByTestId('task-title'), { target: { value: 'Renamed' } });
      fireEvent.click(within(drawer).getByTestId('task-save'));
      await waitFor(() => expect(calls.writes).toHaveLength(1));
      expect(calls.writes[0]).toMatchObject({ method: 'PATCH', body: { title: 'Renamed' } });
    },
    SLOW,
  );

  it(
    'should keep an archived file read-only',
    async () => {
      asRole('OFFICE_MANAGER');
      serve();
      server.use(http.get(api(`cases/${FILE_ID}`), () => ok({ ...FILE, status: 'ARCHIVED' })));
      setViewport(1280);
      renderApp(`/cases/${FILE_ID}?tab=tasks`);
      await screen.findByTestId(`task-card-${T1}`, {}, { timeout: COLD });
      expect(screen.queryByTestId('task-add')).toBeNull();
      expect(screen.queryByTestId(`task-menu-${T1}`)).toBeNull();
      fireEvent.click(screen.getByTestId(`task-open-${T1}`));
      const drawer = await screen.findByTestId('task-drawer', {}, { timeout: COLD });
      expect(within(drawer).queryByTestId('task-save')).toBeNull();
    },
    SLOW,
  );

  it(
    'should render the board in Arabic, right to left, and pass axe',
    async () => {
      asRole('LAWYER', 'AR');
      serve();
      await openMyTasks('ar');
      expect(document.documentElement.dir).toBe('rtl');
      expect(within(column('TODO')).getByText('متأخرة')).toBeTruthy();
      const { violations } = await axe.run(screen.getByTestId('tasks-view'), {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(violations.map((violation) => violation.id)).toEqual([]);
    },
    SLOW,
  );
});
