import type { Page } from '@nexlegtiq/shared-api-client';
import { EmptyState } from '@nexlegtiq/shared-ui';
import type { UseQueryResult } from '@tanstack/react-query';
import { Table } from 'antd';
import type { TableColumnsType } from 'antd';

import { ListError } from './ListError';

export const PAGE_SIZE = 20;

/** One page of a court list: its error with a retry, an empty state, or the table with server-side paging. */
export function PagedTable<T extends { id: string }>({
  query,
  page,
  onPage,
  columns,
  empty,
  testId,
}: {
  readonly query: UseQueryResult<Page<T>>;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly columns: TableColumnsType<T>;
  readonly empty: string;
  readonly testId: string;
}): React.JSX.Element {
  if (query.isError) {
    return (
      <ListError
        error={query.error}
        onRetry={() => void query.refetch()}
        testId={`${testId}-error`}
      />
    );
  }
  if (query.data?.pagination.total === 0) return <EmptyState title={empty} />;
  return (
    <Table<T>
      data-testid={`${testId}-table`}
      rowKey="id"
      loading={query.isFetching}
      dataSource={query.data?.items ?? []}
      scroll={{ x: 'max-content' }}
      pagination={{
        current: page,
        pageSize: PAGE_SIZE,
        total: query.data?.pagination.total ?? 0,
        showSizeChanger: false,
        onChange: onPage,
      }}
      columns={columns}
    />
  );
}
