import { DOCUMENT_STATUSES, DOCUMENT_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, plainText } from './fields.js';

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
