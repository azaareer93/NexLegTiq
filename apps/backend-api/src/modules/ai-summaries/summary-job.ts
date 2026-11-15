/** The `ai` job that summarises a document (D-148); its fields are `{documentId, versionNumber, language}`. */
export const SUMMARIZE_DOCUMENT_JOB = 'summarize-document';

/** The key two requests for the same summary share while one is queued or running (`AiJobs.enqueue`, D-148). */
export const summaryDedupeKey = (documentId: string, versionNumber: number, language: string) =>
  `summary:${documentId}:v${versionNumber}:${language}`;

/** The `ai` job that summarises a session's minutes (D-179); its fields are `{sessionId, language, force?}`. */
export const SUMMARIZE_SESSION_JOB = 'summarize-session';
