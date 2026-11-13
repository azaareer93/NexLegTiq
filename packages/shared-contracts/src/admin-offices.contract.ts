import { ACCOUNT_TYPES, JURISDICTIONS, SUBSCRIPTION_STATUSES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, plainText, searchText } from './fields.js';

/** Office status as the platform admin sees it: `isActive` on the office (suspension blocks every login, D-082). */
export const OFFICE_ADMIN_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;

const IsoDate = z.iso.date();

/** `GET /admin/offices` (platform realm, D-145): every office, newest first. */
export const AdminOfficeQuerySchema = z
  .object({
    /** Part of the office name (case-insensitive). */
    search: searchText(100).optional(),
    /** Plan code of the office's current subscription (live, else newest). */
    plan: plainText(64).optional(),
    status: z.enum(OFFICE_ADMIN_STATUSES).optional(),
    jurisdiction: z.enum(JURISDICTIONS).optional(),
    /** Created on or after this UTC date. */
    createdFrom: IsoDate.optional(),
    /** Created on or before this UTC date. */
    createdTo: IsoDate.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => !q.createdFrom || !q.createdTo || q.createdFrom <= q.createdTo, {
    message: 'validation.dateRange',
    path: ['createdTo'],
  });
export type AdminOfficeQuery = z.infer<typeof AdminOfficeQuerySchema>;

/** Usage of one office; storage in MiB rounded up, AI = counted provider calls this UTC month (D-130, D-144). */
export const AdminOfficeUsageSchema = z.object({
  activeUsers: z.number().int(),
  liveFiles: z.number().int(),
  storageMb: z.number().int(),
  aiThisMonth: z.number().int(),
});
export type AdminOfficeUsage = z.infer<typeof AdminOfficeUsageSchema>;

const PlanRefSchema = z.object({ code: z.string(), name: z.string() });

export const AdminOfficeListItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  jurisdiction: z.enum(JURISDICTIONS),
  status: z.enum(OFFICE_ADMIN_STATUSES),
  createdAt: z.iso.datetime(),
  /** The current subscription's plan and status, or null for an office without any subscription. */
  plan: PlanRefSchema.nullable(),
  subscriptionStatus: z.enum(SUBSCRIPTION_STATUSES).nullable(),
  usage: AdminOfficeUsageSchema,
  /** The latest sign-in of any of its users; null if nobody signed in yet. */
  lastActivityAt: z.iso.datetime().nullable(),
  /** The latest write (create, update, delete, share) in the office audit log; null if none yet. */
  lastWriteAt: z.iso.datetime().nullable(),
  /** An active office older than 14 days with no write in the last 14 days (D-164). */
  atRisk: z.boolean(),
});
export type AdminOfficeListItem = z.infer<typeof AdminOfficeListItemSchema>;

export const AdminSubscriptionRowSchema = z.object({
  id: z.uuid(),
  plan: PlanRefSchema,
  status: z.enum(SUBSCRIPTION_STATUSES),
  currentPeriodStart: z.iso.datetime(),
  currentPeriodEnd: z.iso.datetime().nullable(),
  trialEndsAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminSubscriptionRow = z.infer<typeof AdminSubscriptionRowSchema>;

/** Counts only, nothing named leaves the office (D-164); "30d" = the last 30 days. */
export const AdminOfficeStatisticsSchema = z.object({
  /** Active users who signed in within 30 days. */
  signedIn30d: z.number().int(),
  /** Live files per status. */
  filesByStatus: z.object({
    OPEN: z.number().int(),
    SUSPENDED: z.number().int(),
    CLOSED: z.number().int(),
    ARCHIVED: z.number().int(),
  }),
  filesNew30d: z.number().int(),
  documents: z.number().int(),
  documentsNew30d: z.number().int(),
  /** Writes (create, update, delete, share) in the office audit log. */
  writes30d: z.number().int(),
  aiEnabled: z.boolean(),
  ocrEnabled: z.boolean(),
});
export type AdminOfficeStatistics = z.infer<typeof AdminOfficeStatisticsSchema>;

/** `GET /admin/offices/:id`. */
export const AdminOfficeDetailSchema = AdminOfficeListItemSchema.extend({
  accountType: z.enum(ACCOUNT_TYPES),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  currency: z.string(),
  timezone: z.string(),
  /** Every subscription the office has had, newest first. */
  subscriptions: z.array(AdminSubscriptionRowSchema),
  /** While suspended: when and why (from the platform audit log). */
  suspension: z.object({ at: z.iso.datetime(), reason: z.string() }).nullable(),
  statistics: AdminOfficeStatisticsSchema,
});
export type AdminOfficeDetail = z.infer<typeof AdminOfficeDetailSchema>;

/** `POST /admin/offices/:id/suspend`: the reason is required and kept in the platform audit log. */
export const SuspendOfficeSchema = z.object({
  reason: longText(500).refine((value) => value.trim().length >= 3, 'validation.required'),
});
export type SuspendOfficeRequest = z.infer<typeof SuspendOfficeSchema>;

/** `POST /admin/offices/:id/reactivate`. */
export const ReactivateOfficeSchema = z.object({ reason: longText(500).optional() });
export type ReactivateOfficeRequest = z.infer<typeof ReactivateOfficeSchema>;
