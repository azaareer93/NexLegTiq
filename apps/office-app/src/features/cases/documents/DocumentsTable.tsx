import { MoreOutlined } from '@ant-design/icons';
import type { Document, Folder } from '@nexlegtiq/shared-contracts';
import { Bdi, StatusTag, useApiErrorHandler, useFormat } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, Dropdown, Flex, Table, Tag, Tooltip, Typography } from 'antd';
import type { MenuProps, TableColumnsType } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { retryable, STATUS_TONE } from './document-upload';
import { DocumentDialogs } from './DocumentDialogs';
import type { Dialog, DialogKind } from './DocumentDialogs';
import { useRetryDocument } from './use-documents';

/** File sizes in the reader's language: B, KB or MB with one decimal. */
export function useSize(): (bytes: number) => string {
  const { t } = useTranslation();
  const format = useFormat();
  return (bytes) => {
    if (bytes < 1024) return t('documents.size.bytes', { value: format.number(bytes) });
    if (bytes < 1024 * 1024) {
      return t('documents.size.kb', { value: format.number(Math.round(bytes / 102.4) / 10) });
    }
    return t('documents.size.mb', { value: format.number(Math.round(bytes / 104_857.6) / 10) });
  };
}

export interface DocumentRights {
  /** Rename, move, upload and retry (`upload:document`; the API checks the file and the uploader, D-128). */
  readonly edit: boolean;
  readonly delete: boolean;
}

/** The status tag; a FAILED one says why in its tooltip (EXT-002 / VAL-005, D-132). */
function DocumentStatus({ document }: { readonly document: Document }): React.JSX.Element {
  const { t } = useTranslation();
  const { messageOf } = useApiErrorHandler();
  const tag = (
    <StatusTag tone={STATUS_TONE[document.status]}>
      {t(`enums.documentStatus.${document.status}`)}
    </StatusTag>
  );
  if (document.status !== 'FAILED' || !document.processingErrorCode) return tag;
  return <Tooltip title={messageOf({ code: document.processingErrorCode })}>{tag}</Tooltip>;
}

function DocumentName({ document }: { readonly document: Document }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Flex gap={6} align="center" wrap>
      <Typography.Text strong>
        <bdi>{document.name}</bdi>
      </Typography.Text>
      {document.currentVersion > 1 ? (
        <Tooltip title={t('documents.list.versionLabel', { number: document.currentVersion })}>
          <Tag bordered={false}>
            <bdi>{t('documents.list.version', { number: document.currentVersion })}</bdi>
          </Tag>
        </Tooltip>
      ) : null}
      {document.isConfidential ? (
        <Tag color="purple">{t('documents.list.confidential')}</Tag>
      ) : null}
    </Flex>
  );
}

function useColumns(
  rights: DocumentRights,
  onPick: (document: Document, key: string) => void,
): TableColumnsType<Document> {
  const { t } = useTranslation();
  const format = useFormat();
  const size = useSize();
  const menu = (document: Document): NonNullable<MenuProps['items']> =>
    [
      rights.edit ? { key: 'rename', label: t('documents.actions.rename') } : null,
      rights.edit ? { key: 'move', label: t('documents.actions.move') } : null,
      rights.edit && retryable(document)
        ? { key: 'retry', label: t('documents.actions.retry') }
        : null,
      rights.delete ? { key: 'delete', label: t('documents.actions.delete'), danger: true } : null,
    ].filter((item) => item !== null);
  return [
    {
      key: 'name',
      title: t('documents.list.name'),
      render: (_, d) => <DocumentName document={d} />,
    },
    {
      key: 'type',
      title: t('documents.list.type'),
      render: (_, d) => t(`enums.documentType.${d.documentType}`),
    },
    {
      key: 'status',
      title: t('documents.list.status'),
      render: (_, d) => <DocumentStatus document={d} />,
    },
    {
      key: 'language',
      title: t('documents.list.language'),
      render: (_, d) => (d.language ? t(`enums.documentLanguage.${d.language}`) : null),
    },
    {
      key: 'uploadedBy',
      title: t('documents.list.uploadedBy'),
      render: (_, d) => <bdi>{d.uploadedBy.fullName}</bdi>,
    },
    {
      key: 'updatedAt',
      title: t('documents.list.updatedAt'),
      render: (_, d) => <Bdi>{format.dateTime(d.updatedAt)}</Bdi>,
    },
    { key: 'size', title: t('documents.list.size'), render: (_, d) => size(d.sizeBytes) },
    {
      key: 'actions',
      title: t('documents.list.actions'),
      width: 56,
      render: (_, document) => {
        const items = menu(document);
        return items.length > 0 ? (
          <Dropdown
            menu={{ items, onClick: ({ key }) => onPick(document, key) }}
            trigger={['click']}
          >
            <Button
              type="text"
              icon={<MoreOutlined />}
              aria-label={t('documents.actions.menu', { name: isolate(document.name) })}
              data-testid={`document-actions-${document.id}`}
            />
          </Dropdown>
        ) : null;
      },
    },
  ];
}

/** The list of the Documents tab (D-133): status tags, version badge, and the actions the user may take. */
export function DocumentsTable({
  fileId,
  documents,
  folders,
  rights,
  loading,
  pagination,
}: {
  readonly fileId: string;
  readonly documents: readonly Document[];
  readonly folders: readonly Folder[];
  readonly rights: DocumentRights;
  readonly loading: boolean;
  readonly pagination: {
    current: number;
    pageSize: number;
    total: number;
    onChange: (page: number) => void;
  };
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const retry = useRetryDocument(fileId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const columns = useColumns(rights, (document, key) => {
    if (key !== 'retry') {
      setDialog({ kind: key as DialogKind, document });
      return;
    }
    retry.mutate(document.id, {
      onSuccess: () => void message.success(t('documents.actions.retried')),
      onError: notify,
    });
  });
  return (
    <>
      <Table<Document>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={[...documents]}
        loading={loading}
        scroll={{ x: 'max-content' }}
        pagination={
          pagination.total > pagination.pageSize ? { ...pagination, showSizeChanger: false } : false
        }
        onRow={(document) =>
          ({ 'data-testid': `document-row-${document.id}` }) as React.HTMLAttributes<HTMLElement>
        }
      />
      <DocumentDialogs
        fileId={fileId}
        dialog={dialog}
        folders={folders}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
