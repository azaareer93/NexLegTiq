import type { ClientListParams } from '@nexlegtiq/shared-api-client';
import { ClientQuerySchema } from '@nexlegtiq/shared-contracts';
import type { ClientQuery } from '@nexlegtiq/shared-contracts';
import { useEffect, useState } from 'react';

/** The list's state in the address bar under the API's parameter names, as for cases (D-113, D-121). */
const QUERY_KEYS = [
  'search',
  'clientType',
  'isActive',
  'sort',
  'page',
  'limit',
] as const satisfies readonly (keyof typeof ClientQuerySchema.shape)[];
type QueryKey = (typeof QUERY_KEYS)[number];

/** The URL's parameters the contract accepts, each checked on its own: a bad one is dropped, not the whole view. */
export function readQuery(params: URLSearchParams): ClientListParams {
  const query: ClientListParams = {};
  for (const key of QUERY_KEYS) {
    const value = params.get(key);
    if (value !== null && value !== '' && ClientQuerySchema.shape[key].safeParse(value).success) {
      query[key] = value;
    }
  }
  return query;
}

/** The typed state of a query from `readQuery` (every field already valid, so this cannot throw). */
export const parseQuery = (query: ClientListParams): ClientQuery => ClientQuerySchema.parse(query);

export const hasFilters = (query: ClientListParams): boolean =>
  query.search !== undefined || query.clientType !== undefined || query.isActive !== undefined;

export type ListChanges = Partial<Record<QueryKey, string | undefined>>;

/** The URL after a change: `undefined` or `''` removes a parameter; anything but paging returns to page 1. */
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

/** `value`, once it has stopped changing for `ms` (search as you type without a request per key). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
