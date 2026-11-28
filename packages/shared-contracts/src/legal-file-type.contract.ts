import { JURISDICTIONS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { plainText } from './fields.js';

/**
 * Legal file types and sub-types: platform reference data per country (MVP-175, D-261). A file and a task template
 * store the type's `code`; the seeded codes are `FILE_TYPES`, platform staff may add more.
 */
export const FileTypeCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'validation.fileTypeCode');

const Name = plainText(100);
const SortOrder = z.number().int().min(0).max(10_000);

/** A sub-type an office may pick (`GET /file-types`). */
export const FileSubTypeSchema = z.object({ id: z.uuid(), nameAr: z.string(), nameEn: z.string() });
export type FileSubType = z.infer<typeof FileSubTypeSchema>;

/** `GET /file-types`: the active types of the office's country, in order, each with its active sub-types. */
export const FileTypeOptionSchema = z.object({
  code: z.string(),
  nameAr: z.string(),
  nameEn: z.string(),
  subTypes: z.array(FileSubTypeSchema),
});
export type FileTypeOption = z.infer<typeof FileTypeOptionSchema>;

/** `GET /admin/file-types?jurisdiction=` */
export const AdminFileTypeQuerySchema = z.object({ jurisdiction: z.enum(JURISDICTIONS) });
export type AdminFileTypeQuery = z.infer<typeof AdminFileTypeQuerySchema>;

const EditableFields = { nameAr: Name, nameEn: Name, sortOrder: SortOrder, isActive: z.boolean() };

/** `POST /admin/file-types/:id/sub-types` */
export const CreateFileSubTypeSchema = z.object({
  ...EditableFields,
  sortOrder: SortOrder.default(0),
  isActive: z.boolean().default(true),
});
export type CreateFileSubTypeRequest = z.input<typeof CreateFileSubTypeSchema>;

/** `PATCH /admin/file-sub-types/:id` and `PATCH /admin/file-types/:id`: names, order and the active flag. */
export const UpdateFileSubTypeSchema = z
  .object(EditableFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateFileSubTypeRequest = z.infer<typeof UpdateFileSubTypeSchema>;
export const UpdateFileTypeSchema = UpdateFileSubTypeSchema;
export type UpdateFileTypeRequest = UpdateFileSubTypeRequest;

/**
 * `POST /admin/file-types`. The country, code and number code are fixed once created: files store the code, and the
 * number code (`{TYPE}` of the file number, D-031) keys the office's number counter.
 */
export const CreateFileTypeSchema = CreateFileSubTypeSchema.extend({
  jurisdiction: z.enum(JURISDICTIONS),
  code: FileTypeCodeSchema,
  numberCode: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{1,6}$/, 'validation.numberCode'),
});
export type CreateFileTypeRequest = z.input<typeof CreateFileTypeSchema>;

export const AdminFileSubTypeSchema = FileSubTypeSchema.extend({
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type AdminFileSubType = z.infer<typeof AdminFileSubTypeSchema>;

export const AdminFileTypeSchema = z.object({
  id: z.uuid(),
  jurisdiction: z.enum(JURISDICTIONS),
  code: z.string(),
  numberCode: z.string(),
  nameAr: z.string(),
  nameEn: z.string(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  /** Every sub-type, active or not, in order. */
  subTypes: z.array(AdminFileSubTypeSchema),
  updatedAt: z.iso.datetime(),
});
export type AdminFileType = z.infer<typeof AdminFileTypeSchema>;
