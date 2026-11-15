import { DownloadOutlined } from '@ant-design/icons';
import type { AdminAuditEntry } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, Bdi, PageHeader, useFormat } from '@nexlegtiq/shared-ui';
import { Button, DatePicker, Flex, Input, Table, Typography } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuditExport, usePlatformAudit } from '../hooks';
import type { AuditFilters } from '../hooks';

const DAY_KEYS = ['from', 'to'] as const;

/** `/audit` (D-183): what platform staff did (sign-ins included), filtered, paged and exportable as CSV. */
export function PlatformAuditPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const [filters, setFilters] = useState<AuditFilters>({});
  const audit = usePlatformAudit(filters);
  const exporter = useAuditExport();
  const set = (key: keyof AuditFilters, value: string | undefined) =>
    setFilters((f) => ({ ...f, [key]: value || undefined }));
  const day = (key: 'from' | 'to') => (filters[key] ? dayjs(filters[key]) : null);
  const failure = audit.error ?? exporter.error;
  return (
    <section data-testid="page-platform-audit">
      <PageHeader
        title={t('admin.audit.title')}
        extra={
          <Button
            icon={<DownloadOutlined />}
            loading={exporter.isPending}
            onClick={() => exporter.mutate(filters)}
            data-testid="platform-audit-export"
          >
            {t('admin.audit.export')}
          </Button>
        }
      />
      <Flex gap={8} wrap style={{ marginBlockEnd: 16 }}>
        <Input.Search
          allowClear
          dir="ltr"
          placeholder={t('admin.audit.filters.action')}
          aria-label={t('admin.audit.filters.action')}
          onSearch={(v) => set('action', v.trim().toUpperCase())}
          style={{ maxInlineSize: 280 }}
          data-testid="platform-audit-action"
        />
        {DAY_KEYS.map((key) => (
          <DatePicker
            key={key}
            format="DD/MM/YYYY"
            placeholder={t(`admin.audit.filters.${key}`)}
            aria-label={t(`admin.audit.filters.${key}`)}
            value={day(key)}
            onChange={(d) => set(key, d ? d.format('YYYY-MM-DD') : undefined)}
            data-testid={`platform-audit-${key}`}
          />
        ))}
      </Flex>
      {failure ? <ApiErrorAlert error={failure} /> : null}
      <Table<AdminAuditEntry>
        size="small"
        rowKey="id"
        loading={audit.isPending}
        pagination={false}
        dataSource={audit.data?.pages.flatMap((p) => p.items) ?? []}
        locale={{ emptyText: t('admin.audit.empty') }}
        scroll={{ x: 720 }}
        data-testid="platform-audit-table"
        columns={[
          {
            key: 'time',
            title: t('admin.audit.columns.time'),
            render: (_, e) => <Bdi>{format.dateTime(e.occurredAt)}</Bdi>,
          },
          {
            key: 'admin',
            title: t('admin.audit.columns.admin'),
            render: (_, e) => (e.admin ? <Bdi>{e.admin.name}</Bdi> : t('admin.audit.unknownAdmin')),
          },
          {
            key: 'action',
            title: t('admin.audit.columns.action'),
            render: (_, e) => <span dir="ltr">{e.action}</span>,
          },
          {
            key: 'office',
            title: t('admin.audit.columns.office'),
            render: (_, e) => (e.office ? <Bdi>{e.office.name}</Bdi> : null),
          },
          {
            key: 'changes',
            title: t('admin.audit.columns.changes'),
            render: (_, e) => (
              <Typography.Text type="secondary">
                <span dir="ltr">{e.changes.map((c) => c.field).join(', ')}</span>
              </Typography.Text>
            ),
          },
        ]}
      />
      {audit.hasNextPage ? (
        <Button
          onClick={() => void audit.fetchNextPage()}
          loading={audit.isFetchingNextPage}
          style={{ display: 'block', marginInline: 'auto', marginBlockStart: 12 }}
          data-testid="platform-audit-more"
        >
          {t('admin.audit.loadMore')}
        </Button>
      ) : null}
    </section>
  );
}
