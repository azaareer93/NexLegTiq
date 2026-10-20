import { DOCUMENT_STATUSES, DOCUMENT_TYPES, OCR_STATUSES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, plainText, searchText, sortParam } from './fields.js';

/** Largest accepted upload: 50 MiB (D-035). Larger is 413 VAL-006. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** The uploaded file's own name (Arabic allowed, D-035): one line, no control or bidi characters (no `gpj.exe` tricks). */
export const OriginalFilenameSchema = plainText(255);

/** Multipart form values are strings: only the words `true` and `false`. */
const FormBoolean = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * The text fields of `POST /documents` (multipart, D-126). They must come **before** the `file` part, so the file's access
 * is checked before anything is stored.
 */
export const UploadDocumentFieldsSchema = z.object({
  fileId: z.uuid(),
  documentType: z.enum(DOCUMENT_TYPES).default('OTHER'),
  folderId: z.uuid().optional(),
  sessionId: z.uuid().optional(),
  isConfidential: FormBoolean.optional(),
});
export type UploadDocumentFields = z.infer<typeof UploadDocumentFieldsSchema>;

/** The text fields of `POST /documents/:id/versions` (before the `file` part). */
export const UploadVersionFieldsSchema = z.object({
  changeNote: longText(500).optional(),
});
export type UploadVersionFields = z.infer<typeof UploadVersionFieldsSchema>;

/** 202 answer of an upload: the document is scanned, then processed in the background. */
export const DocumentUploadSchema = z.object({
  documentId: z.uuid(),
  versionNumber: z.number().int().min(1),
  status: z.enum(DOCUMENT_STATUSES),
});
export type DocumentUpload = z.infer<typeof DocumentUploadSchema>;

/** One stored upload of a document (`GET /documents/:id/versions`, newest first). */
export const DocumentVersionSchema = z.object({
  versionNumber: z.number().int().min(1),
  originalFilename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  changeNote: z.string().nullable(),
  createdBy: z.object({ id: z.uuid(), fullName: z.string() }),
  createdAt: z.iso.datetime(),
});
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;

const DOCUMENT_SORT_FIELDS = ['name', 'createdAt', 'updatedAt', 'sizeBytes'] as const;

/**
 * `GET /cases/:id/documents` (D-128): live documents of the file the caller may see (confidential ones only for the
 * office manager, their uploader and the file's team). `folderId=root` lists the file's root; `search` matches the name or
 * the uploaded file name.
 */
export const DocumentQuerySchema = z.object({
  folderId: z.union([z.literal('root'), z.uuid()]).optional(),
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  status: z.enum(DOCUMENT_STATUSES).optional(),
  search: searchText(100).optional(),
  sort: sortParam(DOCUMENT_SORT_FIELDS).default([{ field: 'updatedAt', direction: 'desc' }]),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type DocumentQuery = z.infer<typeof DocumentQuerySchema>;

/** A document as listed and opened: its current version's facts, never its storage key. */
export const DocumentSchema = z.object({
  id: z.uuid(),
  fileId: z.uuid(),
  folderId: z.uuid().nullable(),
  sessionId: z.uuid().nullable(),
  name: z.string(),
  originalFilename: z.string(),
  documentType: z.enum(DOCUMENT_TYPES),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  currentVersion: z.number().int().min(1),
  status: z.enum(DOCUMENT_STATUSES),
  ocrStatus: z.enum(OCR_STATUSES),
  isConfidential: z.boolean(),
  sharedWithClient: z.boolean(),
  uploadedBy: z.object({ id: z.uuid(), fullName: z.string() }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Document = z.infer<typeof DocumentSchema>;

/** `PATCH /documents/:id`: rename, retype, move (`folderId: null` = the file's root) or mark confidential. */
export const UpdateDocumentSchema = z
  .object({
    name: OriginalFilenameSchema,
    documentType: z.enum(DOCUMENT_TYPES),
    folderId: z.uuid().nullable(),
    isConfidential: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateDocumentRequest = z.infer<typeof UpdateDocumentSchema>;

/** `GET /documents/:id/download?version=`: the current version (another version is 404 until versions carry their scan result, D-128). */
export const DownloadQuerySchema = z.object({
  version: z.coerce.number().int().min(1).max(10_000).optional(),
});
export type DownloadQuery = z.infer<typeof DownloadQuerySchema>;

/** A short-lived link (D-013: JSON, not a redirect, so the app can show errors); the file downloads under its own name. */
export const DownloadLinkSchema = z.object({
  downloadUrl: z.url(),
  expiresIn: z.number().int().min(1),
});
export type DownloadLink = z.infer<typeof DownloadLinkSchema>;

/** `GET /documents/:id/text?page=`: the current version's extracted text, 20,000 characters a page. */
export const DocumentTextQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});
export type DocumentTextQuery = z.infer<typeof DocumentTextQuerySchema>;

export const DocumentTextSchema = z.object({
  versionNumber: z.number().int().min(1),
  ocrStatus: z.enum(OCR_STATUSES),
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
  text: z.string(),
});
export type DocumentText = z.infer<typeof DocumentTextSchema>;
