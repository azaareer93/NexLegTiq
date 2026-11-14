import { SearchResultsSchema } from '@nexlegtiq/shared-contracts';
import type { SearchResults, SearchType } from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';

/** What `GET /search` takes (D-167): `limit` is per group. */
export interface SearchParams {
  readonly q: string;
  readonly type?: 'all' | SearchType;
  readonly limit?: number;
}

/** Global search over everything the caller may open (D-167). */
export function searchApi(client: ApiClient) {
  return {
    search: (query: SearchParams, signal?: AbortSignal): Promise<SearchResults> =>
      client.request(
        { method: 'GET', path: 'search', query: { ...query }, signal },
        SearchResultsSchema,
      ),
  };
}
