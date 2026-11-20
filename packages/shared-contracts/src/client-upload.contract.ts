import { CLIENT_UPLOAD_STATUSES, DOCUMENT_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { OriginalFilenameSchema } from './document.contract.js';

/**
 * Documents a client sends through the portal (MVP-99, D-187). They wait in a review queue, apart from the office's
 * documents, until a lawyer accepts one (it becomes a Document) or rejects it (the reason is shown to the client).
 */

/** `GET /portal/files/:id/uploads` and the 202 of `POST /portal/files/:id/uploads`: the client's own uploads. */
export const PortalUploadSchema = z.object({
  id: z.uuid(),
  fileId: z.uuid(),
  name: z.string(),
  mimeType: z.string(),
  /** Bytes, as text (BigInt). */
  sizeBytes: z.string(),
  status: z.enum(CLIENT_UPLOAD_STATUSES),
  /** Why the office did not take it; null unless REJECTED. */
  rejectionReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type PortalUpload = z.infer<typeof PortalUploadSchema>;

/** `GET /cases/:id/client-uploads`: the file's uploads as the office reviews them (newest first). */
export const ClientUploadSchema = PortalUploadSchema.extend({
  client: z.object({ id: z.uuid(), displayName: z.string() }),
  uploaderName: z.string(),
  reviewedBy: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  reviewedAt: z.iso.datetime().nullable(),
  /** The Document an accepted upload became. */
  documentId: z.uuid().nullable(),
});
export type ClientUpload = z.infer<typeof ClientUploadSchema>;

/** `POST /client-uploads/:id/accept`: file it as a document (default folder: the file's Client Uploads folder). */
export const AcceptClientUploadSchema = z.object({
  documentType: z.enum(DOCUMENT_TYPES),
  folderId: z.uuid().optional(),
  name: OriginalFilenameSchema.optional(),
});
export type AcceptClientUploadRequest = z.infer<typeof AcceptClientUploadSchema>;

/** `POST /client-uploads/:id/reject`: the reason the client will read. */
export const RejectClientUploadSchema = z.object({
  reason: z.string().trim().min(1, 'validation.required').max(500, 'validation.tooLong'),
});
export type RejectClientUploadRequest = z.infer<typeof RejectClientUploadSchema>;
