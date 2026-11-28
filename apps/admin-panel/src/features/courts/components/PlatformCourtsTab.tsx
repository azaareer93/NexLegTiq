import type { Court } from '@nexlegtiq/shared-contracts';
import { JURISDICTIONS } from '@nexlegtiq/shared-types';
import type { Jurisdiction } from '@nexlegtiq/shared-types';
import { Bdi, StatusTag, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button, Flex, Input, Select, Space } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CourtModal } from './CourtModal';
import { PagedTable, PAGE_SIZE } from './PagedTable';
import { useCourtMutations, useCourtsList } from '../hooks';

/** A country's platform courts (inactive included): add, edit, deactivate and reactivate (D-266). */
export function PlatformCourtsTab(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('PALESTINE');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Court | 'new' | null>(null);
  const list = useCourtsList({
    jurisdiction,
    page: String(page),
    limit: String(PAGE_SIZE),
    ...(search ? { search } : {}),
  });
  const { update } = useCourtMutations();
  const arabic = i18n.language === 'ar';

  const toggle = async (court: Court): Promise<void> => {
    try {
      await update.mutateAsync({ id: court.id, body: { isActive: !court.isActive } });
      void message.success(
        t(court.isActive ? 'admin.courts.deactivated' : 'admin.courts.activated'),
      );
    } catch (error) {
      notify(error);
    }
  };

  return (
    <section data-testid="platform-courts">
      <Flex gap={12} wrap justify="space-between" style={{ marginBlockEnd: 16 }}>
        <Space wrap>
          <Select<Jurisdiction>
            value={jurisdiction}
            onChange={(value) => {
              setJurisdiction(value);
              setPage(1);
            }}
            options={JURISDICTIONS.map((value) => ({
              value,
              label: t(`enums.jurisdiction.${value}`),
            }))}
            aria-label={t('admin.courts.country')}
            style={{ minInlineSize: 180 }}
            data-testid="courts-country"
          />
          <Input.Search
            allowClear
            placeholder={t('admin.courts.search')}
            aria-label={t('admin.courts.search')}
            onSearch={(value) => {
              setSearch(value.trim());
              setPage(1);
            }}
            data-testid="courts-search"
          />
        </Space>
        <Button type="primary" onClick={() => setEditing('new')} data-testid="court-new">
          {t('admin.courts.new')}
        </Button>
      </Flex>
      <PagedTable<Court>
        query={list}
        page={page}
        onPage={setPage}
        empty={t('admin.courts.empty')}
        testId="courts"
        columns={[
          {
            title: t('admin.courts.columns.nameAr'),
            render: (_, c) => <Bdi>{arabic ? c.nameAr : (c.nameEn ?? c.nameAr)}</Bdi>,
          },
          {
            title: t('admin.courts.columns.type'),
            render: (_, c) => t(`enums.courtType.${c.courtType}`),
          },
          { title: t('admin.courts.columns.city'), render: (_, c) => <Bdi>{c.city}</Bdi> },
          {
            title: t('admin.courts.columns.status'),
            render: (_, c) => (
              <StatusTag tone={c.isActive ? 'success' : 'neutral'}>
                {t(c.isActive ? 'admin.courts.active' : 'admin.courts.inactive')}
              </StatusTag>
            ),
          },
          {
            title: t('admin.courts.columns.actions'),
            render: (_, c) => (
              <Space>
                <Button
                  size="small"
                  onClick={() => setEditing(c)}
                  data-testid={`court-edit-${c.id}`}
                >
                  {t('common.actions.edit')}
                </Button>
                <Button
                  size="small"
                  onClick={() => void toggle(c)}
                  data-testid={`court-toggle-${c.id}`}
                >
                  {t(c.isActive ? 'admin.courts.deactivate' : 'admin.courts.activate')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {editing === 'new' ? (
        <CourtModal mode="create" jurisdiction={jurisdiction} onClose={() => setEditing(null)} />
      ) : editing ? (
        <CourtModal mode="edit" court={editing} onClose={() => setEditing(null)} />
      ) : null}
    </section>
  );
}
