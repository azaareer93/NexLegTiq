import type { CaseListItem, CaseQuery, CaseSortField } from '@nexlegtiq/shared-contracts';
import { Bdi, Ltr, PriorityTag, useFormat } from '@nexlegtiq/shared-ui';
import { Table } from 'antd';
import type { TableColumnType, TableProps } from 'antd';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { ListChanges } from '../list-params';
import { FileStatusTag, TitleLink } from './case-cells';

const PAGE_SIZES = [20, 50, 100];
const DEFAULT_LIMIT = 20;

export interface CasesViewProps {
  readonly items: CaseListItem[];
  readonly total: number;
  readonly state: CaseQuery;
  readonly loading: boolean;
  readonly onChange: (changes: ListChanges) => void;
  readonly onOpen: (row: CaseListItem) => (event: MouseEvent) => void;
}

function useColumns(state: CaseQuery): TableProps<CaseListItem>['columns'] {
  const { t } = useTranslation();
  const format = useFormat();
  const sort = state.sort[0];
  const sortable = (field: CaseSortField): TableColumnType<CaseListItem> => ({
    key: field,
    title: t(`cases.list.columns.${field as 'fileNumber'}`),
    sorter: true,
    sortOrder: sort?.field === field ? (sort.direction === 'asc' ? 'ascend' : 'descend') : null,
  });
  return [
    { ...sortable('fileNumber'), render: (_, row) => <Ltr>{row.fileNumber}</Ltr> },
    { ...sortable('title'), render: (_, row) => <TitleLink row={row} /> },
    { ...sortable('status'), render: (_, row) => <FileStatusTag status={row.status} /> },
    { ...sortable('priority'), render: (_, row) => <PriorityTag priority={row.priority} /> },
    {
      key: 'fileType',
      title: t('cases.list.columns.fileType'),
      render: (_, row) => t(`enums.fileType.${row.fileType}`),
    },
    {
      key: 'client',
      title: t('cases.list.columns.client'),
      render: (_, row) => (row.primaryClient ? <Bdi>{row.primaryClient.displayName}</Bdi> : null),
    },
    {
      key: 'responsible',
      title: t('cases.list.columns.responsible'),
      render: (_, row) => <Bdi>{row.responsibleLawyer.fullName}</Bdi>,
    },
    {
      ...sortable('updatedAt'),
      // The list's default order is newest first: the cycle never falls back to "no order".
      sortDirections: ['descend', 'ascend', 'descend'],
      render: (_, row) => (
        <time dateTime={row.updatedAt} title={format.dateTime(row.updatedAt)}>
          {format.relative(row.updatedAt)}
        </time>
      ),
    },
  ];
}

/** The wide-screen list: sortable columns and the pager, both written to the URL. */
export function CasesTable({
  items,
  total,
  state,
  loading,
  onChange,
  onOpen,
}: CasesViewProps): React.JSX.Element {
  const columns = useColumns(state);
  const onTableChange: TableProps<CaseListItem>['onChange'] = (pagination, _filters, sorter) => {
    const single = Array.isArray(sorter) ? sorter[0] : sorter;
    const direction = single?.order === 'ascend' ? 'asc' : 'desc';
    const current = pagination.current ?? 1;
    onChange({
      sort: single?.order ? `${String(single.columnKey)}:${direction}` : undefined,
      page: current > 1 ? String(current) : undefined,
      limit: pagination.pageSize === DEFAULT_LIMIT ? undefined : String(pagination.pageSize),
    });
  };
  return (
    <Table<CaseListItem>
      data-testid="cases-table"
      rowKey="id"
      columns={columns}
      dataSource={items}
      loading={loading}
      onChange={onTableChange}
      onRow={(row) => ({ onClick: onOpen(row), style: { cursor: 'pointer' } })}
      pagination={{
        current: state.page,
        pageSize: state.limit,
        total,
        showSizeChanger: true,
        pageSizeOptions: PAGE_SIZES,
      }}
      scroll={{ x: 'max-content' }}
    />
  );
}
