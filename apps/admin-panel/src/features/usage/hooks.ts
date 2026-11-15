import { adminUsageApi } from '@nexlegtiq/shared-api-client';
import type { AdminAuditQuery } from '@nexlegtiq/shared-contracts';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';

import { apiClient } from '../auth/session';

const usage = adminUsageApi(apiClient);

export type AuditFilters = Partial<Omit<AdminAuditQuery, 'cursor' | 'limit'>>;

export const usageKeys = {
  usage: (days: number) => ['admin', 'usage', days] as const,
  queues: ['admin', 'queues'] as const,
  audit: (filters: AuditFilters) => ['admin', 'audit', filters] as const,
};

export const useUsage = (days: number) =>
  useQuery({ queryKey: usageKeys.usage(days), queryFn: ({ signal }) => usage.usage(days, signal) });

/** Queue counts, refreshed every 30 s while the page is open. */
export const useQueues = () =>
  useQuery({
    queryKey: usageKeys.queues,
    queryFn: ({ signal }) => usage.queues(signal),
    refetchInterval: 30_000,
  });

export const usePlatformAudit = (filters: AuditFilters) =>
  useInfiniteQuery({
    queryKey: usageKeys.audit(filters),
    queryFn: ({ pageParam, signal }) =>
      usage.audit({ ...filters, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

/** Saves the filtered platform audit as `platform-audit.csv` (the BOM restored for Excel, D-180). */
export const useAuditExport = () =>
  useMutation({
    mutationFn: async (filters: AuditFilters) => {
      const csv = await usage.exportAudit(filters);
      const bom = csv.startsWith('﻿') ? '' : '﻿';
      const url = URL.createObjectURL(new Blob([bom, csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'platform-audit.csv';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  });
