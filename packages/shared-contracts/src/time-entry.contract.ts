import { z } from 'zod';

import { plainText } from './fields.js';

const DateOnlySchema = z.iso.date();
const BooleanQuery = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

/** Hours as a decimal string (D-017): more than 0, at most 24, two decimals at most. */
export const HoursSchema = z
  .string()
  .trim()
  .regex(/^\d{1,2}(\.\d{1,2})?$/, 'validation.hours')
  .refine((value) => Number(value) > 0 && Number(value) <= 24, 'validation.hours');

const DescriptionSchema = plainText(2000).pipe(z.string().min(1, 'validation.required'));

/** `POST /time-entries` (D-152): work the caller did on a file. `workDate` defaults to today in the office's zone. */
export const CreateTimeEntrySchema = z.object({
  fileId: z.uuid(),
  workDate: DateOnlySchema.optional(),
  durationHours: HoursSchema,
  description: DescriptionSchema,
  isBillable: z.boolean().default(true),
});
export type CreateTimeEntryRequest = z.input<typeof CreateTimeEntrySchema>;

/** `PATCH /time-entries/:id`: what was worked; the file, author and rate stay. */
export const UpdateTimeEntrySchema = z
  .object({
    workDate: DateOnlySchema,
    durationHours: HoursSchema,
    description: DescriptionSchema,
    isBillable: z.boolean(),
  })
  .partial();
export type UpdateTimeEntryRequest = z.infer<typeof UpdateTimeEntrySchema>;

export const TimeEntryQuerySchema = z.object({
  fileId: z.uuid().optional(),
  userId: z.uuid().optional(),
  from: DateOnlySchema.optional(),
  to: DateOnlySchema.optional(),
  billable: BooleanQuery,
  invoiced: BooleanQuery,
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type TimeEntryQuery = z.infer<typeof TimeEntryQuerySchema>;

/**
 * One entry. `hourlyRate` and `amount` (hours × rate, a decimal string) are null for readers without invoice rights
 * (D-096) and when no rate applies.
 */
export const TimeEntrySchema = z.object({
  id: z.uuid(),
  file: z.object({ id: z.uuid(), fileNumber: z.string(), title: z.string() }),
  user: z.object({ id: z.uuid(), fullName: z.string() }),
  workDate: DateOnlySchema,
  durationHours: z.string(),
  description: z.string(),
  isBillable: z.boolean(),
  hourlyRate: z.string().nullable(),
  amount: z.string().nullable(),
  currency: z.string(),
  invoiced: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TimeEntry = z.infer<typeof TimeEntrySchema>;

/** `POST /time-entries/timer/start`. */
export const StartTimerSchema = z.object({
  fileId: z.uuid(),
  description: plainText(2000).optional(),
});
export type StartTimerRequest = z.infer<typeof StartTimerSchema>;

/** `POST /time-entries/timer/stop`: the description is required by then (the entry needs one). */
export const StopTimerSchema = z.object({
  description: DescriptionSchema.optional(),
  isBillable: z.boolean().default(true),
});
export type StopTimerRequest = z.input<typeof StopTimerSchema>;

export const TimerSchema = z.object({
  id: z.uuid(),
  file: z.object({ id: z.uuid(), fileNumber: z.string(), title: z.string() }),
  description: z.string().nullable(),
  startedAt: z.iso.datetime(),
});
export type Timer = z.infer<typeof TimerSchema>;

/** `GET /cases/:id/time-totals`: amounts are null for readers without invoice rights. */
export const TimeTotalsSchema = z.object({
  currency: z.string(),
  billableHours: z.string(),
  nonBillableHours: z.string(),
  unbilledHours: z.string(),
  billableAmount: z.string().nullable(),
  unbilledAmount: z.string().nullable(),
});
export type TimeTotals = z.infer<typeof TimeTotalsSchema>;
