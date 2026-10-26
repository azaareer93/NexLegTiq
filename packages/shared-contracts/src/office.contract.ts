import {
  ACCOUNT_TYPES,
  BILLING_METHODS,
  JURISDICTIONS,
  OFFICE_LANGUAGES,
} from '@nexlegtiq/shared-types';
import { z } from 'zod';

import {
  CurrencySchema,
  EmailSchema,
  longText,
  MoneySchema,
  PhoneSchema,
  plainText,
  searchText,
  TimeZoneSchema,
} from './fields.js';

/** An optional profile field: `null` (or an empty string) clears it. */
const clearable = <T extends z.ZodType<string | null>>(schema: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? null : value),
    schema.nullable(),
  );

/** No control or bidi characters (as `plainText`), then an http(s) URL. */
const WebsiteSchema = searchText(200).pipe(
  z.url({ protocol: /^https?$/, error: 'validation.website' }),
);

/** `GET /offices/me` (D-125): the office's profile and regional defaults. */
export const OfficeProfileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  registrationNumber: z.string().nullable(),
  taxId: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  website: z.string().nullable(),
  jurisdiction: z.enum(JURISDICTIONS),
  accountType: z.enum(ACCOUNT_TYPES),
  defaultLanguage: z.enum(OFFICE_LANGUAGES),
  currency: z.string(),
  timezone: z.string(),
});
export type OfficeProfile = z.infer<typeof OfficeProfileSchema>;

/** `PATCH /offices/me`: only the fields sent change; `null` or `''` clears an optional one. */
export const UpdateOfficeProfileSchema = z
  .object({
    name: plainText(200),
    registrationNumber: clearable(plainText(50)),
    taxId: clearable(plainText(50)),
    phone: clearable(PhoneSchema),
    email: clearable(EmailSchema),
    address: clearable(longText(500)),
    website: clearable(WebsiteSchema),
    jurisdiction: z.enum(JURISDICTIONS),
    defaultLanguage: z.enum(OFFICE_LANGUAGES),
    currency: CurrencySchema,
    timezone: TimeZoneSchema,
  })
  .partial();
export type UpdateOfficeProfileRequest = z.infer<typeof UpdateOfficeProfileSchema>;

/** Reminder offsets in days: each once, at most 10, stored largest first (7, 3, 1). */
const reminderDays = (min: number, minEntries: number) =>
  z
    .array(
      z.number().int().min(min, 'validation.reminderRange').max(30, 'validation.reminderRange'),
    )
    .min(minEntries, 'validation.required')
    .max(10, 'validation.tooLong')
    .refine((days) => new Set(days).size === days.length, 'validation.duplicate')
    .transform((days) => [...days].sort((a, b) => b - a));

/**
 * `fileNumberFormat` (D-031, D-095): `{YEAR}`, `{TYPE}` and exactly one `{SEQ}` / `{SEQ:n}` (n 1–9) between letters,
 * Western digits, spaces and `. _ / # -`, at most 64 characters. The backend's `parseFileNumberFormat` applies the
 * same rules (a test keeps them in step).
 */
const FILE_NUMBER_FORMAT = /^(?:[\p{L}0-9 ._/#-]|\{YEAR\}|\{TYPE\}|\{SEQ(?::[1-9])?\})*$/u;
export const FileNumberFormatSchema = z
  .string()
  .trim()
  .min(1, 'validation.required')
  .max(64, 'validation.tooLong')
  .refine(
    (format) =>
      FILE_NUMBER_FORMAT.test(format) && (format.match(/\{SEQ(?::[1-9])?\}/g) ?? []).length === 1,
    'validation.fileNumberFormat',
  );

/** A percentage with at most 2 decimals, 0–100 (`Decimal(5,2)`). */
const PercentSchema = z
  .string()
  .trim()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'validation.percent')
  .refine((value) => Number(value) <= 100, 'validation.percent');

/** `GET /offices/me/settings` (D-125). Money and the tax rate are decimal strings (D-017). */
export const OfficeSettingsSchema = z.object({
  courtReminderDays: z.array(z.number().int()),
  taskReminderDays: z.array(z.number().int()),
  defaultBillingRate: z.string().nullable(),
  defaultBillingMethod: z.enum(BILLING_METHODS),
  taxRatePercent: z.string(),
  enableAi: z.boolean(),
  enableOcr: z.boolean(),
  /** Google Vision for hard-to-read scans (D-142): off by default, also needs the plan flag `googleVisionOcr`. */
  enableVisionOcr: z.boolean(),
  fileNumberFormat: z.string(),
  sessionIdleMinutes: z.number().int(),
  auditRetentionDays: z.number().int(),
});
export type OfficeSettings = z.infer<typeof OfficeSettingsSchema>;

/** `PATCH /offices/me/settings`: only the fields sent change. */
export const UpdateOfficeSettingsSchema = z
  .object({
    /** Hearing reminders: 1–30 days before, at least one. */
    courtReminderDays: reminderDays(1, 1),
    /** Task reminders: 0 (the due day) to 30 days before; none is allowed. */
    taskReminderDays: reminderDays(0, 0),
    defaultBillingRate: clearable(MoneySchema),
    defaultBillingMethod: z.enum(BILLING_METHODS),
    taxRatePercent: PercentSchema,
    enableAi: z.boolean(),
    enableOcr: z.boolean(),
    enableVisionOcr: z.boolean(),
    fileNumberFormat: FileNumberFormatSchema,
    /** D-053: 15–120 (CHECK on the column). */
    sessionIdleMinutes: z
      .number()
      .int()
      .min(15, 'validation.idleMinutes')
      .max(120, 'validation.idleMinutes'),
    /** D-060: at least a year, office-configurable upward only (CHECK `>= 365`); at most ten years. */
    auditRetentionDays: z
      .number()
      .int()
      .min(365, 'validation.auditRetention')
      .max(3650, 'validation.auditRetention'),
  })
  .partial();
export type UpdateOfficeSettingsRequest = z.infer<typeof UpdateOfficeSettingsSchema>;
