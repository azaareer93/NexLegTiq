import { DownloadOutlined } from '@ant-design/icons';
import { AUDIT_ACTIONS } from '@nexlegtiq/shared-types';
import type { AuditAction } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, Bdi, PageHeader } from '@nexlegtiq/shared-ui';
import { Button, DatePicker, Flex, Select } from 'antd';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useDirectory } from '../../cases/api/use-cases';
import { useAuditExport, useOfficeAudit } from '../api/use-audit';
import type { AuditFilters } from '../api/use-audit';
import { AuditTable } from '../components/AuditTable';

type Key = 'action' | 'userId' | 'entityType' | 'from' | 'to';
/** The entity types users filter by most (others still show in the table). */
const ENTITY_TYPES = [
  'LegalFile',
  'Document',
  'Task',
  'Session',
  'Client',
  'Invoice',
  'User',
] as const;

/** Filters from the URL (D-113); an unknown action is dropped. */
function readFilters(params: URLSearchParams): AuditFilters {
  const action = params.get('action');
  return {
    ...Object.fromEntries(
      (['userId', 'entityType', 'from', 'to'] as const).flatMap((k) =>
        params.get(k) ? [[k, params.get(k) as string]] : [],
      ),
    ),
    ...(action && (AUDIT_ACTIONS as readonly string[]).includes(action)
      ? { action: action as AuditAction }
      : {}),
  };
}

/** `/settings/audit` (MVP-105, D-180, `view:audit`): the office's audit log, filtered in the URL, exportable as CSV. */
export function AuditPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const audit = useOfficeAudit(filters);
  const exporter = useAuditExport();
  const people = useDirectory();
  const set = (key: Key, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const day = (key: 'from' | 'to') => (params.get(key) ? dayjs(params.get(key)) : null);
  const picker = (key: 'from' | 'to') => (
    <DatePicker
      format="DD/MM/YYYY"
      placeholder={t(`audit.filters.${key}`)}
      aria-label={t(`audit.filters.${key}`)}
      value={day(key)}
      onChange={(d) => set(key, d ? d.format('YYYY-MM-DD') : null)}
      disabledDate={(d) => {
        const other = day(key === 'from' ? 'to' : 'from');
        if (!other) return false;
        return key === 'from' ? d.isAfter(other, 'day') : d.isBefore(other, 'day');
      }}
      data-testid={`audit-filter-${key}`}
    />
  );
  return (
    <section data-testid="page-audit">
      <PageHeader
        title={t('audit.title')}
        extra={
          <Button
            icon={<DownloadOutlined />}
            loading={exporter.isPending}
            onClick={() => exporter.mutate(filters)}
            data-testid="audit-export"
          >
            {t('audit.export')}
          </Button>
        }
      />
      <Flex gap={8} wrap style={{ marginBlockEnd: 16 }}>
        <Select
          allowClear
          placeholder={t('audit.filters.action')}
          aria-label={t('audit.filters.action')}
          value={filters.action}
          onChange={(v?: string) => set('action', v ?? null)}
          style={{ minInlineSize: 160 }}
          data-testid="audit-filter-action"
          options={AUDIT_ACTIONS.map((a) => ({ value: a, label: t(`enums.auditAction.${a}`) }))}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="search"
          placeholder={t('audit.filters.user')}
          aria-label={t('audit.filters.user')}
          value={filters.userId}
          onChange={(v?: string) => set('userId', v ?? null)}
          style={{ minInlineSize: 200 }}
          data-testid="audit-filter-user"
          options={(people.data ?? []).map((u) => ({
            value: u.id,
            search: u.fullName,
            label: <Bdi>{u.fullName}</Bdi>,
          }))}
        />
        <Select
          allowClear
          placeholder={t('audit.filters.entity')}
          aria-label={t('audit.filters.entity')}
          value={filters.entityType}
          onChange={(v?: string) => set('entityType', v ?? null)}
          style={{ minInlineSize: 160 }}
          data-testid="audit-filter-entity"
          options={ENTITY_TYPES.map((e) => ({ value: e, label: t(`audit.entity.${e}`) }))}
        />
        {picker('from')}
        {picker('to')}
      </Flex>
      {exporter.isError ? <ApiErrorAlert error={exporter.error} /> : null}
      {audit.isError ? <ApiErrorAlert error={audit.error} /> : null}
      <AuditTable
        entries={audit.data?.pages.flatMap((p) => p.items) ?? []}
        loading={audit.isPending}
        hasMore={audit.hasNextPage}
        loadingMore={audit.isFetchingNextPage}
        onMore={() => void audit.fetchNextPage()}
      />
    </section>
  );
}
