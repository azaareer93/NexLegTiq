import { PlusOutlined } from '@ant-design/icons';
import type { ClientQuery } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  PageHeader,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { Button, Flex } from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router';

import { useClientsList } from '../api/use-clients';
import { ClientDrawer } from '../components/ClientDrawer';
import { ClientsFilters } from '../components/ClientsFilters';
import { ClientsTable } from '../components/ClientsTable';
import { hasFilters, parseQuery, readQuery, withChanges } from '../list-params';
import type { ListChanges } from '../list-params';

interface ListBodyProps {
  readonly list: ReturnType<typeof useClientsList>;
  readonly state: ClientQuery;
  readonly filtered: boolean;
  readonly onChange: (changes: ListChanges) => void;
  readonly onCreate: () => void;
  readonly onOpen: (id: string) => void;
  readonly onClear: () => void;
}

function ListError({ list }: Pick<ListBodyProps, 'list'>): React.JSX.Element {
  const { referenceOf } = useApiErrorHandler();
  const code = isApiError(list.error) ? list.error.code : undefined;
  return (
    <div data-testid="clients-error">
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
  onCreate,
}: Pick<ListBodyProps, 'filtered' | 'onClear' | 'onCreate'>): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div data-testid="clients-empty">
      <EmptyState
        title={filtered ? t('clients.list.empty.filteredTitle') : t('clients.list.empty.title')}
        description={filtered ? t('clients.list.empty.filteredBody') : t('clients.list.empty.body')}
        action={
          filtered ? (
            <Button onClick={onClear} data-testid="clients-clear">
              {t('clients.list.filters.clear')}
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={onCreate}
              data-testid="clients-empty-new"
            >
              {t('clients.list.newClient')}
            </Button>
          )
        }
      />
    </div>
  );
}

/** Skeleton, error, empty state or the table — whichever the query's state calls for. */
function ListBody({
  list,
  state,
  filtered,
  onChange,
  onCreate,
  onOpen,
  onClear,
}: ListBodyProps): React.JSX.Element {
  const page = list.data;
  if (list.isError && !page) {
    return <ListError list={list} />;
  }
  // While another query loads, an empty previous page would describe the wrong filters.
  if (!page || (list.isPlaceholderData && page.items.length === 0)) {
    return <LoadingSkeleton rows={6} />;
  }
  if (page.pagination.total === 0) {
    return <ListEmpty filtered={filtered} onClear={onClear} onCreate={onCreate} />;
  }
  return (
    <ClientsTable
      items={page.items}
      total={page.pagination.total}
      state={state}
      loading={list.isFetching && list.isPlaceholderData}
      onChange={onChange}
      onOpen={(row) => onOpen(row.id)}
    />
  );
}

/** The drawer: closed, a new client, or one client by id. */
type DrawerState =
  { readonly open: false } | { readonly open: true; readonly clientId: string | null };

/**
 * `/clients` (frontend.md#clients): search and filters kept in the URL (D-121), server-side paging and sorting; a row
 * opens the client in the drawer until the client profile page exists.
 */
export function ClientsListPage(): React.JSX.Element {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [drawer, setDrawer] = useState<DrawerState>({ open: false });

  const query = useMemo(() => readQuery(params), [params]);
  const state = parseQuery(query);
  const list = useClientsList(query);
  const change = (changes: ListChanges) => setParams((prev) => withChanges(prev, changes));
  const filtered = hasFilters(query);
  const create = () => setDrawer({ open: true, clientId: null });

  const page = list.data;
  // A page past the end (bookmark, clients deleted meanwhile): go to the last page there is.
  if (page && page.pagination.total > 0 && page.pagination.page > page.pagination.totalPages) {
    const last = withChanges(params, { page: String(page.pagination.totalPages) });
    return <Navigate to={`?${last.toString()}`} replace />;
  }

  return (
    <section data-testid="page-clients">
      <PageHeader
        title={t('clients.list.title')}
        subtitle={page ? t('clients.list.total', { count: page.pagination.total }) : undefined}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={create} data-testid="clients-new">
            {t('clients.list.newClient')}
          </Button>
        }
      />
      <Flex vertical gap={16}>
        <ClientsFilters state={state} onChange={change} />
        <ListBody
          list={list}
          state={state}
          filtered={filtered}
          onChange={change}
          onCreate={create}
          onOpen={(id) => setDrawer({ open: true, clientId: id })}
          onClear={() =>
            setParams((prev) =>
              withChanges(prev, { search: undefined, clientType: undefined, isActive: undefined }),
            )
          }
        />
      </Flex>
      <ClientDrawer
        open={drawer.open}
        clientId={drawer.open ? drawer.clientId : null}
        onClose={() => setDrawer({ open: false })}
      />
    </section>
  );
}
