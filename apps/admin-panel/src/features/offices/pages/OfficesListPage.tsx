import type { AdminOfficeListParams } from '@nexlegtiq/shared-api-client';
import { AdminOfficeQuerySchema, OFFICE_ADMIN_STATUSES } from '@nexlegtiq/shared-contracts';
import type { AdminOfficeListItem, AdminOfficeQuery } from '@nexlegtiq/shared-contracts';
import { isErrorCode, JURISDICTIONS } from '@nexlegtiq/shared-types';
import {
  Bdi,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  PageHeader,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { Button, DatePicker, Flex, Input, Select, Space, Table } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useSearchParams } from 'react-router';

import { AtRiskTag } from '../components/AtRiskTag';
import { useOfficesList } from '../hooks';
import { readQuery, withChanges } from '../list-params';

const DAY = 'YYYY-MM-DD';

function useColumns(): TableColumnsType<AdminOfficeListItem> {
  const { t } = useTranslation();
  const format = useFormat();
  const none = t('admin.offices.none');
  return [
    {
      title: t('admin.offices.columns.name'),
      key: 'name',
      render: (_, row) => (
        <Link to={`/offices/${row.id}`} data-testid={`office-link-${row.id}`}>
          <Bdi>{row.name}</Bdi>
        </Link>
      ),
    },
    {
      title: t('admin.offices.columns.jurisdiction'),
      key: 'jurisdiction',
      render: (_, row) => t(`enums.jurisdiction.${row.jurisdiction}`),
    },
    {
      title: t('admin.offices.columns.status'),
      key: 'status',
      render: (_, row) => (
        <Space size={4} wrap>
          <StatusTag tone={row.status === 'ACTIVE' ? 'success' : 'error'}>
            {t(`admin.offices.status.${row.status}`)}
          </StatusTag>
          {row.atRisk ? <AtRiskTag id={row.id} /> : null}
        </Space>
      ),
    },
    {
      title: t('admin.offices.columns.plan'),
      key: 'plan',
      render: (_, row) =>
        row.plan ? (
          <>
            <Bdi>{row.plan.name}</Bdi>
            {row.subscriptionStatus ? (
              <div>{t(`enums.subscriptionStatus.${row.subscriptionStatus}`)}</div>
            ) : null}
          </>
        ) : (
          none
        ),
    },
    {
      title: t('admin.offices.columns.users'),
      key: 'users',
      render: (_, row) => format.number(row.usage.activeUsers),
    },
    {
      title: t('admin.offices.columns.files'),
      key: 'files',
      render: (_, row) => format.number(row.usage.liveFiles),
    },
    {
      title: t('admin.offices.columns.storage'),
      key: 'storage',
      render: (_, row) => t('admin.offices.mb', { value: format.number(row.usage.storageMb) }),
    },
    {
      title: t('admin.offices.columns.ai'),
      key: 'ai',
      render: (_, row) => format.number(row.usage.aiThisMonth),
    },
    {
      title: t('admin.offices.columns.lastActivity'),
      key: 'lastActivity',
      render: (_, row) => (row.lastActivityAt ? format.dateTime(row.lastActivityAt) : none),
    },
    {
      title: t('admin.offices.columns.lastWrite'),
      key: 'lastWrite',
      render: (_, row) => (row.lastWriteAt ? format.dateTime(row.lastWriteAt) : none),
    },
    {
      title: t('admin.offices.columns.created'),
      key: 'created',
      render: (_, row) => format.date(row.createdAt),
    },
  ];
}

type Change = (changes: AdminOfficeListParams) => void;

function ListError({ list }: { readonly list: ReturnType<typeof useOfficesList> }) {
  const { referenceOf } = useApiErrorHandler();
  const code = isApiError(list.error) ? list.error.code : undefined;
  return (
    <div data-testid="offices-error">
      <ErrorState
        code={code !== undefined && isErrorCode(code) ? code : undefined}
        requestId={referenceOf(list.error)}
        onRetry={() => void list.refetch()}
      />
    </div>
  );
}

function ListEmpty({
  filtered,
  onClear,
}: {
  readonly filtered: boolean;
  readonly onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-testid="offices-empty">
      <EmptyState
        title={filtered ? t('admin.offices.empty.filteredTitle') : t('admin.offices.empty.title')}
        action={
          filtered ? (
            <Button onClick={onClear} data-testid="offices-clear">
              {t('admin.offices.filters.clear')}
            </Button>
          ) : null
        }
      />
    </div>
  );
}

function ListBody({
  list,
  filtered,
  state,
  change,
  onClear,
}: {
  readonly list: ReturnType<typeof useOfficesList>;
  readonly filtered: boolean;
  readonly state: AdminOfficeQuery;
  readonly change: Change;
  readonly onClear: () => void;
}): React.JSX.Element {
  const columns = useColumns();
  const page = list.data;

  if (list.isError && !page) return <ListError list={list} />;
  if (!page) return <LoadingSkeleton rows={6} />;
  if (page.pagination.total === 0) return <ListEmpty filtered={filtered} onClear={onClear} />;
  return (
    <Table<AdminOfficeListItem>
      data-testid="offices-table"
      rowKey="id"
      columns={columns}
      dataSource={page.items}
      loading={list.isFetching && list.isPlaceholderData}
      scroll={{ x: 'max-content' }}
      pagination={{
        current: state.page,
        pageSize: state.limit,
        total: page.pagination.total,
        showSizeChanger: true,
        pageSizeOptions: [20, 50, 100],
        onChange: (next, size) =>
          change({ page: String(next), limit: size === state.limit ? undefined : String(size) }),
      }}
    />
  );
}

function Filters({
  query,
  change,
}: {
  readonly query: AdminOfficeListParams;
  readonly change: Change;
}): React.JSX.Element {
  const { t } = useTranslation();
  const range: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null =
    query.createdFrom || query.createdTo
      ? [
          query.createdFrom ? dayjs(query.createdFrom) : null,
          query.createdTo ? dayjs(query.createdTo) : null,
        ]
      : null;
  return (
    <Flex gap={12} wrap>
      <Input.Search
        key={`search-${query.search ?? ''}`}
        defaultValue={query.search}
        allowClear
        maxLength={100}
        placeholder={t('admin.offices.filters.search')}
        aria-label={t('admin.offices.filters.search')}
        onSearch={(value) => change({ search: value.trim() })}
        data-testid="offices-search"
        style={{ inlineSize: 260 }}
      />
      <Select
        allowClear
        value={query.status}
        placeholder={t('admin.offices.filters.status')}
        aria-label={t('admin.offices.filters.status')}
        onChange={(value: string | undefined) => change({ status: value })}
        options={OFFICE_ADMIN_STATUSES.map((value) => ({
          value,
          label: t(`admin.offices.status.${value}`),
        }))}
        data-testid="offices-status"
        style={{ inlineSize: 160 }}
      />
      <Select
        allowClear
        value={query.jurisdiction}
        placeholder={t('admin.offices.filters.jurisdiction')}
        aria-label={t('admin.offices.filters.jurisdiction')}
        onChange={(value: string | undefined) => change({ jurisdiction: value })}
        options={JURISDICTIONS.map((value) => ({
          value,
          label: t(`enums.jurisdiction.${value}`),
        }))}
        data-testid="offices-jurisdiction"
        style={{ inlineSize: 180 }}
      />
      <Input
        key={`plan-${query.plan ?? ''}`}
        defaultValue={query.plan}
        allowClear
        dir="ltr"
        maxLength={64}
        placeholder={t('admin.offices.filters.plan')}
        aria-label={t('admin.offices.filters.plan')}
        onPressEnter={(event) => change({ plan: event.currentTarget.value.trim() })}
        data-testid="offices-plan"
        style={{ inlineSize: 160 }}
      />
      <DatePicker.RangePicker
        allowEmpty={[true, true]}
        format="DD/MM/YYYY"
        value={range}
        placeholder={[t('admin.offices.filters.createdFrom'), t('admin.offices.filters.createdTo')]}
        onChange={(values) =>
          change({ createdFrom: values?.[0]?.format(DAY), createdTo: values?.[1]?.format(DAY) })
        }
        data-testid="offices-created"
      />
    </Flex>
  );
}

/** `/offices`: every office with search and filters kept in the URL (D-113). */
export function OfficesListPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => readQuery(params), [params]);
  const list = useOfficesList(query);
  const change: Change = (changes) => setParams((prev) => withChanges(prev, changes));
  const filtered = Object.keys(query).some((key) => key !== 'page' && key !== 'limit');

  const pagination = list.data?.pagination;
  // A page past the end (bookmark, offices removed meanwhile): go to the last page there is.
  if (list.data?.items.length === 0 && pagination && pagination.total > 0) {
    const last = withChanges(params, { page: String(pagination.totalPages) });
    return <Navigate to={`?${last.toString()}`} replace />;
  }

  return (
    <section data-testid="page-offices">
      <PageHeader title={t('admin.offices.title')} />
      <Flex vertical gap={16}>
        <Filters query={query} change={change} />
        <ListBody
          list={list}
          filtered={filtered}
          state={AdminOfficeQuerySchema.parse(query)}
          change={change}
          onClear={() => setParams({})}
        />
      </Flex>
    </section>
  );
}
