import { auditApi } from '@nexlegtiq/shared-api-client';
import type { AuditQuery } from '@nexlegtiq/shared-contracts';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const audit = auditApi(apiClient);

export type AuditFilters = Partial<Omit<AuditQuery, 'cursor' | 'limit'>>;

export const auditKeys = {
  all: ['audit'] as const,
  office: (filters: AuditFilters) => ['audit', 'office', filters] as const,
  file: (fileId: string) => ['audit', 'file', fileId] as const,
};

const PAGE = 50;

/** The office's audit log, newest first, 50 rows a page (D-180). */
export const useOfficeAudit = (filters: AuditFilters) =>
  useInfiniteQuery({
    queryKey: auditKeys.office(filters),
    queryFn: ({ pageParam, signal }) =>
      audit.list({ ...filters, limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** A file's audit rows (the file and the rows naming it), newest first. */
export const useFileAudit = (fileId: string) =>
  useInfiniteQuery({
    queryKey: auditKeys.file(fileId),
    queryFn: ({ pageParam, signal }) =>
      audit.file(fileId, { limit: PAGE, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** Saves the filtered log as `audit-log.csv` through a link click (the CSV came with the user's token). */
export const useAuditExport = () =>
  useMutation({
    mutationFn: async (filters: AuditFilters) => {
      const csv = await audit.exportCsv(filters);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'audit-log.csv';
      link.click();
      URL.revokeObjectURL(url);
    },
  });
