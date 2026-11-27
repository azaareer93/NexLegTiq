import {
  BILLING_METHODS,
  CLIENT_TYPES,
  COURT_TYPES,
  FILE_STATUSES,
  FILE_TEAM_ROLES,
  JURISDICTIONS,
  PRIORITIES,
} from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, MoneySchema, plainText, searchText, sortParam } from './fields.js';
import { FileSubTypeSchema, FileTypeCodeSchema } from './legal-file-type.contract.js';

/**
 * `POST /cases` (W6, D-095/D-096). The number, office, currency, jurisdiction and opening date come from the server;
 * the responsible lawyer and paralegal also join the file's team. The court is a platform court or one of the office's;
 * the judge sits at that court (D-115).
 */
export const CreateCaseSchema = z
  .object({
    title: plainText(300),
    description: longText(5000).optional(),
    /** An active type of the office's country (`GET /file-types`, D-261). */
    fileType: FileTypeCodeSchema,
    /** An active sub-type of that type. */
    subTypeId: z.uuid().optional(),
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
    courtId: z.uuid().optional(),
    /** Requires `courtId`: a judge of that court. */
    judgeId: z.uuid().optional(),
    isConfidential: z.boolean().default(false),
  })
  .refine((body) => body.clientIds.includes(body.primaryClientId), {
    message: 'validation.primaryClient',
    path: ['primaryClientId'],
  })
  .refine((body) => body.judgeId === undefined || body.courtId !== undefined, {
    message: 'validation.unknownJudge',
    path: ['judgeId'],
  });
export type CreateCaseRequest = z.infer<typeof CreateCaseSchema>;

/**
 * `PATCH /cases/:id`. The number, type, status (close/reopen/archive routes) and the team (team routes) are not edited
 * here; `null` clears an optional field. A new `courtId` without `judgeId` clears the judge of the old court.
 */
export const UpdateCaseSchema = z
  .object({
    title: plainText(300),
    description: longText(5000).nullable(),
    /** A sub-type of the file's type (`null` clears it); either way the legacy free text is dropped (D-261). */
    subTypeId: z.uuid().nullable(),
    priority: z.enum(PRIORITIES),
    billingMethod: z.enum(BILLING_METHODS),
    hourlyRate: MoneySchema.nullable(),
    fixedFee: MoneySchema.nullable(),
    courtCaseNumber: plainText(100).nullable(),
    courtId: z.uuid().nullable(),
    judgeId: z.uuid().nullable(),
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
  /** One type code or a comma-separated list (`CONTRACT_DRAFTING,NDA_REVIEW`): the "Contracts" view spans several types. */
  fileType: z
    .string()
    .transform((value) => value.split(',').map((type) => type.trim()))
    .pipe(z.array(FileTypeCodeSchema).min(1).max(50))
    .optional()
    .meta({ description: 'One or more file type codes, comma-separated' }),
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

/** A client of a file (`GET /cases/:id/clients`, D-140); exactly one is primary. */
export const FileClientSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  clientType: z.enum(CLIENT_TYPES),
  isPrimary: z.boolean(),
});
export type FileClient = z.infer<typeof FileClientSchema>;

/** A member of a file's team (`GET /cases/:id/team`, D-140). */
export const FileTeamMemberSchema = PersonSchema.extend({ role: z.enum(FILE_TEAM_ROLES) });
export type FileTeamMember = z.infer<typeof FileTeamMemberSchema>;
/** Calendar date `YYYY-MM-DD` (D-092: shown as written in every time zone). */
const DateOnlySchema = z.iso.date();

/** A row of `GET /cases`. Next hearing and document/task counts join with their stories. */
export const CaseListItemSchema = z.object({
  id: z.uuid(),
  fileNumber: z.string(),
  title: z.string(),
  /** A type code of the file's country, with its names (also when the type was deactivated since). */
  fileType: z.string(),
  fileTypeName: z.object({ nameAr: z.string(), nameEn: z.string() }),
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
  subType: FileSubTypeSchema.nullable(),
  /** Free text from before sub-types were reference data (D-261): read-only. */
  legacySubType: z.string().nullable(),
  closingDate: DateOnlySchema.nullable(),
  responsibleParalegal: PersonSchema.nullable(),
  courtCaseNumber: z.string().nullable(),
  court: z
    .object({
      id: z.uuid(),
      nameAr: z.string(),
      nameEn: z.string().nullable(),
      courtType: z.enum(COURT_TYPES),
    })
    .nullable(),
  judge: PersonSchema.nullable(),
  jurisdiction: z.enum(JURISDICTIONS),
  /** Billing terms are `null` for a caller without an invoice permission (D-096). */
  billingMethod: z.enum(BILLING_METHODS).nullable(),
  hourlyRate: z.string().nullable(),
  fixedFee: z.string().nullable(),
  retainerBalance: z.string().nullable(),
  currency: z.string(),
  clients: z.array(FileClientSchema),
  team: z.array(FileTeamMemberSchema),
  counts: z.object({ parties: z.number().int(), notes: z.number().int() }),
  createdAt: z.iso.datetime(),
});
export type Case = z.infer<typeof CaseSchema>;

/** `POST /cases/:id/clients` (D-140): a live client of the office; `isPrimary` makes it the file's primary client. */
export const AddFileClientSchema = z.object({
  clientId: z.uuid(),
  isPrimary: z.boolean().optional(),
});
export type AddFileClientRequest = z.infer<typeof AddFileClientSchema>;

/** `PATCH /cases/:id/clients/:clientId`: only `true` — making another client primary demotes this one. */
export const UpdateFileClientSchema = z.object({ isPrimary: z.literal(true) });
export type UpdateFileClientRequest = z.infer<typeof UpdateFileClientSchema>;

/**
 * `POST /cases/:id/team` (D-140): an active colleague. RESPONSIBLE_LAWYER replaces the file's responsible lawyer (who
 * stays as a MEMBER), PARALEGAL its responsible paralegal; MEMBER by default.
 */
export const AddTeamMemberSchema = z.object({
  userId: z.uuid(),
  role: z.enum(FILE_TEAM_ROLES).default('MEMBER'),
});
export type AddTeamMemberRequest = z.input<typeof AddTeamMemberSchema>;

/** `PATCH /cases/:id/team/:userId`: a new role on the file (same rules as adding). */
export const UpdateTeamMemberSchema = z.object({ role: z.enum(FILE_TEAM_ROLES) });
export type UpdateTeamMemberRequest = z.infer<typeof UpdateTeamMemberSchema>;

/**
 * `POST /cases/:id/close` (D-153): open tasks block it with 422 BIZ-003 (detail `openTasks`) unless `force` with a
 * `forceReason`.
 */
export const CloseCaseSchema = z
  .object({
    reason: plainText(1000).optional(),
    force: z.boolean().default(false),
    forceReason: plainText(1000).optional(),
  })
  .refine((body) => !body.force || Boolean(body.forceReason?.trim()), {
    path: ['forceReason'],
    message: 'validation.required',
  });
export type CloseCaseRequest = z.input<typeof CloseCaseSchema>;

/** `POST /cases/:id/reassign` (D-153): a new responsible lawyer (OM, SL or L), with an optional note for the timeline. */
export const ReassignCaseSchema = z.object({
  newResponsibleLawyerId: z.uuid(),
  note: plainText(1000).optional(),
});
export type ReassignCaseRequest = z.infer<typeof ReassignCaseSchema>;
