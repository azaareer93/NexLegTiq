import { TaskReminders } from './task-reminders';

const TODAY = '2026-11-14';
const USER = {
  id: 'u1',
  role: 'LAWYER',
  email: 'u@example.test',
  fullName: 'U',
  uiLanguage: 'AR',
  notificationPrefs: {},
};

function build({
  tasks = [] as object[] | Error,
  users = [USER] as object[],
  settings = { taskReminderDays: [1] } as object | null,
  offices = [{ id: 'o1', timezone: 'Asia/Hebron' }] as object[],
} = {}) {
  const findTasks =
    tasks instanceof Error
      ? jest.fn().mockRejectedValue(tasks)
      : jest.fn().mockResolvedValue(tasks);
  const prisma = {
    db: {
      officeSettings: { findFirst: jest.fn().mockResolvedValue(settings) },
      task: { findMany: findTasks },
      user: { findMany: jest.fn().mockResolvedValue(users) },
    },
    unscoped: () => ({ office: { findMany: jest.fn().mockResolvedValue(offices) } }),
  };
  const tenant = { run: jest.fn((_c: unknown, work: () => unknown) => work()) };
  const queues = { enqueue: jest.fn() };
  const notifications = { notify: jest.fn() };
  const mail = { send: jest.fn() };
  const config = { mail: { officeAppUrl: 'https://app.example.test' } };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const reminders = new TaskReminders(
    prisma as never,
    tenant as never,
    queues as never,
    notifications as never,
    mail as never,
    config as never,
    logger as never,
  );
  return { reminders, prisma, queues, notifications, mail, logger };
}

const row = (
  id: string,
  dueDate: string,
  file: object | null = { fileNumber: 'F-1', title: 'File' },
) => ({
  id,
  title: `T ${id}`,
  dueDate: new Date(`${dueDate}T00:00:00Z`),
  file,
});

describe('TaskReminders (D-177)', () => {
  it('should queue the daily job at 08:xx office time only, and skip an office whose clock cannot be read', async () => {
    const { reminders, queues, logger } = build({
      offices: [
        { id: 'bad', timezone: 'Not/AZone' },
        { id: 'o1', timezone: 'Asia/Hebron' },
      ],
    });
    // 06:05 UTC = 08:05 in Hebron in November (UTC+2).
    await expect(reminders.tick(new Date('2026-11-14T06:05:00Z'))).resolves.toEqual({ queued: 1 });
    expect(queues.enqueue).toHaveBeenCalledWith(
      'reminder',
      'task-daily',
      { date: TODAY },
      { jobId: `task-daily-${TODAY}` },
    );
    expect(logger.warn).toHaveBeenCalled();
    const later = build();
    await expect(later.reminders.tick(new Date('2026-11-14T07:05:00Z'))).resolves.toEqual({
      queued: 0,
    });
  });

  it('should send due-soon reminders keyed by the run day, a digest and one email grouped by file', async () => {
    const { reminders, notifications, mail, prisma } = build({
      tasks: [
        row('a', '2026-11-15'),
        row('b', '2026-11-10'),
        row('c', TODAY, null),
        { ...row('d', TODAY), dueDate: null },
      ],
    });
    await expect(reminders.daily({ date: TODAY })).resolves.toEqual({ users: 1 });
    const where = prisma.db.task.findMany.mock.calls[0][0].where;
    expect(where.assignedToId).toBe('u1');
    expect(where.OR[1]).toEqual({ dueDate: { in: [new Date('2026-11-15T00:00:00Z')] } });
    expect(notifications.notify.mock.calls[0][2]).toEqual({ jobId: `task-due-a-${TODAY}` });
    expect(notifications.notify.mock.calls.map((c) => c[1].titleKey)).toEqual([
      'shell.notifications.taskDue',
      'shell.notifications.taskDigest',
    ]);
    expect(notifications.notify.mock.calls[1][1].params).toEqual({ overdue: 1, today: 1 });
    const vars = mail.send.mock.calls[0][3];
    expect(vars.count).toBe(3);
    expect(vars.files.map((f: { fileNumber: string }) => f.fileNumber)).toEqual(['F-1', '']);
  });

  it('should cap the email lines but count them all', async () => {
    const many = Array.from({ length: 60 }, (_, i) => row(`t${i}`, '2026-11-10'));
    const { reminders, mail } = build({ tasks: many });
    await reminders.daily({ date: TODAY });
    const vars = mail.send.mock.calls[0][3];
    expect(vars.count).toBe(60);
    expect(vars.files[0].tasks).toHaveLength(50);
  });

  it('should skip the digest without overdue or due-today tasks, the email when turned off, and users with nothing', async () => {
    const soonOnly = build({
      tasks: [row('a', '2026-11-15')],
      users: [{ ...USER, uiLanguage: 'EN', notificationPrefs: { TASKS: { email: false } } }],
    });
    await soonOnly.reminders.daily({ date: TODAY });
    expect(soonOnly.notifications.notify).toHaveBeenCalledTimes(1);
    expect(soonOnly.mail.send).not.toHaveBeenCalled();
    const empty = build({ tasks: [] });
    await expect(empty.reminders.daily({ date: TODAY })).resolves.toEqual({ users: 0 });
    // 0 = the due day only: no separate reminder; no settings row: one day before.
    const dueDay = build({ settings: { taskReminderDays: [0] } });
    await dueDay.reminders.daily({ date: TODAY });
    expect(dueDay.prisma.db.user.findMany.mock.calls[0][0].where.assignedTasks.some.OR[1]).toEqual({
      dueDate: { in: [] },
    });
    const none = build({ settings: null });
    await none.reminders.daily({ date: TODAY });
    expect(
      none.prisma.db.user.findMany.mock.calls[0][0].where.assignedTasks.some.OR[1].dueDate.in,
    ).toHaveLength(1);
  });

  it('should go on after one user fails and fail the job at the end, or stop when aborted', async () => {
    const broken = build({ tasks: new Error('db down'), users: [USER, { ...USER, id: 'u2' }] });
    await expect(broken.reminders.daily({ date: TODAY })).rejects.toThrow('db down');
    expect(broken.prisma.db.task.findMany).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    const aborted = build();
    await expect(aborted.reminders.daily({ date: TODAY }, controller.signal)).rejects.toThrow(
      'aborted',
    );
  });
});
