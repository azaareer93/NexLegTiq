import { z } from 'zod';

import { longText } from './fields.js';

/** The grace before the purge (D-251): fixed, the FAQ's promise. Only the office's own written request shortens it. */
export const OFFICE_DELETION_GRACE_DAYS = 30;

/**
 * `POST /offices/me/delete-request` (D-251): the office manager's password again, plus a TOTP code when MFA is on.
 * A wrong password or code → 400 VAL-001 on that field; a deletion already scheduled → 409 RES-003.
 */
export const RequestOfficeDeletionSchema = z.object({
  password: z.string().min(1, 'validation.required').max(256, 'validation.tooLong'),
  mfaCode: z
    .string()
    .regex(/^\d{6}$/, 'validation.totpCode')
    .optional(),
});
export type RequestOfficeDeletionRequest = z.infer<typeof RequestOfficeDeletionSchema>;

/** `GET /offices/me/delete-request`: both null while no deletion is scheduled. */
export const OfficeDeletionStatusSchema = z.object({
  requestedAt: z.iso.datetime().nullable(),
  /** When the purge runs; writes are refused (403 AUTH-105) until then, unless the deletion is cancelled. */
  scheduledFor: z.iso.datetime().nullable(),
});
export type OfficeDeletionStatus = z.infer<typeof OfficeDeletionStatusSchema>;

const reason = longText(500).refine((value) => value.trim().length >= 3, 'validation.required');

/** `POST /admin/offices/:id/deletion/cancel`: the reason is kept in the platform audit log. */
export const AdminCancelDeletionSchema = z.object({ reason });
export type AdminCancelDeletionRequest = z.infer<typeof AdminCancelDeletionSchema>;

/**
 * `POST /admin/offices/:id/deletion/reschedule`: only on the office's written request (its reference in the reason), and
 * only earlier than scheduled and not in the past (400 VAL-001 otherwise).
 */
export const AdminRescheduleDeletionSchema = z.object({
  scheduledFor: z.iso.datetime({ offset: true }),
  reason,
});
export type AdminRescheduleDeletionRequest = z.infer<typeof AdminRescheduleDeletionSchema>;
