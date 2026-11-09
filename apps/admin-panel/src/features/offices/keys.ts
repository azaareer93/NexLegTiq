import type { AdminOfficeListParams } from '@nexlegtiq/shared-api-client';

export const officeKeys = {
  all: ['admin-offices'] as const,
  lists: () => [...officeKeys.all, 'list'] as const,
  list: (query: AdminOfficeListParams) => [...officeKeys.lists(), query] as const,
  detail: (id: string) => [...officeKeys.all, 'detail', id] as const,
};
