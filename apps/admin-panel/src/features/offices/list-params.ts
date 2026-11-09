import type { AdminOfficeListParams } from '@nexlegtiq/shared-api-client';
import { AdminOfficeQuerySchema } from '@nexlegtiq/shared-contracts';

/** The list's state lives in the address bar under the API's own parameter names (D-113). */
export const QUERY_KEYS = [
  'search',
  'status',
  'jurisdiction',
  'plan',
  'createdFrom',
  'createdTo',
  'page',
  'limit',
] as const satisfies readonly (keyof typeof AdminOfficeQuerySchema.shape)[];

/** The URL's parameters the contract accepts, each checked on its own: a bad one is dropped. */
export function readQuery(params: URLSearchParams): AdminOfficeListParams {
  const query: AdminOfficeListParams = {};
  for (const key of QUERY_KEYS) {
    const value = params.get(key);
    if (value && AdminOfficeQuerySchema.shape[key].safeParse(value).success) query[key] = value;
  }
  return query;
}

/** Applies changes (undefined/'' removes); anything but a page change returns to page 1. */
export function withChanges(
  params: URLSearchParams,
  changes: AdminOfficeListParams,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  if (!('page' in changes)) next.delete('page');
  return next;
}
