export type {
  ApiError,
  ApiErrorDetail,
  ApiErrorResponse,
  ApiMeta,
  ApiResponse,
  ApiSuccessResponse,
  PaginationMeta,
} from './api/envelope.js';
export { ERROR_CODES, isErrorCode } from './api/error-codes.js';
export type { ErrorCode } from './api/error-codes.js';
export type { Brand } from './brand.js';
export type { OfficeId, UserId } from './ids.js';
export { isLocale, SUPPORTED_LOCALES } from './locale.js';
export { ACCOUNT_TYPES, JURISDICTIONS, OFFICE_LANGUAGES } from './office.js';
export type { AccountType, Jurisdiction, OfficeLanguage } from './office.js';
export type { Locale } from './locale.js';
export {
  BILLING_METHODS,
  CLIENT_TYPES,
  FILE_STATUSES,
  FILE_TEAM_ROLES,
  FILE_TYPES,
  PARTY_TYPES,
} from './legal-file.js';
export type {
  BillingMethod,
  ClientType,
  FileStatus,
  FileTeamRole,
  FileType,
  PartyType,
} from './legal-file.js';
export { PRIORITIES } from './priority.js';
export type { Priority } from './priority.js';
export {
  conditionFor,
  hasAllPermissions,
  isRole,
  hasAnyPermission,
  PERMISSION_CONDITIONS,
  PERMISSIONS,
  permissionsFor,
  ROLE_PERMISSIONS,
  ROLES,
} from './permissions.js';
export type { Permission, PermissionCondition, Role } from './permissions.js';
