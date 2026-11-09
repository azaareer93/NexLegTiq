import { Injectable } from '@nestjs/common';
import type { Dashboard, DashboardDeadline, DashboardHearing } from '@nexlegtiq/shared-contracts';
import type { SessionType, UserId } from '@nexlegtiq/shared-types';
import { wallClock, zonedDateTime } from '@nexlegtiq/shared-utils';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import { assignedFilesWhere } from '../../common/rbac/case-scope';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { DocumentAccessService } from '../documents/document-access.service';
import { CaseAccessService } from '../legal-files/case-access.service';
import { toDbDate } from '../tasks/tasks.repository';
import { TimelineService } from '../timeline/timeline.service';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Open as BIZ-010 and the team wizard count it (D-108, D-124). */
const OPEN = { in: ['OPEN', 'SUSPENDED'] as ('OPEN' | 'SUSPENDED')[] };
/** A task's file it can still be worked on: live and not archived (archived files are read-only, D-098). */
const WORKABLE: Prisma.TaskWhereInput = {
  OR: [{ fileId: null }, { file: { deletedAt: null, status: { not: 'ARCHIVED' } } }],
};
/** The window of the deadlines: today and the 6 days after it. */
const WEEK = 7;
const FILE = { select: { id: true, fileNumber: true, title: true } } as const;
const HEARING = { id: true, sessionType: true, startsAt: true, file: FILE } as const;
const LIST = 20;

interface FileRef {
  id: string;
  fileNumber: string;
  title: string;
}
interface HearingRow {
  id: string;
  sessionType: SessionType;
  startsAt: Date;
  file: FileRef;
}
interface TaskRow {
  id: string;
  title: string;
  dueDate: Date | null;
  file: FileRef | null;
}

/** `YYYY-MM-DD` plus `days` (calendar arithmetic, no time zone involved). */
export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const hearing = (row: HearingRow): DashboardHearing => ({
  ...row,
  startsAt: row.startsAt.toISOString(),
});

/** Hearings and tasks of the next 7 days in date order (a task counts from the start of its day), at most 20. */
export function deadlines(
  hearings: readonly HearingRow[],
  tasks: readonly TaskRow[],
  startOf: (date: string) => Date,
): DashboardDeadline[] {
  const items = [
    ...hearings.map((h) => ({
      sort: h.startsAt.toISOString(),
      item: { kind: 'HEARING' as const, ...hearing(h) },
    })),
    ...tasks.flatMap((t) =>
      t.dueDate
        ? [
            {
              // A task counts from the start of its day in the office's zone, not UTC midnight.
              sort: startOf(t.dueDate.toISOString().slice(0, 10)).toISOString(),
              item: {
                kind: 'TASK' as const,
                id: t.id,
                title: t.title,
                file: t.file,
                dueDate: t.dueDate.toISOString().slice(0, 10),
              },
            },
          ]
        : [],
    ),
  ];
  return items
    .sort((a, b) => a.sort.localeCompare(b.sort))
    .slice(0, LIST)
    .map(({ item }) => item);
}

/** The caller's day at a glance (MVP-96, D-151): a handful of indexed counts and short lists, all on the scoped client. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
    private readonly documents: DocumentAccessService,
    private readonly timeline: TimelineService,
  ) {}

  async get(now = new Date()): Promise<Dashboard> {
    const userId = this.cls.get('userId') as UserId | undefined;
    const role = this.cls.get('role');
    if (!userId || !role) throw new Error('No office caller in the request context');
    const permissions = this.cls.get('permissions') ?? [];
    const { timezone } = await this.prisma.db.office.findFirstOrThrow({
      select: { timezone: true },
    });
    const today = wallClock(now, timezone).date;
    const at = (date: string) => new Date(zonedDateTime(date, '00:00', timezone));
    const [mine, team, newClientsThisMonth, activity] = await Promise.all([
      this.mine(userId, today, now, at),
      role === 'OFFICE_MANAGER' || role === 'SENIOR_LAWYER'
        ? this.team(today, now, at(addDays(today, WEEK)))
        : null,
      permissions.includes('manage:clients')
        ? this.prisma.db.client.count({
            where: { deletedAt: null, createdAt: { gte: at(`${today.slice(0, 8)}01`) } },
          })
        : null,
      this.timeline.recent(userId, LIST),
    ]);
    return { today, ...mine, newClientsThisMonth, activity, team };
  }

  /** What concerns the caller: the files they are assigned to (D-051), the hearings they attend, their tasks. */
  private async mine(userId: UserId, today: string, now: Date, at: (date: string) => Date) {
    const db = this.prisma.db;
    const assigned: Prisma.LegalFileWhereInput = {
      AND: [this.files.visibleWhere(), assignedFilesWhere(userId)],
    };
    // My hearings: the ones I attend or that sit on my files (D-116 lets a colleague attend a file they only see).
    const myHearings: Prisma.SessionWhereInput = {
      isCancelled: false,
      file: this.files.visibleWhere(),
      OR: [{ attendingLawyerId: userId }, { file: assignedFilesWhere(userId) }],
    };
    const myOpenTasks: Prisma.TaskWhereInput = {
      assignedToId: userId,
      status: { not: 'DONE' },
      // A task on a file the caller can no longer see (made confidential, taken off the team) is not theirs to read
      // (D-098), nor one on an archived file (read-only).
      OR: [
        { fileId: null },
        { file: { AND: [this.files.visibleWhere(), { status: { not: 'ARCHIVED' } }] } },
      ],
    };
    const [
      open,
      openedThisWeek,
      todayHearings,
      overdueTasks,
      newDocuments,
      hearingsAhead,
      tasksAhead,
    ] = await Promise.all([
      db.legalFile.count({ where: { AND: [assigned, { status: 'OPEN' }] } }),
      db.legalFile.count({
        where: {
          AND: [assigned, { status: 'OPEN', openingDate: { gte: toDbDate(addDays(today, -6)) } }],
        },
      }),
      db.session.findMany({
        where: { ...myHearings, startsAt: { gte: at(today), lt: at(addDays(today, 1)) } },
        orderBy: { startsAt: 'asc' },
        take: LIST,
        select: HEARING,
      }),
      db.task.count({ where: { ...myOpenTasks, dueDate: { lt: toDbDate(today) } } }),
      db.document.count({
        where: {
          AND: [
            this.documents.visibleWhere(),
            { file: assignedFilesWhere(userId) },
            {
              uploadedById: { not: userId },
              createdAt: { gte: new Date(now.getTime() - 7 * DAY_MS) },
            },
          ],
        },
      }),
      db.session.findMany({
        where: { ...myHearings, startsAt: { gte: now, lt: at(addDays(today, WEEK)) } },
        orderBy: { startsAt: 'asc' },
        take: LIST,
        select: HEARING,
      }),
      db.task.findMany({
        where: {
          ...myOpenTasks,
          dueDate: { gte: toDbDate(today), lte: toDbDate(addDays(today, WEEK - 1)) },
        },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: LIST,
        select: { id: true, title: true, dueDate: true, file: FILE },
      }),
    ]);
    const soon = todayHearings.find(
      (h) => h.startsAt >= now && h.startsAt.getTime() - now.getTime() <= HOUR_MS,
    );
    return {
      openFiles: { count: open, openedThisWeek },
      todayHearings: todayHearings.map(hearing),
      nextHearingId: soon?.id ?? null,
      overdueTasks,
      newDocuments,
      deadlines: deadlines(hearingsAhead, tasksAhead, at),
    };
  }

  /** Office-wide counts per lawyer (counts only, confidential files included — like client file counts, D-108). */
  private async team(today: string, from: Date, to: Date): Promise<NonNullable<Dashboard['team']>> {
    const db = this.prisma.db;
    const [lawyers, files, tasks, hearingsThisWeek] = await Promise.all([
      db.user.findMany({
        where: { isActive: true, role: { in: ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER'] } },
        orderBy: { fullName: 'asc' },
        select: { id: true, fullName: true },
      }),
      db.legalFile.groupBy({
        by: ['responsibleLawyerId'],
        where: { deletedAt: null, status: OPEN },
        _count: { _all: true },
      }),
      db.task.groupBy({
        by: ['assignedToId'],
        where: {
          status: { not: 'DONE' },
          dueDate: { lt: toDbDate(today) },
          ...WORKABLE,
        },
        _count: { _all: true },
      }),
      db.session.count({
        where: { isCancelled: false, file: { deletedAt: null }, startsAt: { gte: from, lt: to } },
      }),
    ]);
    const openFiles = new Map(files.map((row) => [row.responsibleLawyerId, row._count._all]));
    const overdue = new Map(tasks.map((row) => [row.assignedToId, row._count._all]));
    return {
      workload: lawyers.map((user) => ({
        userId: user.id,
        fullName: user.fullName,
        openFiles: openFiles.get(user.id) ?? 0,
        overdueTasks: overdue.get(user.id) ?? 0,
      })),
      hearingsThisWeek,
    };
  }
}
