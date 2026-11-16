import { z } from 'zod';

/** `ocr` queue: scan an uploaded version with ClamAV (D-126). */
export const SCAN_DOCUMENT_JOB = 'scan-document';
/** `ocr` queue: extract the text of a clean version (the text-extraction story handles it). */
export const PROCESS_DOCUMENT_JOB = 'process-document';

export const DocumentJobSchema = z.object({
  documentId: z.uuid(),
  versionNumber: z.number().int().min(1),
});
export type DocumentJob = z.infer<typeof DocumentJobSchema>;

/** One job per version and step: a retried enqueue never scans or processes a version twice. */
export const documentJobId = (step: 'scan' | 'process', job: DocumentJob) =>
  `${step}-${job.documentId}-v${job.versionNumber}`;

/**
 * Where every new version starts: scanned first, text pending, and no error code — an old failure must never send a
 * retry of the new version past its scan (D-132).
 */
export const NEW_VERSION_STATE = {
  status: 'SCANNING',
  ocrStatus: 'PENDING',
  processingErrorCode: null,
} as const;

/** `ocr` queue: scan a document a client sent through the portal (D-187); one job per upload. */
export const SCAN_CLIENT_UPLOAD_JOB = 'scan-client-upload';
export const ClientUploadJobSchema = z.object({ uploadId: z.uuid() });
export type ClientUploadJob = z.infer<typeof ClientUploadJobSchema>;
export const clientUploadJobId = (job: ClientUploadJob) => `scan-upload-${job.uploadId}`;
