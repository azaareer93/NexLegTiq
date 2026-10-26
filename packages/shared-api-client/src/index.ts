export { ApiError, REQUEST_ID_HEADER, toApiError } from './api-error.js';
export {
  createApiClient,
  IDEMPOTENCY_HEADER,
  idempotencyHeaders,
  REQUEST_TIMEOUT_MS,
} from './api-client.js';
export type { ApiClient, ApiClientConfig, ApiRequest, Page, Realm } from './api-client.js';
export { API_BASE_PATH, buildApiUrl } from './api-url.js';
export { authApi, clientsApi, courtsApi, officesApi, sessionsApi, usersApi } from './resources.js';
export type {
  ClientListParams,
  ClientSession,
  CourtListParams,
  FileSessionsParams,
} from './resources.js';
export { documentsApi, foldersApi } from './documents.js';
export type { DocumentListParams, UploadInput, VersionInput } from './documents.js';
export { tasksApi } from './tasks.js';
export type { TaskListParams } from './tasks.js';
export { partiesApi } from './parties.js';
export type { ConflictListParams } from './parties.js';
export { casesApi } from './cases.js';
export type { CaseListParams } from './cases.js';
export { profileApi } from './profile.js';
