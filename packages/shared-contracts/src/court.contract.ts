import { COURT_REPORT_STATUSES, COURT_TYPES, JURISDICTIONS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { EmailSchema, longText, PhoneSchema, plainText, searchText } from './fields.js';

const page = z.coerce.number().int().min(1).max(10_000).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(50);
const atLeastOne = (body: object) => Object.keys(body).length > 0;

/** Editable columns of a platform court (D-037, D-266). Offices only read courts. */
const courtFields = {
  jurisdiction: z.enum(JURISDICTIONS),
  courtType: z.enum(COURT_TYPES),
  nameAr: plainText(200),
  nameEn: plainText(200),
  city: plainText(100),
  address: longText(500),
  phone: PhoneSchema,
  email: EmailSchema,
};

/** `POST admin/courts`: a platform court of a country. The English name is the platform key (D-115), so required. */
export const CreateCourtSchema = z.object({
  jurisdiction: courtFields.jurisdiction,
  courtType: courtFields.courtType,
  nameAr: courtFields.nameAr,
  nameEn: courtFields.nameEn,
  city: courtFields.city.optional(),
  address: courtFields.address.optional(),
  phone: courtFields.phone.optional(),
  email: courtFields.email.optional(),
});
export type CreateCourtRequest = z.infer<typeof CreateCourtSchema>;

/**
 * `PATCH admin/courts/:id` (platform courts only): any subset, `null` clears an optional field; `isActive: false` hides
 * the court from new selections (D-266). The country is fixed once created.
 */
export const UpdateCourtSchema = z
  .object({
    courtType: courtFields.courtType,
    nameAr: courtFields.nameAr,
    nameEn: courtFields.nameEn,
    city: courtFields.city.nullable(),
    address: courtFields.address.nullable(),
    phone: courtFields.phone.nullable(),
    email: courtFields.email.nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine(atLeastOne, 'validation.required');
export type UpdateCourtRequest = z.infer<typeof UpdateCourtSchema>;

/** `GET /courts`: the active platform courts of the office's country, by Arabic name (D-266). */
export const CourtQuerySchema = z.object({
  courtType: z.enum(COURT_TYPES).optional(),
  /** Part of the Arabic or English name or the city (case-insensitive). */
  search: searchText(100).optional(),
  page,
  limit,
});
export type CourtQuery = z.infer<typeof CourtQuerySchema>;

/** `GET admin/courts`: a country's platform courts, inactive ones included. */
export const AdminCourtQuerySchema = CourtQuerySchema.extend({
  jurisdiction: courtFields.jurisdiction,
});
export type AdminCourtQuery = z.infer<typeof AdminCourtQuerySchema>;

export const CourtSchema = z.object({
  id: z.uuid(),
  jurisdiction: z.enum(JURISDICTIONS),
  courtType: z.enum(COURT_TYPES),
  nameAr: z.string(),
  nameEn: z.string().nullable(),
  city: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** A platform court; `false` = an office's own legacy court, read-only (D-266). */
  isPlatform: z.boolean(),
  /** A deactivated court stays on the files and sessions that have it. */
  isActive: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Court = z.infer<typeof CourtSchema>;

/** `GET admin/office-courts`: offices' own courts, which the admin replaces or promotes (D-266). */
export const AdminOfficeCourtQuerySchema = z.object({
  /** Part of the court's Arabic or English name, its city or the office's name (case-insensitive). */
  search: searchText(100).optional(),
  page,
  limit,
});
export type AdminOfficeCourtQuery = z.infer<typeof AdminOfficeCourtQuerySchema>;

export const OfficeCourtSchema = CourtSchema.extend({
  officeId: z.uuid(),
  officeName: z.string(),
  fileCount: z.number().int(),
  sessionCount: z.number().int(),
  judgeCount: z.number().int(),
});
export type OfficeCourt = z.infer<typeof OfficeCourtSchema>;

/** `POST admin/office-courts/:id/replace`: a platform court of the same country takes the office court's place. */
export const ReplaceOfficeCourtSchema = z.object({ courtId: z.uuid() });
export type ReplaceOfficeCourtRequest = z.infer<typeof ReplaceOfficeCourtSchema>;

/** What a replace re-pointed. */
export const ReplaceOfficeCourtResultSchema = z.object({
  courtId: z.uuid(),
  files: z.number().int(),
  sessions: z.number().int(),
  judges: z.number().int(),
});
export type ReplaceOfficeCourtResult = z.infer<typeof ReplaceOfficeCourtResultSchema>;

/** `POST admin/office-courts/:id/promote`: the English name, required when the office court has none. */
export const PromoteOfficeCourtSchema = z.object({ nameEn: courtFields.nameEn.optional() });
export type PromoteOfficeCourtRequest = z.infer<typeof PromoteOfficeCourtSchema>;

/** `POST /court-reports`: a court the office could not find in its picker (D-266). */
export const ReportCourtSchema = z.object({
  name: plainText(200),
  city: plainText(100).optional(),
  note: longText(1000).optional(),
});
export type ReportCourtRequest = z.infer<typeof ReportCourtSchema>;

export const CourtReportSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  city: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(COURT_REPORT_STATUSES),
  createdAt: z.iso.datetime(),
});
export type CourtReport = z.infer<typeof CourtReportSchema>;

/** `GET admin/court-reports`: oldest first, all statuses unless one is asked for. */
export const AdminCourtReportQuerySchema = z.object({
  status: z.enum(COURT_REPORT_STATUSES).optional(),
  page,
  limit,
});
export type AdminCourtReportQuery = z.infer<typeof AdminCourtReportQuerySchema>;

export const AdminCourtReportSchema = CourtReportSchema.extend({
  officeId: z.uuid(),
  officeName: z.string(),
  /** The office's country: an added court belongs to it. */
  jurisdiction: z.enum(JURISDICTIONS),
  reportedByName: z.string(),
  courtId: z.uuid().nullable(),
  dismissReason: z.string().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type AdminCourtReport = z.infer<typeof AdminCourtReportSchema>;

/** `POST admin/court-reports/:id/add`: the platform court to create, in the reporting office's country. */
export const AddReportedCourtSchema = CreateCourtSchema.omit({ jurisdiction: true });
export type AddReportedCourtRequest = z.infer<typeof AddReportedCourtSchema>;

/** `POST admin/court-reports/:id/dismiss`: an optional reason the office reads. */
export const DismissCourtReportSchema = z.object({ reason: longText(500).optional() });
export type DismissCourtReportRequest = z.infer<typeof DismissCourtReportSchema>;

/** `POST /courts/:id/judges`: a judge of the office, at a platform court or one of the office's. */
export const CreateJudgeSchema = z.object({
  fullName: plainText(200),
  notes: longText(2000).optional(),
});
export type CreateJudgeRequest = z.infer<typeof CreateJudgeSchema>;

/** `PATCH /courts/:id/judges/:judgeId` (office judges only). A judge never moves to another court. */
export const UpdateJudgeSchema = z
  .object({
    fullName: plainText(200),
    isActive: z.boolean(),
    notes: longText(2000).nullable(),
  })
  .partial()
  .refine(atLeastOne, 'validation.required');
export type UpdateJudgeRequest = z.infer<typeof UpdateJudgeSchema>;

export const JudgeSchema = z.object({
  id: z.uuid(),
  courtId: z.uuid(),
  fullName: z.string(),
  isActive: z.boolean(),
  notes: z.string().nullable(),
  isPlatform: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Judge = z.infer<typeof JudgeSchema>;

const prosecutorFields = {
  fullName: plainText(200),
  /** The prosecution office, e.g. نيابة رام الله. */
  officeName: plainText(200),
  phone: PhoneSchema,
  email: EmailSchema,
};

/** `POST /prosecutors`. */
export const CreateProsecutorSchema = z.object({
  fullName: prosecutorFields.fullName,
  officeName: prosecutorFields.officeName.optional(),
  phone: prosecutorFields.phone.optional(),
  email: prosecutorFields.email.optional(),
});
export type CreateProsecutorRequest = z.infer<typeof CreateProsecutorSchema>;

/** `PATCH /prosecutors/:id`: any subset, `null` clears an optional field. */
export const UpdateProsecutorSchema = z
  .object({
    fullName: prosecutorFields.fullName,
    officeName: prosecutorFields.officeName.nullable(),
    phone: prosecutorFields.phone.nullable(),
    email: prosecutorFields.email.nullable(),
  })
  .partial()
  .refine(atLeastOne, 'validation.required');
export type UpdateProsecutorRequest = z.infer<typeof UpdateProsecutorSchema>;

/** `GET /prosecutors`: by name. */
export const ProsecutorQuerySchema = z.object({
  /** Part of the name or the prosecution office (case-insensitive). */
  search: searchText(100).optional(),
  page,
  limit,
});
export type ProsecutorQuery = z.infer<typeof ProsecutorQuerySchema>;

export const ProsecutorSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  officeName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Prosecutor = z.infer<typeof ProsecutorSchema>;
