import { z } from 'zod';

/** An export of the office's data (MVP-106, D-184): a ZIP prepared in the background, downloadable until it expires. */
export const OfficeExportSchema = z.object({
  id: z.uuid(),
  status: z.enum(['QUEUED', 'RUNNING', 'READY', 'FAILED']),
  requestedBy: z.object({ id: z.uuid(), fullName: z.string() }),
  sizeBytes: z.string().regex(/^\d+$/).nullable(),
  /** SHA-256 of the ZIP (hex), to check the download. */
  checksum: z.string().nullable(),
  errorCode: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type OfficeExport = z.infer<typeof OfficeExportSchema>;

/** `GET /offices/me/exports/:id/download`: a short link (D-013), asked for each time. */
export const OfficeExportDownloadSchema = z.object({
  downloadUrl: z.url(),
  expiresIn: z.number().int().positive(),
});
export type OfficeExportDownload = z.infer<typeof OfficeExportDownloadSchema>;
