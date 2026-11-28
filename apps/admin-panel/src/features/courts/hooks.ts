import { adminCourtsApi } from '@nexlegtiq/shared-api-client';
import type {
  AdminCourtListParams,
  AdminCourtReportListParams,
  AdminOfficeCourtListParams,
} from '@nexlegtiq/shared-api-client';
import type {
  AddReportedCourtRequest,
  CreateCourtRequest,
  DismissCourtReportRequest,
  PromoteOfficeCourtRequest,
  UpdateCourtRequest,
} from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { courtKeys } from './keys';
import { apiClient } from '../auth/session';

const courts = adminCourtsApi(apiClient);

export const useCourtsList = (query: AdminCourtListParams, enabled = true) =>
  useQuery({
    queryKey: courtKeys.list(query),
    queryFn: ({ signal }) => courts.list(query, signal),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useOfficeCourts = (query: AdminOfficeCourtListParams) =>
  useQuery({
    queryKey: courtKeys.officeCourts(query),
    queryFn: ({ signal }) => courts.officeCourts(query, signal),
    placeholderData: keepPreviousData,
  });

export const useCourtReports = (query: AdminCourtReportListParams) =>
  useQuery({
    queryKey: courtKeys.reports(query),
    queryFn: ({ signal }) => courts.reports(query, signal),
    placeholderData: keepPreviousData,
  });

/** Every court write; all court lists refetch afterwards (a write can move a row between them). */
export function useCourtMutations() {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: courtKeys.all });
  return {
    create: useMutation({
      mutationFn: (body: CreateCourtRequest) => courts.create(body),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: (args: { id: string; body: UpdateCourtRequest }) =>
        courts.update(args.id, args.body),
      onSuccess,
    }),
    replace: useMutation({
      mutationFn: (args: { id: string; courtId: string }) => courts.replace(args.id, args.courtId),
      onSuccess,
    }),
    promote: useMutation({
      mutationFn: (args: { id: string; body: PromoteOfficeCourtRequest }) =>
        courts.promote(args.id, args.body),
      onSuccess,
    }),
    addReported: useMutation({
      mutationFn: (args: { id: string; body: AddReportedCourtRequest }) =>
        courts.addReported(args.id, args.body),
      onSuccess,
    }),
    dismiss: useMutation({
      mutationFn: (args: { id: string; body: DismissCourtReportRequest }) =>
        courts.dismiss(args.id, args.body),
      onSuccess,
    }),
  };
}
