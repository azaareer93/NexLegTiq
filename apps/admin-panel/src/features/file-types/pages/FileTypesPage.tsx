import type { AdminFileSubType, AdminFileType } from '@nexlegtiq/shared-contracts';
import { isErrorCode, JURISDICTIONS } from '@nexlegtiq/shared-types';
import type { Jurisdiction } from '@nexlegtiq/shared-types';
import {
  Bdi,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  Ltr,
  PageHeader,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { Button, Flex, Select, Space, Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FileTypeModal } from '../components/FileTypeModal';
import type { FileTypeTarget } from '../components/FileTypeModal';
import { useFileTypesList } from '../hooks';

type Row = AdminFileType | AdminFileSubType;

/** Columns shared by types and their sub-types: names, order, status. */
function useNameColumns<T extends Row>(): TableColumnsType<T> {
  const { t } = useTranslation();
  const format = useFormat();
  return [
    { title: t('admin.fileTypes.fields.nameAr'), render: (_, row) => <Bdi>{row.nameAr}</Bdi> },
    { title: t('admin.fileTypes.fields.nameEn'), render: (_, row) => <Bdi>{row.nameEn}</Bdi> },
    {
      title: t('admin.fileTypes.fields.sortOrder'),
      render: (_, row) => <Bdi>{format.number(row.sortOrder)}</Bdi>,
    },
    {
      title: t('admin.plans.columns.status'),
      render: (_, row) => (
        <StatusTag tone={row.isActive ? 'success' : 'neutral'}>
          {t(row.isActive ? 'admin.plans.active' : 'admin.plans.inactive')}
        </StatusTag>
      ),
    },
  ];
}

/** `/file-types`: the legal file types and sub-types of one country (MVP-175, D-261). */
export function FileTypesPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { referenceOf } = useApiErrorHandler();
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('PALESTINE');
  const [editing, setEditing] = useState<FileTypeTarget | null>(null);
  const query = useFileTypesList(jurisdiction);
  const typeColumns = useNameColumns<AdminFileType>();
  const subColumns = useNameColumns<AdminFileSubType>();

  const country = (
    <Select
      value={jurisdiction}
      onChange={setJurisdiction}
      aria-label={t('admin.fileTypes.country')}
      style={{ minInlineSize: 200 }}
      options={JURISDICTIONS.map((value) => ({ value, label: t(`enums.jurisdiction.${value}`) }))}
      data-testid="file-types-country"
    />
  );

  const subTable = (type: AdminFileType) => (
    <Flex vertical gap={8}>
      <Table<AdminFileSubType>
        size="small"
        rowKey="id"
        dataSource={type.subTypes}
        pagination={false}
        locale={{ emptyText: t('admin.fileTypes.noSubTypes') }}
        columns={[
          ...subColumns,
          {
            title: t('admin.plans.columns.actions'),
            render: (_, sub) => (
              <Button
                size="small"
                onClick={() => setEditing({ kind: 'subType', typeId: type.id, row: sub })}
                data-testid={`file-sub-type-edit-${sub.id}`}
              >
                {t('common.actions.edit')}
              </Button>
            ),
          },
        ]}
      />
      <div>
        <Button
          size="small"
          onClick={() => setEditing({ kind: 'subType', typeId: type.id })}
          data-testid={`file-sub-type-new-${type.code}`}
        >
          {t('admin.fileTypes.newSubType')}
        </Button>
      </div>
    </Flex>
  );

  const body = () => {
    if (query.isError) {
      const code = isApiError(query.error) ? query.error.code : undefined;
      return (
        <ErrorState
          code={code !== undefined && isErrorCode(code) ? code : undefined}
          requestId={referenceOf(query.error)}
          onRetry={() => void query.refetch()}
        />
      );
    }
    if (!query.data) return <LoadingSkeleton rows={6} />;
    if (query.data.length === 0) return <EmptyState title={t('admin.fileTypes.empty')} />;
    return (
      <Table<AdminFileType>
        data-testid="file-types-table"
        rowKey="id"
        dataSource={query.data}
        pagination={false}
        scroll={{ x: 'max-content' }}
        expandable={{ expandedRowRender: subTable, columnTitle: t('admin.fileTypes.subTypes') }}
        columns={[
          { title: t('admin.fileTypes.fields.code'), render: (_, row) => <Ltr>{row.code}</Ltr> },
          {
            title: t('admin.fileTypes.fields.numberCode'),
            render: (_, row) => <Ltr>{row.numberCode}</Ltr>,
          },
          ...typeColumns,
          {
            title: t('admin.plans.columns.actions'),
            render: (_, row) => (
              <Space>
                <Button
                  size="small"
                  onClick={() => setEditing({ kind: 'type', jurisdiction, row })}
                  data-testid={`file-type-edit-${row.code}`}
                >
                  {t('common.actions.edit')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
    );
  };

  return (
    <section data-testid="page-file-types">
      <PageHeader
        title={t('admin.fileTypes.title')}
        extra={
          <Flex gap={8} wrap>
            {country}
            <Button
              type="primary"
              onClick={() => setEditing({ kind: 'type', jurisdiction })}
              data-testid="file-type-new"
            >
              {t('admin.fileTypes.newType')}
            </Button>
          </Flex>
        }
      />
      {body()}
      {editing ? <FileTypeModal target={editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}
