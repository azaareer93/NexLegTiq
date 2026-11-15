import { z } from 'zod';

/** `GET /admin/usage?days` (D-183): 7 to 90 days back, 30 by default. */
export const AdminUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
});
export type AdminUsageQuery = z.infer<typeof AdminUsageQuerySchema>;

const OfficeRef = { officeId: z.uuid(), officeName: z.string() };
/** Money as a decimal string (USD, provider prices), never a float (D-017). */
const Usd = z.string().regex(/^\d+(\.\d+)?$/);

/** Platform usage across offices (D-183): AI cost, storage, active users and the signup funnel. */
export const AdminUsageSchema = z.object({
  since: z.iso.date(),
  aiCostByDay: z.array(
    z.object({ date: z.iso.date(), costUsd: Usd, operations: z.number().int() }),
  ),
  aiCostByOffice: z.array(
    z.object({ ...OfficeRef, model: z.string(), costUsd: Usd, operations: z.number().int() }),
  ),
  storageByOffice: z.array(z.object({ ...OfficeRef, bytes: z.string().regex(/^\d+$/) })),
  activeUsers: z.object({ daily: z.number().int(), weekly: z.number().int() }),
  signups: z.object({
    offices: z.number().int(),
    verified: z.number().int(),
    withCase: z.number().int(),
  }),
});
export type AdminUsage = z.infer<typeof AdminUsageSchema>;

/** `GET /admin/queues`: job counts per BullMQ queue (D-183). */
export const AdminQueueSchema = z.object({
  name: z.string(),
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
});
export type AdminQueue = z.infer<typeof AdminQueueSchema>;

const PlatformAuditFilters = z.object({
  officeId: z.uuid().optional(),
  adminId: z.uuid().optional(),
  action: z.string().trim().min(1).max(60).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
const range = ({ from, to }: { from?: string; to?: string }) =>
  !from || !to || (from <= to && Date.parse(to) - Date.parse(from) <= 366 * 86_400_000);

/** `GET /admin/audit`: the platform audit log (what platform staff did, sign-ins included), newest first (D-183). */
export const AdminAuditQuerySchema = PlatformAuditFilters.extend({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine(range, { message: 'validation.auditRange', path: ['to'] });
export type AdminAuditQuery = z.infer<typeof AdminAuditQuerySchema>;

export const AdminAuditExportQuerySchema = PlatformAuditFilters.refine(range, {
  message: 'validation.auditRange',
  path: ['to'],
});
export type AdminAuditExportQuery = z.infer<typeof AdminAuditExportQuerySchema>;

/** One platform audit row; the office is the one the action concerned, if any. */
export const AdminAuditEntrySchema = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  admin: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  office: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  changes: z.array(z.object({ field: z.string(), old: z.unknown(), new: z.unknown() })),
});
export type AdminAuditEntry = z.infer<typeof AdminAuditEntrySchema>;

export const AdminAuditPageSchema = z.object({
  items: z.array(AdminAuditEntrySchema),
  nextCursor: z.uuid().nullable(),
});
export type AdminAuditPage = z.infer<typeof AdminAuditPageSchema>;
