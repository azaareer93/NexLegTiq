import { Injectable } from '@nestjs/common';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { OfficeId } from '@nexlegtiq/shared-types';
import type { UserId } from '@nexlegtiq/shared-types';
import { formatDate, wallClock } from '@nexlegtiq/shared-utils';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { MailService } from '../../common/mail/mail.service';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { caseScope, caseScopeWhere } from '../../common/rbac/case-scope';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { wants } from '../notifications/notification-preferences';
import { NotificationService } from '../notifications/notification.service';

/** Hourly platform job (no office): queues each office's daily task job when it is 08:00 there. */
export const TASK_TICK_JOB = 'task-reminders-tick';
export const TASK_TICK_SCHEDULE = { pattern: '5 * * * *', tz: 'UTC' } as const;
/** An office's daily task job: due-soon reminders and the overdue / due-today digest, per user. */
export const TASK_DAILY_JOB = 'task-daily';
export const TaskDailyJobSchema = z.object({ date: z.iso.date() });
export type TaskDailyJob = z.infer<typeof TaskDailyJobSchema>;

const DIGEST_HOUR = '08';
const TASKS_PATH = '/tasks?scope=mine';
const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const day = (value: Date) => value.toISOString().slice(0, 10);

interface Assignee {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly uiLanguage: 'AR' | 'EN';
  readonly notificationPrefs: unknown;
}

/** The email lists at most this many files and tasks per file (the template's limits); `count` stays the total. */
const MAX_FILES = 20;
const MAX_TASKS_PER_FILE = 50;

interface Line {
  readonly id: string;
  readonly title: string;
  readonly dueDate: string;
  readonly file: { readonly fileNumber: string; readonly title: string } | null;
}

/** The email's lines grouped by file (tasks without a file last, under an empty file number), each marked. */
function byFile(lines: readonly Line[], date: string, locale: 'ar' | 'en') {
  const files = new Map<string, { fileNumber: string; fileTitle: string; tasks: object[] }>();
  for (const line of lines) {
    const key = line.file?.fileNumber ?? '';
    const group = files.get(key) ?? {
      fileNumber: key,
      fileTitle: line.file?.title ?? '',
      tasks: [],
    };
    group.tasks.push({
      title: line.title,
      dueDate: formatDate(line.dueDate, { locale }),
      overdue: line.dueDate < date,
      today: line.dueDate === date,
    });
    files.set(key, group);
  }
  return [...files.values()]
    .slice(0, MAX_FILES)
    .map((group) => ({ ...group, tasks: group.tasks.slice(0, MAX_TASKS_PER_FILE) }));
}

/**
 * Task reminders (MVP-79, D-177), worked out every day from the tasks as they are then — a changed due date, a
 * completed or deleted task needs no job to move or cancel. At 08:00 office time each assignee gets one in-app
 * notification per task due in one of the office's `taskReminderDays` (1 by default) and one digest of what is due today or overdue,
 * and, unless they turned task emails off, one email with all of it grouped by file. Nothing is sent when there is
 * nothing. The day's job id makes it run once per office and day.
 */
@Injectable()
export class TaskReminders {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantRunner,
    private readonly queues: QueueProducer,
    private readonly notifications: NotificationService,
    private readonly mail: MailService,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TaskReminders.name);
  }

  /** Every active office where it is now 08:xx gets its daily job (in its own context; the id dedupes the day). */
  async tick(now = new Date()): Promise<{ readonly queued: number }> {
    // unscoped: the hourly tick looks at every office's clock; each daily job then runs in its office.
    const offices = await this.prisma.unscoped().office.findMany({
      where: { isActive: true },
      select: { id: true, timezone: true },
    });
    let queued = 0;
    for (const office of offices) {
      // One office's bad zone or failed enqueue never stops the others.
      try {
        const clock = wallClock(now, office.timezone);
        if (!clock.time.startsWith(`${DIGEST_HOUR}:`)) continue;
        await this.tenant.run({ officeId: office.id as OfficeId }, () =>
          this.queues.enqueue(
            QUEUE.REMINDER,
            TASK_DAILY_JOB,
            { date: clock.date } satisfies TaskDailyJob,
            {
              jobId: `task-daily-${clock.date}`,
            },
          ),
        );
        queued += 1;
      } catch (err) {
        this.logger.warn({ err, officeId: office.id }, 'Task reminders not queued for an office');
      }
    }
    return { queued };
  }

  /**
   * The office's reminders and digests for `date` (its local day); runs in the office's context. Per assignee, only
   * tasks they may still see (the file is live, open or suspended, and in their case scope — as `colleagueMay`) count:
   * a task on a deleted, closed or archived file, or one they lost access to, is neither shown nor mailed. A failure for
   * one user does not stop the others; the job is retried after the loop (the ids make the retry a no-op for those done).
   */
  async daily({ date }: TaskDailyJob, signal?: AbortSignal): Promise<{ readonly users: number }> {
    const settings = await this.prisma.db.officeSettings.findFirst({
      select: { taskReminderDays: true },
    });
    // 0 = the due day itself, which the digest already covers.
    const soon = (settings?.taskReminderDays ?? [1])
      .filter((d) => d > 0)
      .map((d) => addDays(date, d));
    const due = {
      status: { not: 'DONE' as const },
      OR: [
        { dueDate: { lte: new Date(`${date}T00:00:00Z`) } },
        { dueDate: { in: soon.map((d) => new Date(`${d}T00:00:00Z`)) } },
      ],
    };
    const assignees = await this.prisma.db.user.findMany({
      where: { isActive: true, assignedTasks: { some: due } },
      select: {
        id: true,
        role: true,
        email: true,
        fullName: true,
        uiLanguage: true,
        notificationPrefs: true,
      },
    });
    let reminded = 0;
    let failed: unknown = null;
    for (const user of assignees) {
      if (signal?.aborted) throw new Error('Task reminders aborted');
      try {
        const permissions = permissionsFor(user.role);
        const scope = caseScopeWhere(caseScope(permissions, user.id as UserId), user.role);
        const tasks = await this.prisma.db.task.findMany({
          where: {
            ...due,
            assignedToId: user.id,
            AND: [
              {
                OR: [
                  { fileId: null },
                  {
                    file: {
                      is: { deletedAt: null, status: { in: ['OPEN', 'SUSPENDED'] }, ...scope },
                    },
                  },
                ],
              },
            ],
          },
          orderBy: [{ fileId: 'asc' }, { dueDate: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            title: true,
            dueDate: true,
            file: { select: { fileNumber: true, title: true } },
          },
        });
        const lines = tasks.flatMap((t) =>
          t.dueDate ? [{ id: t.id, title: t.title, dueDate: day(t.dueDate), file: t.file }] : [],
        );
        if (lines.length === 0) continue;
        await this.remind(user, lines, date, soon);
        reminded += 1;
      } catch (err) {
        this.logger.warn({ err, userId: user.id }, 'Task reminders failed for a user');
        failed = err;
      }
    }
    if (failed) throw failed;
    return { users: reminded };
  }

  private async remind(
    user: Assignee,
    lines: readonly Line[],
    date: string,
    soon: readonly string[],
  ): Promise<void> {
    const userId = user.id;
    const dueSoon = lines.filter((l) => soon.includes(l.dueDate));
    for (const task of dueSoon) {
      await this.notifications.notify(
        [userId],
        {
          type: 'TASK_DUE',
          titleKey: 'shell.notifications.taskDue',
          params: { taskId: task.id, title: task.title, dueDate: task.dueDate },
          link: TASKS_PATH,
        },
        { jobId: `task-due-${task.id}-${date}` },
      );
    }
    const overdue = lines.filter((l) => l.dueDate < date).length;
    const today = lines.filter((l) => l.dueDate === date).length;
    if (overdue + today > 0) {
      await this.notifications.notify(
        [userId],
        {
          type: 'TASK_DUE',
          titleKey: 'shell.notifications.taskDigest',
          params: { overdue, today },
          link: TASKS_PATH,
        },
        { jobId: `task-digest-${userId}-${date}` },
      );
    }
    if (!wants(user.notificationPrefs, 'TASK_DUE', 'email')) return;
    await this.mail.send(
      user.email,
      'task-digest',
      user.uiLanguage,
      {
        name: user.fullName,
        link: `${this.config.mail.officeAppUrl}${TASKS_PATH}`,
        count: lines.length,
        files: byFile(lines, date, user.uiLanguage === 'EN' ? 'en' : 'ar') as never,
      },
      { jobId: `task-digest-email-${userId}-${date}` },
    );
    this.logger.info({ userId, tasks: lines.length }, 'Task digest sent');
  }
}
