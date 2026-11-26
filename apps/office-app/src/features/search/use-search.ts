import { searchApi } from '@nexlegtiq/shared-api-client';
import type { SearchType } from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { create } from 'zustand';

import { apiClient } from '../auth';
import { useDebounced } from '../clients/list-params';

const search = searchApi(apiClient);

/** The API's minimum (D-167). */
export const MIN_QUERY = 2;
/** Per group in the overlay; a "see all" asks for the API's maximum of one type. */
const GROUP_LIMIT = 5;
const ALL_LIMIT = 20;

/** Document text, the expensive half, waits for this much more pause than names do (D-240). */
export const DOCUMENTS_PAUSE_MS = 600;

/**
 * Two steps (D-240): names and titles at once, then document text once typing has paused; `see all` asks one type only.
 * `documentsPending` is true until the document step of the current query has answered.
 */
export function useSearch(q: string, expanded: SearchType | null) {
  const settled = useDebounced(q, DOCUMENTS_PAUSE_MS);
  const names = useQuery({
    queryKey: ['search', { q, expanded }],
    queryFn: ({ signal }) =>
      search.search(
        expanded
          ? { q, type: expanded, limit: ALL_LIMIT }
          : { q, type: 'names', limit: GROUP_LIMIT },
        signal,
      ),
    enabled: q.length >= MIN_QUERY,
    placeholderData: keepPreviousData,
  });
  const wantDocuments = expanded === null && q.length >= MIN_QUERY;
  const documents = useQuery({
    queryKey: ['search', { q: settled, type: 'documents' }],
    queryFn: ({ signal }) =>
      search.search({ q: settled, type: 'documents', limit: GROUP_LIMIT }, signal),
    enabled: wantDocuments && settled === q,
  });
  const documentsReady = documents.data !== undefined && settled === q;
  // Memoised: the panel resets its keyboard selection whenever `data` changes identity.
  const data = useMemo(
    () =>
      names.data && wantDocuments && documentsReady && documents.data
        ? { ...names.data, documents: documents.data.documents }
        : names.data,
    [names.data, documents.data, wantDocuments, documentsReady],
  );
  return {
    data,
    error: names.error ?? (wantDocuments ? documents.error : null),
    isFetching: names.isFetching || documents.isFetching,
    documentsPending: wantDocuments && !documentsReady && !documents.error,
  };
}

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
