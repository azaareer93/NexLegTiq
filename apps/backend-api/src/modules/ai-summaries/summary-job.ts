/** The `ai` job that summarises a document (D-148); its fields are `{documentId, versionNumber, language}`. */
export const SUMMARIZE_DOCUMENT_JOB = 'summarize-document';

/** The key two requests for the same summary share while one is queued or running (`AiJobs.enqueue`, D-148). */
export const summaryDedupeKey = (documentId: string, versionNumber: number, language: string) =>
  `summary:${documentId}:v${versionNumber}:${language}`;
