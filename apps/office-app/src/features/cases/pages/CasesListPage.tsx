import { PlusOutlined } from '@ant-design/icons';
import type { CaseListItem, CaseQuery } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  PageHeader,
  useApiErrorHandler,
  useCan,
} from '@nexlegtiq/shared-ui';
import { Button, Flex, Grid, Modal } from 'antd';
import { useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';

import { useCasesList } from '../api/use-cases';
import { isPlainClick } from '../components/case-cells';
import { CasesCards } from '../components/CasesCards';
import { CasesFilters } from '../components/CasesFilters';
import { CasesTable } from '../components/CasesTable';
import {
  activeView,
  hasFilters,
  parseQuery,
  readQuery,
  withChanges,
  withView,
} from '../list-params';
import type { ListChanges } from '../list-params';

interface ListBodyProps {
  readonly list: ReturnType<typeof useCasesList>;
  readonly state: CaseQuery;
  readonly filtered: boolean;
  readonly onChange: (changes: ListChanges) => void;
  readonly onClear: () => void;
}

function ListError({ list }: Pick<ListBodyProps, 'list'>): React.JSX.Element {
  const { referenceOf } = useApiErrorHandler();
  const code = isApiError(list.error) ? list.error.code : undefined;
  return (
    <div data-testid="cases-error">
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
}: Pick<ListBodyProps, 'filtered' | 'onClear'>): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div data-testid="cases-empty">
      <EmptyState
        title={filtered ? t('cases.list.empty.filteredTitle') : t('cases.list.empty.title')}
        description={filtered ? t('cases.list.empty.filteredBody') : t('cases.list.empty.body')}
        action={
          filtered ? (
            <Button onClick={onClear} data-testid="cases-clear">
              {t('cases.list.filters.clear')}
            </Button>
          ) : null
        }
      />
    </div>
  );
}

/** Skeleton, error, empty, cards or table — whichever the query's state calls for. */
function ListBody({ list, state, filtered, onChange, onClear }: ListBodyProps): React.JSX.Element {
  const navigate = useNavigate();
  const narrow = Grid.useBreakpoint().md === false;
  const page = list.data;

  if (list.isError && !page) {
    return <ListError list={list} />;
  }
  // While another query loads, an empty previous page would describe the wrong filters.
  if (!page || (list.isPlaceholderData && page.items.length === 0)) {
    return <LoadingSkeleton rows={6} />;
  }
  if (page.pagination.total === 0) {
    return <ListEmpty filtered={filtered} onClear={onClear} />;
  }
  const View = narrow ? CasesCards : CasesTable;
  return (
    <View
      items={page.items}
      total={page.pagination.total}
      state={state}
      loading={list.isFetching && list.isPlaceholderData}
      onChange={onChange}
      onOpen={(row: CaseListItem) => (event: MouseEvent) => {
        if (isPlainClick(event)) {
          void navigate(`/cases/${row.id}`);
        }
      }}
    />
  );
}

/**
 * `/cases` (frontend.md#cases-list): views, search and filters kept in the URL (D-113), server-side paging and sorting,
 * a table on wide screens and cards on phones.
 */
export function CasesListPage(): React.JSX.Element {
  const { t } = useTranslation();
  const canCreate = useCan('create:case');
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);

  const query = useMemo(() => readQuery(params), [params]);
  const state = parseQuery(query);
  const list = useCasesList(query);
  const change = (changes: ListChanges) => setParams((prev) => withChanges(prev, changes));

  const pagination = list.data?.pagination;
  // A page past the end (bookmark, files deleted meanwhile): go to the last page there is.
  if (pagination && pagination.total > 0 && pagination.page > pagination.totalPages) {
    const last = withChanges(params, { page: String(pagination.totalPages) });
    return <Navigate to={`?${last.toString()}`} replace />;
  }

  return (
    <section data-testid="page-cases">
      <PageHeader
        title={t('cases.list.title')}
        subtitle={pagination ? t('cases.list.total', { count: pagination.total }) : undefined}
        extra={
          canCreate ? (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateOpen(true)}
              data-testid="cases-new"
            >
              {t('cases.list.newFile')}
            </Button>
          ) : null
        }
      />
      <Flex vertical gap={16}>
        <CasesFilters
          state={state}
          view={activeView(query)}
          onChange={change}
          onView={(view) => setParams((prev) => withView(prev, view))}
        />
        <ListBody
          list={list}
          state={state}
          filtered={hasFilters(query)}
          onChange={change}
          onClear={() =>
            setParams((prev) => withChanges(withView(prev, 'all'), { search: undefined }))
          }
        />
      </Flex>
      <Modal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        footer={null}
        title={t('cases.list.newFile')}
        data-testid="cases-new-modal"
      >
        <EmptyState title={t('shell.comingSoon.title')} description={t('shell.comingSoon.body')} />
      </Modal>
    </section>
  );
}
