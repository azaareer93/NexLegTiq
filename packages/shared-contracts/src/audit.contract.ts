import { AUDIT_ACTIONS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

/** The filters shared by the audit list and its export (D-180); dates are office calendar days, both included. */
const AuditFiltersSchema = z.object({
  entityType: z.string().trim().min(1).max(60).optional(),
  entityId: z.uuid().optional(),
  userId: z.uuid().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

const inRange = ({ from, to }: { from?: string; to?: string }) =>
  !from || !to || (from <= to && Date.parse(to) - Date.parse(from) <= MAX_RANGE_DAYS * DAY_MS);
const RANGE = { message: 'validation.auditRange', path: ['to'] };

/** `GET /audit` and `GET /cases/:id/audit` (D-180): newest first, `cursor` = the last id of the previous page. */
export const AuditQuerySchema = AuditFiltersSchema.extend({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine(inRange, RANGE);
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/** `GET /audit/export` (D-180): the same filters as a CSV of at most 10,000 rows (more → 422 BIZ-025). */
export const AuditExportQuerySchema = AuditFiltersSchema.extend({
  format: z.literal('csv').default('csv'),
}).refine(inRange, RANGE);
export type AuditExportQuery = z.infer<typeof AuditExportQuerySchema>;

/** Who did it: an office user, a platform admin, a portal client, or the system (no actor). */
export const AuditActorSchema = z.object({
  type: z.enum(['USER', 'PLATFORM_ADMIN', 'CLIENT', 'SYSTEM']),
  id: z.uuid().nullable(),
  name: z.string().nullable(),
});

/** One audit row; `changes` lists each field written, with its old and new value as recorded (D-019). */
export const AuditEntrySchema = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  actor: AuditActorSchema,
  action: z.enum(AUDIT_ACTIONS),
  entityType: z.string(),
  entityId: z.uuid().nullable(),
  changes: z.array(z.object({ field: z.string(), old: z.unknown(), new: z.unknown() })),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditPageSchema = z.object({
  items: z.array(AuditEntrySchema),
  nextCursor: z.uuid().nullable(),
});
export type AuditPage = z.infer<typeof AuditPageSchema>;
