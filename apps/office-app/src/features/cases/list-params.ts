import type { CaseListParams } from '@nexlegtiq/shared-api-client';
import { CaseQuerySchema } from '@nexlegtiq/shared-contracts';
import type { CaseQuery } from '@nexlegtiq/shared-contracts';
import type { FileType } from '@nexlegtiq/shared-types';

/**
 * The list's state lives in the address bar under the API's own parameter names (D-113), so a view can be bookmarked or
 * shared and the query sent is the URL minus whatever the contract would refuse.
 */
const QUERY_KEYS = [
  'search',
  'status',
  'fileType',
  'priority',
  'scope',
  'clientId',
  'responsibleLawyerId',
  'sort',
  'page',
  'limit',
] as const satisfies readonly (keyof typeof CaseQuerySchema.shape)[];
type QueryKey = (typeof QUERY_KEYS)[number];

/** The keys that narrow the list (search aside); changing any of them goes back to page 1. */
export const FILTER_KEYS = [
  'status',
  'fileType',
  'priority',
  'scope',
  'clientId',
  'responsibleLawyerId',
] as const satisfies readonly QueryKey[];

/** The URL's parameters the contract accepts, each checked on its own: a bad one is dropped, not the whole view. */
export function readQuery(params: URLSearchParams): CaseListParams {
  const query: CaseListParams = {};
  for (const key of QUERY_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== '' && CaseQuerySchema.shape[key].safeParse(value).success) {
      query[key] = value;
    }
  }
  return query;
}

/** The typed state of a query from `readQuery` (every field already valid, so this cannot throw). */
export const parseQuery = (query: CaseListParams): CaseQuery => CaseQuerySchema.parse(query);

/** The contract and form-drafting types, behind the "Contracts" view. */
export const CONTRACT_TYPES: readonly FileType[] = [
  'CONTRACT_DRAFTING',
  'NDA_REVIEW',
  'RENTAL_AGREEMENT',
  'EMPLOYMENT_CONTRACT',
];

/** The quick views (frontend.md#cases-list): each is a set of filters; "All" is none. */
export const VIEWS = {
  all: {},
  mine: { scope: 'mine' },
  litigation: { fileType: 'LITIGATION' },
  contracts: { fileType: CONTRACT_TYPES.join(',') },
  archived: { status: 'ARCHIVED' },
  urgent: { priority: 'URGENT' },
} as const satisfies Record<string, Partial<Record<(typeof FILTER_KEYS)[number], string>>>;
export type ViewKey = keyof typeof VIEWS;
export const VIEW_KEYS = Object.keys(VIEWS) as ViewKey[];

/** The filters in effect; `scope=all` is the default, so it counts as no filter. */
function filtersOf(query: CaseListParams): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const value = query[key];
    if (value !== undefined && !(key === 'scope' && value === 'all')) {
      filters[key] = String(value);
    }
  }
  return filters;
}

export const hasFilters = (query: CaseListParams): boolean =>
  Object.keys(filtersOf(query)).length > 0 || query['search'] !== undefined;

/** The view whose filters are exactly the ones in effect, if any (search and sort do not count). */
export function activeView(query: CaseListParams): ViewKey | undefined {
  const filters = filtersOf(query);
  return VIEW_KEYS.find((key) => {
    const preset: Record<string, string> = VIEWS[key];
    const keys = Object.keys(preset);
    return (
      keys.length === Object.keys(filters).length && keys.every((k) => filters[k] === preset[k])
    );
  });
}

export type ListChanges = Partial<Record<QueryKey, string | undefined>>;

/**
 * The URL after a change: `undefined` or `''` removes a parameter. Changing a filter or the search returns to page 1;
 * `page` and `limit` themselves are kept as given.
 */
export function withChanges(params: URLSearchParams, changes: ListChanges): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || value === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  if (!('page' in changes)) {
    next.delete('page');
  }
  return next;
}

/** The URL showing `view`: its filters replace the current ones; search, sort and page size stay. */
export function withView(params: URLSearchParams, view: ViewKey): URLSearchParams {
  const cleared = Object.fromEntries(FILTER_KEYS.map((key) => [key, undefined]));
  return withChanges(params, { ...cleared, ...VIEWS[view] });
}
