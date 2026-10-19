import type { ClientListItem, ClientQuery, ClientSortField } from '@nexlegtiq/shared-contracts';
import { Bdi, Ltr, useFormat } from '@nexlegtiq/shared-ui';
import { Flex, Table, Tag } from 'antd';
import type { TableColumnType, TableProps } from 'antd';
import { useTranslation } from 'react-i18next';

import type { ListChanges } from '../list-params';

const PAGE_SIZES = [20, 50, 100];
const DEFAULT_LIMIT = 20;

export interface ClientsTableProps {
  readonly items: ClientListItem[];
  readonly total: number;
  readonly state: ClientQuery;
  readonly loading: boolean;
  readonly onChange: (changes: ListChanges) => void;
  readonly onOpen: (row: ClientListItem) => void;
}

function useColumns(state: ClientQuery): TableProps<ClientListItem>['columns'] {
  const { t } = useTranslation();
  const format = useFormat();
  const sort = state.sort[0];
  const sortable = (field: ClientSortField): TableColumnType<ClientListItem> => ({
    key: field,
    sorter: true,
    sortOrder: sort?.field === field ? (sort.direction === 'asc' ? 'ascend' : 'descend') : null,
  });
  return [
    {
      ...sortable('name'),
      title: t('clients.list.columns.name'),
      render: (_, row) => (
        <Flex gap={8} align="center" wrap>
          <Bdi>{row.displayName}</Bdi>
          {row.isActive ? null : <Tag>{t('clients.list.inactive')}</Tag>}
        </Flex>
      ),
    },
    {
      key: 'clientType',
      title: t('clients.list.columns.clientType'),
      render: (_, row) => t(`enums.clientType.${row.clientType}`),
    },
    {
      key: 'phone',
      title: t('clients.list.columns.phone'),
      render: (_, row) => (row.phone ? <Ltr>{row.phone}</Ltr> : null),
    },
    {
      key: 'email',
      title: t('clients.list.columns.email'),
      render: (_, row) => (row.email ? <Ltr>{row.email}</Ltr> : null),
    },
    {
      ...sortable('openFiles'),
      title: t('clients.list.columns.openFiles'),
      render: (_, row) => format.number(row.openFiles),
    },
    {
      key: 'updatedAt',
      title: t('clients.list.columns.updatedAt'),
      render: (_, row) => (
        <time dateTime={row.updatedAt} title={format.dateTime(row.updatedAt)}>
          {format.relative(row.updatedAt)}
        </time>
      ),
    },
  ];
}

/** The list: sortable columns and the pager, both written to the URL; a row opens the client. */
export function ClientsTable({
  items,
  total,
  state,
  loading,
  onChange,
  onOpen,
}: ClientsTableProps): React.JSX.Element {
  const columns = useColumns(state);
  const onTableChange: TableProps<ClientListItem>['onChange'] = (pagination, _filters, sorter) => {
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
    <Table<ClientListItem>
      data-testid="clients-table"
      rowKey="id"
      columns={columns}
      dataSource={items}
      loading={loading}
      onChange={onTableChange}
      onRow={(row) => ({
        onClick: () => onOpen(row),
        onKeyDown: (event) => {
          if (event.key === 'Enter') onOpen(row);
        },
        tabIndex: 0,
        style: { cursor: 'pointer' },
        'data-testid': `client-row-${row.id}`,
      })}
      pagination={{
        current: state.page,
        pageSize: state.limit,
        total,
        showSizeChanger: true,
        pageSizeOptions: PAGE_SIZES,
      }}
      // shortcut: one scrolling table on phones (cases has cards); give clients cards if phone use shows it is needed.
      scroll={{ x: 'max-content' }}
    />
  );
}
