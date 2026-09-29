import type { PaginationMeta } from '@nexlegtiq/shared-types';

/**
 * Return this from a list handler; the envelope interceptor puts `items` in `data` and the pagination in
 * `meta.pagination`. A class (not a shape check) so a plain `{ items, pagination }` payload is never unwrapped by mistake.
 */
export class PaginatedResult<T> {
  readonly pagination: PaginationMeta;

  private constructor(
    readonly items: readonly T[],
    pagination: { readonly page: number; readonly limit: number; readonly total: number },
  ) {
    const totalPages = pagination.limit > 0 ? Math.ceil(pagination.total / pagination.limit) : 0;
    this.pagination = { ...pagination, totalPages, hasMore: pagination.page < totalPages };
  }

  static of<T>(
    items: readonly T[],
    pagination: { readonly page: number; readonly limit: number; readonly total: number },
  ): PaginatedResult<T> {
    return new PaginatedResult(items, pagination);
  }
}
