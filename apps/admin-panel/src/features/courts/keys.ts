import type {
  AdminCourtListParams,
  AdminCourtReportListParams,
  AdminOfficeCourtListParams,
} from '@nexlegtiq/shared-api-client';

export const courtKeys = {
  all: ['admin-courts'] as const,
  list: (query: AdminCourtListParams) => [...courtKeys.all, 'list', query] as const,
  officeCourts: (query: AdminOfficeCourtListParams) => [...courtKeys.all, 'office', query] as const,
  reports: (query: AdminCourtReportListParams) => [...courtKeys.all, 'reports', query] as const,
};
