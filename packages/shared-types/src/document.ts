/** Kinds of document (domain-model.md#documents--ocr). Mirrors the Prisma enum; labels: `enums.documentType.<VALUE>`. */
export const DOCUMENT_TYPES = [
  'PLEADING',
  'EVIDENCE',
  'CONTRACT_DRAFT',
  'FINAL_CONTRACT',
  'WILL',
  'NDA',
  'COURT_ORDER',
  'JUDGMENT',
  'CLIENT_INSTRUCTION',
  'INVOICE',
  'LEGAL_NOTICE',
  'DEMAND_LETTER',
  'POWER_OF_ATTORNEY',
  'CORRESPONDENCE',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Processing state of a document. Mirrors the Prisma enum; labels: `enums.documentStatus.<VALUE>`. */
export const DOCUMENT_STATUSES = [
  'UPLOADED',
  'SCANNING',
  'PROCESSING',
  'READY',
  'FAILED',
  'QUARANTINED',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Text extraction state. Mirrors the Prisma enum; labels: `enums.ocrStatus.<VALUE>`. */
export const OCR_STATUSES = ['NOT_NEEDED', 'PENDING', 'DONE', 'FAILED'] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];

/** Language of a document's text. Mirrors the Prisma enum; labels: `enums.documentLanguage.<VALUE>`. */
export const DOCUMENT_LANGUAGES = ['AR', 'EN', 'MIXED'] as const;
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number];

/**
 * The default folders of every file, in display order (D-119). Mirrors the Prisma enum; a system folder's name is the
 * label `enums.folderSystemKey.<VALUE>`, never stored.
 */
export const FOLDER_SYSTEM_KEYS = [
  'PLEADINGS',
  'EVIDENCE',
  'COURT_ORDERS',
  'CONTRACTS',
  'CORRESPONDENCE',
  'CLIENT_UPLOADS',
] as const;
export type FolderSystemKey = (typeof FOLDER_SYSTEM_KEYS)[number];
