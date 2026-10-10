import { COURT_TYPES, JURISDICTIONS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { EmailSchema, longText, PhoneSchema, plainText, searchText } from './fields.js';

const page = z.coerce.number().int().min(1).max(10_000).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(50);
const atLeastOne = (body: object) => Object.keys(body).length > 0;

/** Editable columns of an office's own court (D-037, D-115). Platform courts are read-only. */
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

/** `POST /courts`: an office court. The jurisdiction defaults to the office's. */
export const CreateCourtSchema = z.object({
  jurisdiction: courtFields.jurisdiction.optional(),
  courtType: courtFields.courtType,
  nameAr: courtFields.nameAr,
  nameEn: courtFields.nameEn.optional(),
  city: courtFields.city.optional(),
  address: courtFields.address.optional(),
  phone: courtFields.phone.optional(),
  email: courtFields.email.optional(),
});
export type CreateCourtRequest = z.infer<typeof CreateCourtSchema>;

/** `PATCH /courts/:id` (office courts only; a platform court → 403): any subset, `null` clears an optional field. */
export const UpdateCourtSchema = z
  .object({
    jurisdiction: courtFields.jurisdiction,
    courtType: courtFields.courtType,
    nameAr: courtFields.nameAr,
    nameEn: courtFields.nameEn.nullable(),
    city: courtFields.city.nullable(),
    address: courtFields.address.nullable(),
    phone: courtFields.phone.nullable(),
    email: courtFields.email.nullable(),
  })
  .partial()
  .refine(atLeastOne, 'validation.required');
export type UpdateCourtRequest = z.infer<typeof UpdateCourtSchema>;

/** `GET /courts`: platform courts and the office's own, by Arabic name. */
export const CourtQuerySchema = z.object({
  jurisdiction: z.enum(JURISDICTIONS).optional(),
  courtType: z.enum(COURT_TYPES).optional(),
  /** Part of the Arabic or English name or the city (case-insensitive). */
  search: searchText(100).optional(),
  page,
  limit,
});
export type CourtQuery = z.infer<typeof CourtQuerySchema>;

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
  /** A platform court: read-only for offices. */
  isPlatform: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Court = z.infer<typeof CourtSchema>;

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
