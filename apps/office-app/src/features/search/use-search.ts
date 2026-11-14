import { searchApi } from '@nexlegtiq/shared-api-client';
import type { SearchType } from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { create } from 'zustand';

import { apiClient } from '../auth';

const search = searchApi(apiClient);

/** The API's minimum (D-167). */
export const MIN_QUERY = 2;
/** Per group in the overlay; a "see all" asks for the API's maximum of one type. */
const GROUP_LIMIT = 5;
const ALL_LIMIT = 20;

export const useSearch = (q: string, expanded: SearchType | null) =>
  useQuery({
    queryKey: ['search', { q, expanded }],
    queryFn: ({ signal }) =>
      search.search(
        expanded ? { q, type: expanded, limit: ALL_LIMIT } : { q, limit: GROUP_LIMIT },
        signal,
      ),
    enabled: q.length >= MIN_QUERY,
    placeholderData: keepPreviousData,
  });

const MAX_RECENT = 5;
const NONE: readonly string[] = [];

/**
 * Recent searches live in memory only (D-172): a query may name a client, and an office computer is shared, so nothing is
 * kept in web storage. They belong to the user who made them and are gone on reload.
 */
export const useRecentSearches = create<{
  readonly userId: string | null;
  readonly queries: readonly string[];
}>()(() => ({ userId: null, queries: [] }));

export function rememberSearch(userId: string, q: string): void {
  useRecentSearches.setState((state) => ({
    userId,
    queries: [q, ...(state.userId === userId ? state.queries : []).filter((x) => x !== q)].slice(
      0,
      MAX_RECENT,
    ),
  }));
}

export const recentFor = (
  state: { readonly userId: string | null; readonly queries: readonly string[] },
  userId: string | undefined,
): readonly string[] => (userId !== undefined && state.userId === userId ? state.queries : NONE);
