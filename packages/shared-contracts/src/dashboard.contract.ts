import { SESSION_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { TimelineEventSchema } from './timeline.contract.js';

const DashboardFileSchema = z.object({ id: z.uuid(), fileNumber: z.string(), title: z.string() });

export const DashboardHearingSchema = z.object({
  id: z.uuid(),
  file: DashboardFileSchema,
  sessionType: z.enum(SESSION_TYPES),
  startsAt: z.iso.datetime(),
});
export type DashboardHearing = z.infer<typeof DashboardHearingSchema>;

/** A hearing (an instant) or a task (a calendar date, D-092) due within the next 7 days. */
export const DashboardDeadlineSchema = z.discriminatedUnion('kind', [
  DashboardHearingSchema.extend({ kind: z.literal('HEARING') }),
  z.object({
    kind: z.literal('TASK'),
    id: z.uuid(),
    title: z.string(),
    dueDate: z.iso.date(),
    file: DashboardFileSchema.nullable(),
  }),
]);
export type DashboardDeadline = z.infer<typeof DashboardDeadlineSchema>;

export const DashboardWorkloadSchema = z.object({
  userId: z.uuid(),
  fullName: z.string(),
  openFiles: z.number().int(),
  overdueTasks: z.number().int(),
});
export type DashboardWorkload = z.infer<typeof DashboardWorkloadSchema>;

const MoneyByCurrencySchema = z.object({ currency: z.string(), amount: z.string() });

/** Invoice money the caller may see (MVP-149): unpaid = SENT or OVERDUE; revenue = paid this month (office zone). */
export const DashboardFinanceSchema = z.object({
  unpaid: z.array(MoneyByCurrencySchema.extend({ count: z.number().int() })),
  /** Unpaid and past their due date (OVERDUE, or SENT before the daily sweep has turned them). */
  overdueCount: z.number().int(),
  revenueThisMonth: z.array(MoneyByCurrencySchema),
});
export type DashboardFinance = z.infer<typeof DashboardFinanceSchema>;

/**
 * `GET /dashboard` (D-151): the caller's day. "My files" are the files they are assigned to (D-051); dates are the
 * office's (D-092). `newClientsThisMonth` is null without `manage:clients`, `team` null for roles other than the office
 * manager and senior lawyers, `finance` null without `view:all|assigned:invoices`.
 */
export const DashboardSchema = z.object({
  today: z.iso.date(),
  openFiles: z.object({ count: z.number().int(), openedThisWeek: z.number().int() }),
  todayHearings: z.array(DashboardHearingSchema),
  /** The first of today's hearings starting within the hour, if any. */
  nextHearingId: z.uuid().nullable(),
  overdueTasks: z.number().int(),
  /** Documents others uploaded to my files in the last 7 days. */
  newDocuments: z.number().int(),
  newClientsThisMonth: z.number().int().nullable(),
  deadlines: z.array(DashboardDeadlineSchema),
  activity: z.object({
    items: z.array(TimelineEventSchema.extend({ file: DashboardFileSchema })),
    names: z.record(z.uuid(), z.string()),
  }),
  team: z
    .object({ workload: z.array(DashboardWorkloadSchema), hearingsThisWeek: z.number().int() })
    .nullable(),
  finance: DashboardFinanceSchema.nullable(),
});
export type Dashboard = z.infer<typeof DashboardSchema>;
