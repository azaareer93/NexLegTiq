import { TaskReminders } from './task-reminders';

const TODAY = '2026-11-14';

function build({
  tasks = [] as object[],
  user = { email: 'u@example.test', fullName: 'U', uiLanguage: 'AR', notificationPrefs: {} } as
    object | null,
  settings = { taskReminderDays: [1] } as object | null,
  offices = [{ id: 'o1', timezone: 'Asia/Hebron' }],
} = {}) {
  const prisma = {
    db: {
      officeSettings: { findFirst: jest.fn().mockResolvedValue(settings) },
      task: { findMany: jest.fn().mockResolvedValue(tasks) },
      user: { findFirst: jest.fn().mockResolvedValue(user) },
    },
    unscoped: () => ({ office: { findMany: jest.fn().mockResolvedValue(offices) } }),
  };
  const tenant = { run: jest.fn((_c: unknown, work: () => unknown) => work()) };
  const queues = { enqueue: jest.fn() };
  const notifications = { notify: jest.fn() };
  const mail = { send: jest.fn() };
  const config = { mail: { officeAppUrl: 'https://app.example.test' } };
  const logger = { setContext: jest.fn(), info: jest.fn() };
  const reminders = new TaskReminders(
    prisma as never,
    tenant as never,
    queues as never,
    notifications as never,
    mail as never,
    config as never,
    logger as never,
  );
  return { reminders, prisma, queues, notifications, mail };
}

const row = (
  id: string,
  dueDate: string,
  file: object | null = { fileNumber: 'F-1', title: 'File' },
) => ({
  id,
  title: `T ${id}`,
  dueDate: new Date(`${dueDate}T00:00:00Z`),
  assignedToId: 'u1',
  file,
});

describe('TaskReminders (D-177)', () => {
  it('should queue the daily job at 08:xx office time only', async () => {
    const { reminders, queues } = build();
    // 06:05 UTC = 08:05 in Hebron in November (UTC+2).
    await expect(reminders.tick(new Date('2026-11-14T06:05:00Z'))).resolves.toEqual({ queued: 1 });
    expect(queues.enqueue).toHaveBeenCalledWith(
      'reminder',
      'task-daily',
      { date: TODAY },
      { jobId: `task-daily-${TODAY}` },
    );
    const later = build();
    await expect(later.reminders.tick(new Date('2026-11-14T07:05:00Z'))).resolves.toEqual({
      queued: 0,
    });
  });

  it('should send due-soon reminders, a digest and one email grouped by file (no-file tasks apart)', async () => {
    const { reminders, notifications, mail, prisma } = build({
      tasks: [
        row('a', '2026-11-15'),
        row('b', '2026-11-10'),
        row('c', TODAY, null),
        { ...row('d', TODAY), dueDate: null },
      ],
    });
    await expect(reminders.daily({ date: TODAY })).resolves.toEqual({ users: 1 });
    expect(prisma.db.task.findMany.mock.calls[0][0].where.OR[1]).toEqual({
      dueDate: { in: [new Date('2026-11-15T00:00:00Z')] },
    });
    const calls = notifications.notify.mock.calls.map((c) => c[1].titleKey);
    expect(calls).toEqual(['shell.notifications.taskDue', 'shell.notifications.taskDigest']);
    expect(notifications.notify.mock.calls[1][1].params).toEqual({ overdue: 1, today: 1 });
    const vars = mail.send.mock.calls[0][3];
    expect(vars.count).toBe(3);
    expect(vars.files.map((f: { fileNumber: string }) => f.fileNumber)).toEqual(['F-1', '']);
  });

  it('should skip the digest with nothing due today or overdue, the email when turned off, and inactive users', async () => {
    const soonOnly = build({
      tasks: [row('a', '2026-11-15')],
      user: {
        email: 'u@x.test',
        fullName: 'U',
        uiLanguage: 'EN',
        notificationPrefs: { TASKS: { email: false } },
      },
    });
    await soonOnly.reminders.daily({ date: TODAY });
    expect(soonOnly.notifications.notify).toHaveBeenCalledTimes(1);
    expect(soonOnly.mail.send).not.toHaveBeenCalled();
    const gone = build({ tasks: [row('a', TODAY)], user: null });
    await gone.reminders.daily({ date: TODAY });
    expect(gone.notifications.notify).not.toHaveBeenCalled();
    // 0 = the due day only: no separate reminder; no settings row: one day before.
    const dueDay = build({ settings: { taskReminderDays: [0] } });
    await dueDay.reminders.daily({ date: TODAY });
    expect(dueDay.prisma.db.task.findMany.mock.calls[0][0].where.OR[1]).toEqual({
      dueDate: { in: [] },
    });
    const none = build({ settings: null });
    await none.reminders.daily({ date: TODAY });
    expect(none.prisma.db.task.findMany.mock.calls[0][0].where.OR[1].dueDate.in).toHaveLength(1);
  });
});
