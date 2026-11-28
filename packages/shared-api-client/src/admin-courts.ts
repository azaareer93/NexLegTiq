import {
  AdminCourtReportSchema,
  CourtSchema,
  OfficeCourtSchema,
  ReplaceOfficeCourtResultSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AddReportedCourtRequest,
  AdminCourtQuerySchema,
  AdminCourtReport,
  AdminCourtReportQuerySchema,
  AdminOfficeCourtQuerySchema,
  Court,
  CreateCourtRequest,
  DismissCourtReportRequest,
  OfficeCourt,
  PromoteOfficeCourtRequest,
  ReplaceOfficeCourtResult,
  UpdateCourtRequest,
} from '@nexlegtiq/shared-contracts';
import type { z } from 'zod';

import type { ApiClient, Page } from './api-client.js';

/** Query parameters as they travel in the query string. */
type Params<S extends z.ZodType> = Partial<Record<keyof z.input<S>, string>>;
export type AdminCourtListParams = Params<typeof AdminCourtQuerySchema>;
export type AdminOfficeCourtListParams = Params<typeof AdminOfficeCourtQuerySchema>;
export type AdminCourtReportListParams = Params<typeof AdminCourtReportQuerySchema>;

/** Platform admin: courts per country, offices' legacy courts and missing-court reports (MVP-167, D-266). */
export function adminCourtsApi(client: ApiClient) {
  const id = encodeURIComponent;
  return {
    list: (query: AdminCourtListParams, signal?: AbortSignal): Promise<Page<Court>> =>
      client.requestPage({ method: 'GET', path: 'admin/courts', query, signal }, CourtSchema),
    create: (body: CreateCourtRequest): Promise<Court> =>
      client.request({ method: 'POST', path: 'admin/courts', body }, CourtSchema),
    update: (courtId: string, body: UpdateCourtRequest): Promise<Court> =>
      client.request({ method: 'PATCH', path: `admin/courts/${id(courtId)}`, body }, CourtSchema),
    officeCourts: (
      query: AdminOfficeCourtListParams,
      signal?: AbortSignal,
    ): Promise<Page<OfficeCourt>> =>
      client.requestPage(
        { method: 'GET', path: 'admin/office-courts', query, signal },
        OfficeCourtSchema,
      ),
    /** Re-points the office court's files, hearings and judges to `courtId`, then deletes it. */
    replace: (courtId: string, targetId: string): Promise<ReplaceOfficeCourtResult> =>
      client.request(
        {
          method: 'POST',
          path: `admin/office-courts/${id(courtId)}/replace`,
          body: { courtId: targetId },
        },
        ReplaceOfficeCourtResultSchema,
      ),
    promote: (courtId: string, body: PromoteOfficeCourtRequest): Promise<Court> =>
      client.request(
        { method: 'POST', path: `admin/office-courts/${id(courtId)}/promote`, body },
        CourtSchema,
      ),
    reports: (
      query: AdminCourtReportListParams,
      signal?: AbortSignal,
    ): Promise<Page<AdminCourtReport>> =>
      client.requestPage(
        { method: 'GET', path: 'admin/court-reports', query, signal },
        AdminCourtReportSchema,
      ),
    addReported: (reportId: string, body: AddReportedCourtRequest): Promise<AdminCourtReport> =>
      client.request(
        { method: 'POST', path: `admin/court-reports/${id(reportId)}/add`, body },
        AdminCourtReportSchema,
      ),
    dismiss: (reportId: string, body: DismissCourtReportRequest): Promise<AdminCourtReport> =>
      client.request(
        { method: 'POST', path: `admin/court-reports/${id(reportId)}/dismiss`, body },
        AdminCourtReportSchema,
      ),
  };
}
