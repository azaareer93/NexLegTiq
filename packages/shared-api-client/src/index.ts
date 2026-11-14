export { ApiError, REQUEST_ID_HEADER, toApiError } from './api-error.js';
export {
  createApiClient,
  IDEMPOTENCY_HEADER,
  idempotencyHeaders,
  REQUEST_TIMEOUT_MS,
} from './api-client.js';
export type { ApiClient, ApiClientConfig, ApiRequest, Page, Realm } from './api-client.js';
export { API_BASE_PATH, buildApiUrl } from './api-url.js';
export {
  authApi,
  clientsApi,
  courtsApi,
  dashboardApi,
  officesApi,
  sessionsApi,
  usersApi,
} from './resources.js';
export type {
  ClientListParams,
  ClientSession,
  CourtListParams,
  FileSessionsParams,
  SessionCalendarParams,
} from './resources.js';
export { documentsApi, foldersApi } from './documents.js';
export type { DocumentListParams, UploadInput, VersionInput } from './documents.js';
export { taskTemplatesApi, tasksApi } from './tasks.js';
export type { TaskListParams } from './tasks.js';
export { partiesApi } from './parties.js';
export type { ConflictListParams } from './parties.js';
export { casesApi } from './cases.js';
export type { CaseListParams } from './cases.js';
export { aiApi } from './ai.js';
export { notificationsApi } from './notifications.js';
export { searchApi } from './search.js';
export type { SearchParams } from './search.js';
export type { NotificationListParams } from './notifications.js';
export { profileApi } from './profile.js';
export { adminOfficesApi } from './admin-offices.js';
export type { AdminOfficeListParams } from './admin-offices.js';
export { adminPaymentsApi } from './admin-payments.js';
export { adminPlansApi } from './admin-plans.js';
export { adminAuthApi } from './admin-auth.js';
export type { AdminClientSession } from './admin-auth.js';
export { timeEntriesApi } from './time-entries.js';
export type { TimeEntryListParams } from './time-entries.js';
export { witnessesApi } from './witnesses.js';
export { clientProfileApi } from './client-profile.js';
export type { ClientDocumentListParams, InvoiceListParams } from './client-profile.js';
