import type { InvoiceListParams } from '@nexlegtiq/shared-api-client';
import { INVOICE_STATUSES, isErrorCode } from '@nexlegtiq/shared-types';
import {
  Bdi,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  PageHeader,
  useApiErrorHandler,
  useCan,
} from '@nexlegtiq/shared-ui';
import { Button, DatePicker, Flex, Select } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useClientsList } from '../../clients/api/use-clients';
import { useInvoices } from '../api/use-invoices';
import { InvoicesTable } from '../components/InvoicesTable';

const FILTERS = ['status', 'clientId', 'from', 'to'] as const;
type Changes = Partial<Record<(typeof FILTERS)[number] | 'page', string | null>>;

/** Status, client (for those who may read clients), issued from/to; each written into the URL. */
function Filters({
  params,
  set,
  clear,
}: {
  readonly params: URLSearchParams;
  readonly set: (changes: Changes) => void;
  readonly clear: () => void;
}) {
  const { t } = useTranslation();
  const clients = useClientsList({ limit: '100' }, useCan('manage:clients'));
  const value = (key: (typeof FILTERS)[number]) => params.get(key) ?? undefined;
  const day = (key: 'from' | 'to') => (params.get(key) ? dayjs(params.get(key)) : null);
  const date = (key: 'from' | 'to') => (
    <DatePicker
      format="DD/MM/YYYY"
      placeholder={t(`billing.invoices.filters.${key}`)}
      aria-label={t(`billing.invoices.filters.${key}`)}
      value={day(key)}
      onChange={(d) => set({ [key]: d ? d.format('YYYY-MM-DD') : null })}
      data-testid={`invoices-filter-${key}`}
    />
  );
  return (
    <Flex gap={8} wrap style={{ marginBlockEnd: 16 }}>
      <Select
        allowClear
        placeholder={t('billing.invoices.filters.status')}
        aria-label={t('billing.invoices.filters.status')}
        value={value('status')}
        onChange={(v?: string) => set({ status: v ?? null })}
        style={{ minInlineSize: 160 }}
        data-testid="invoices-filter-status"
        options={INVOICE_STATUSES.map((s) => ({ value: s, label: t(`enums.invoiceStatus.${s}`) }))}
      />
      <Select
        allowClear
        showSearch
        optionFilterProp="search"
        placeholder={t('billing.invoices.filters.client')}
        aria-label={t('billing.invoices.filters.client')}
        value={value('clientId')}
        onChange={(v?: string) => set({ clientId: v ?? null })}
        style={{ minInlineSize: 200 }}
        data-testid="invoices-filter-client"
        options={(clients.data?.items ?? []).map((c) => ({
          value: c.id,
          search: c.displayName,
          label: <Bdi>{c.displayName}</Bdi>,
        }))}
      />
      {date('from')}
      {date('to')}
      {FILTERS.some((key) => params.has(key)) ? (
        <Button onClick={clear} data-testid="invoices-clear">
          {t('billing.invoices.filters.clear')}
        </Button>
      ) : null}
    </Flex>
  );
}

function Body({
  list,
  page,
  onPage,
}: {
  readonly list: ReturnType<typeof useInvoices>;
  readonly page: number;
  readonly onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  const { referenceOf } = useApiErrorHandler();
  if (list.isError) {
    const code = isApiError(list.error) ? list.error.code : undefined;
    return (
      <ErrorState
        code={code !== undefined && isErrorCode(code) ? code : undefined}
        requestId={referenceOf(list.error)}
        onRetry={() => void list.refetch()}
      />
    );
  }
  if (!list.data) return <LoadingSkeleton rows={6} />;
  if (list.data.items.length === 0) return <EmptyState title={t('billing.invoices.empty')} />;
  return (
    <InvoicesTable
      invoices={list.data.items}
      total={list.data.pagination.total}
      page={page}
      onPage={onPage}
      loading={list.isFetching}
    />
  );
}

/** `/invoices`: the office's invoices the user may see, filtered in the URL (D-113), overdue ones marked. */
export function InvoicesPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const query: InvoiceListParams = {
    ...Object.fromEntries(
      FILTERS.flatMap((key) => (params.get(key) ? [[key, params.get(key) as string]] : [])),
    ),
    page: params.get('page') ?? '1',
  };
  const list = useInvoices(query);
  const set = (changes: Changes) => {
    const next = new URLSearchParams(params);
    for (const [key, v] of Object.entries(changes)) {
      if (v) next.set(key, v);
      else next.delete(key);
    }
    // A new filter starts at the first page.
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  };
  return (
    <section data-testid="page-invoices">
      <PageHeader title={t('billing.invoices.title')} />
      <Filters
        params={params}
        set={set}
        clear={() => setParams(new URLSearchParams(), { replace: true })}
      />
      <Body list={list} page={Number(query.page)} onPage={(page) => set({ page: String(page) })} />
    </section>
  );
}
