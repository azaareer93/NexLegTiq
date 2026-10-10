import {
  BILLING_METHODS,
  CLIENT_TYPES,
  FILE_STATUSES,
  FILE_TEAM_ROLES,
  FILE_TYPES,
  JURISDICTIONS,
  PRIORITIES,
} from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, MoneySchema, plainText, searchText, sortParam } from './fields.js';

/**
 * `POST /cases` (W6, D-095/D-096). The number, office, currency, jurisdiction and opening date come from the server;
 * the responsible lawyer and paralegal also join the file's team. The court and judge arrive with the courts story.
 */
export const CreateCaseSchema = z
  .object({
    title: plainText(300),
    description: longText(5000).optional(),
    fileType: z.enum(FILE_TYPES),
    subType: plainText(100).optional(),
    clientIds: z
      .array(z.uuid())
      .min(1, 'validation.required')
      .max(20, 'validation.tooLong')
      .refine((ids) => new Set(ids).size === ids.length, 'validation.duplicate'),
    primaryClientId: z.uuid(),
    responsibleLawyerId: z.uuid(),
    responsibleParalegalId: z.uuid().optional(),
    priority: z.enum(PRIORITIES).default('MEDIUM'),
    /** Defaults to the office's billing method. */
    billingMethod: z.enum(BILLING_METHODS).optional(),
    /** Defaults to the office's billing rate for an hourly file. */
    hourlyRate: MoneySchema.optional(),
    fixedFee: MoneySchema.optional(),
    courtCaseNumber: plainText(100).optional(),
    isConfidential: z.boolean().default(false),
  })
  .refine((body) => body.clientIds.includes(body.primaryClientId), {
    message: 'validation.primaryClient',
    path: ['primaryClientId'],
  });
export type CreateCaseRequest = z.infer<typeof CreateCaseSchema>;

/**
 * `PATCH /cases/:id`. The number, type, status (close/reopen/archive routes) and the team (team routes) are not edited
 * here; `null` clears an optional field.
 */
export const UpdateCaseSchema = z
  .object({
    title: plainText(300),
    description: longText(5000).nullable(),
    subType: plainText(100).nullable(),
    priority: z.enum(PRIORITIES),
    billingMethod: z.enum(BILLING_METHODS),
    hourlyRate: MoneySchema.nullable(),
    fixedFee: MoneySchema.nullable(),
    courtCaseNumber: plainText(100).nullable(),
    isConfidential: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateCaseRequest = z.infer<typeof UpdateCaseSchema>;

export const CASE_SORT_FIELDS = [
  'updatedAt',
  'createdAt',
  'openingDate',
  'fileNumber',
  'title',
  'priority',
  'status',
] as const;
export type CaseSortField = (typeof CASE_SORT_FIELDS)[number];

/** `GET /cases` query (api-conventions.md): filters, `scope=mine|all`, `sort=field:dir,…`, `page`, `limit` ≤ 100. */
export const CaseQuerySchema = z.object({
  status: z.enum(FILE_STATUSES).optional(),
  fileType: z.enum(FILE_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  /** `mine`: only files assigned to the caller, even with `view:all:cases`. */
  scope: z.enum(['mine', 'all']).default('all'),
  search: searchText(100).optional(),
  clientId: z.uuid().optional(),
  responsibleLawyerId: z.uuid().optional(),
  sort: sortParam(CASE_SORT_FIELDS).default([{ field: 'updatedAt', direction: 'desc' }]),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CaseQuery = z.infer<typeof CaseQuerySchema>;

const PersonSchema = z.object({ id: z.uuid(), fullName: z.string() });
/** Calendar date `YYYY-MM-DD` (D-092: shown as written in every time zone). */
const DateOnlySchema = z.iso.date();

/** A row of `GET /cases`. Next hearing and document/task counts join with their stories. */
export const CaseListItemSchema = z.object({
  id: z.uuid(),
  fileNumber: z.string(),
  title: z.string(),
  fileType: z.enum(FILE_TYPES),
  status: z.enum(FILE_STATUSES),
  priority: z.enum(PRIORITIES),
  openingDate: DateOnlySchema,
  isConfidential: z.boolean(),
  primaryClient: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  responsibleLawyer: PersonSchema,
  updatedAt: z.iso.datetime(),
});
export type CaseListItem = z.infer<typeof CaseListItemSchema>;

/** `GET /cases/:id` (and the answer of create/update): the Details tab; heavy tabs load separately. */
export const CaseSchema = CaseListItemSchema.extend({
  description: z.string().nullable(),
  subType: z.string().nullable(),
  closingDate: DateOnlySchema.nullable(),
  responsibleParalegal: PersonSchema.nullable(),
  courtCaseNumber: z.string().nullable(),
  jurisdiction: z.enum(JURISDICTIONS),
  /** Billing terms are `null` for a caller without an invoice permission (D-096). */
  billingMethod: z.enum(BILLING_METHODS).nullable(),
  hourlyRate: z.string().nullable(),
  fixedFee: z.string().nullable(),
  retainerBalance: z.string().nullable(),
  currency: z.string(),
  clients: z.array(
    z.object({
      id: z.uuid(),
      displayName: z.string(),
      clientType: z.enum(CLIENT_TYPES),
      isPrimary: z.boolean(),
    }),
  ),
  team: z.array(PersonSchema.extend({ role: z.enum(FILE_TEAM_ROLES) })),
  counts: z.object({ parties: z.number().int(), notes: z.number().int() }),
  createdAt: z.iso.datetime(),
});
export type Case = z.infer<typeof CaseSchema>;
