import { MAX_UPLOAD_BYTES } from '@nexlegtiq/shared-contracts';
import type { Document } from '@nexlegtiq/shared-contracts';

/** Extensions the API accepts (D-035); the API sniffs the bytes again, this only saves a doomed upload. */
export const ACCEPTED_EXTENSIONS = [
  'pdf',
  'docx',
  'doc',
  'jpg',
  'jpeg',
  'png',
  'tif',
  'tiff',
  'xlsx',
  'csv',
] as const;
export const ACCEPT_ATTRIBUTE = ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(',');

export type UploadProblem = 'type' | 'size' | 'empty';

/** Why a picked file cannot be uploaded, or null when it can. */
export function uploadProblem(file: {
  readonly name: string;
  readonly size: number;
}): UploadProblem | null {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (!file.name.includes('.') || !(ACCEPTED_EXTENSIONS as readonly string[]).includes(ext))
    return 'type';
  if (file.size === 0) return 'empty';
  if (file.size > MAX_UPLOAD_BYTES) return 'size';
  return null;
}

/** One picked file in the upload panel. */
export interface UploadItem {
  readonly key: string;
  readonly file: File;
  readonly state: 'waiting' | 'uploading' | 'done' | 'error' | 'refused';
  /** 0–1 while uploading. */
  readonly progress: number;
  readonly problem?: UploadProblem;
  /** Error code of a failed upload (`errors.<code>`). */
  readonly errorCode?: string;
}

export const newItem = (file: File, key: string): UploadItem => {
  const problem = uploadProblem(file);
  return problem
    ? { key, file, state: 'refused', progress: 0, problem }
    : { key, file, state: 'waiting', progress: 0 };
};

/** Statuses on their way to READY: the list refreshes itself while any are shown (D-133, fallback to the socket). */
export const PENDING_STATUSES: ReadonlySet<Document['status']> = new Set([
  'UPLOADED',
  'SCANNING',
  'PROCESSING',
]);

/** Status tag tone per document status. */
export const STATUS_TONE = {
  UPLOADED: 'info',
  SCANNING: 'info',
  PROCESSING: 'info',
  READY: 'success',
  FAILED: 'error',
  QUARANTINED: 'error',
} as const satisfies Record<Document['status'], 'info' | 'success' | 'error'>;

/** A FAILED document whose failure a retry may fix (EXT-002, or a failed scan without code — D-132). */
export const retryable = (document: Pick<Document, 'status' | 'processingErrorCode'>): boolean =>
  document.status === 'FAILED' && document.processingErrorCode !== 'VAL-005';
