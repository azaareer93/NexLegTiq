/** What an AI job or output is about (D-039, D-130). Mirrors the Prisma enum; labels: `enums.aiSourceType.<VALUE>`. */
export const AI_SOURCE_TYPES = [
  'DOCUMENT',
  'SESSION',
  'WITNESS_STATEMENT',
  'COURT_RULING',
  'OPPOSING_BRIEF',
] as const;
export type AiSourceType = (typeof AI_SOURCE_TYPES)[number];

/** State of an AI job (D-130). Mirrors the Prisma enum; labels: `enums.aiJobStatus.<VALUE>`. */
export const AI_JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export type AiJobStatus = (typeof AI_JOB_STATUSES)[number];

/** Why a user rated an AI answer badly (MVP-88). Mirrors the Prisma enum; labels: `enums.aiFeedbackReason.<VALUE>`. */
export const AI_FEEDBACK_REASONS = [
  'INACCURATE',
  'MISSING_INFO',
  'WRONG_LANGUAGE',
  'PII_LEAK',
  'OTHER',
] as const;
export type AiFeedbackReason = (typeof AI_FEEDBACK_REASONS)[number];
