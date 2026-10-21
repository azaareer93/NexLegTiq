import { UploadOutlined } from '@ant-design/icons';
import type { DocumentListParams } from '@nexlegtiq/shared-api-client';
import type { Folder } from '@nexlegtiq/shared-contracts';
import { EmptyState, ErrorState, LoadingSkeleton, useCan } from '@nexlegtiq/shared-ui';
import { Button, Card, Col, Input, Row } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DocumentsTable } from './DocumentsTable';
import type { DocumentRights } from './DocumentsTable';
import { FolderTree } from './FolderTree';
import type { FolderSelection } from './FolderTree';
import { UploadPanel } from './UploadPanel';
import { useDocuments, useFolders } from './use-documents';
import { useCtrlAltShortcut } from '../quick-create';

const PAGE_SIZE = 20;

/** The list part of the tab: error, loading, the two empty states, or the table. */
function ListBody({
  fileId,
  list,
  filtered,
  folders,
  rights,
  page,
  onPage,
}: {
  readonly fileId: string;
  readonly list: ReturnType<typeof useDocuments>;
  readonly filtered: boolean;
  readonly folders: readonly Folder[];
  readonly rights: DocumentRights;
  readonly page: number;
  readonly onPage: (page: number) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  if (list.isError && !list.data) return <ErrorState onRetry={() => void list.refetch()} />;
  if (!list.data) return <LoadingSkeleton rows={5} />;
  if (list.data.items.length === 0) {
    return filtered ? (
      <EmptyState title={t('documents.list.emptyFolder')} />
    ) : (
      <EmptyState
        title={t('documents.list.empty')}
        description={rights.edit ? t('documents.list.emptyHint') : undefined}
      />
    );
  }
  return (
    <DocumentsTable
      fileId={fileId}
      documents={list.data.items}
      folders={folders}
      rights={rights}
      loading={list.isFetching && list.isPlaceholderData}
      pagination={{
        current: page,
        pageSize: PAGE_SIZE,
        total: list.data.pagination.total,
        onChange: onPage,
      }}
    />
  );
}

/** The upload button, its shortcut and the panel; nothing for users who may not upload. */
function UploadControls({
  fileId,
  folders,
  folderId,
}: {
  readonly fileId: string;
  readonly folders: readonly Folder[];
  readonly folderId: string | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [uploading, setUploading] = useState(false);
  // Ctrl+Alt+U (physical key; not while typing or inside a dialog).
  useCtrlAltShortcut('KeyU', !uploading, () => setUploading(true));
  return (
    <>
      <Button
        type="primary"
        icon={<UploadOutlined />}
        onClick={() => setUploading(true)}
        data-testid="documents-upload"
      >
        {t('documents.upload.open')}
      </Button>
      {/* Mounted per opening: a fresh queue, starting in the folder selected now. */}
      {uploading ? (
        <UploadPanel
          open
          fileId={fileId}
          folders={folders}
          defaultFolderId={folderId}
          onClose={() => setUploading(false)}
        />
      ) : null}
    </>
  );
}

/** The list query for a folder selection, a search and a page (strings, as the API reads them). */
function listQuery(selection: FolderSelection, search: string, page: number): DocumentListParams {
  const text = search.trim();
  return {
    ...(selection === 'all' ? {} : { folderId: selection }),
    ...(text ? { search: text } : {}),
    page: String(page),
    limit: String(PAGE_SIZE),
  };
}

/**
 * The Documents tab of a file (frontend.md, D-133): folder tree, list with live status (the realtime bridge refreshes
 * it on `document.processed`; it also polls while something is still being scanned or processed), upload panel and the
 * actions the user may take. Archived files offer no writes (the API refuses them, D-052).
 */
export function DocumentsTab({
  fileId,
  archived,
}: {
  readonly fileId: string;
  readonly archived: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const canUpload = useCan('upload:document') && !archived;
  const canDelete = useCan('delete:document') && !archived;
  const [selection, setSelection] = useState<FolderSelection>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const folders = useFolders(fileId).data ?? [];
  const list = useDocuments(fileId, listQuery(selection, search, page));
  // A page emptied by a delete (or a shorter list) goes back to the last page that has rows.
  const totalPages = list.data?.pagination.totalPages ?? 0;
  useEffect(() => {
    if (totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const folderId = folders.some((folder) => folder.id === selection) ? selection : null;
  const select = (next: FolderSelection) => {
    setSelection(next);
    setPage(1);
  };
  return (
    <Row gutter={[16, 16]} data-testid="case-documents">
      <Col xs={24} lg={7}>
        <FolderTree fileId={fileId} selected={selection} onSelect={select} canEdit={canUpload} />
      </Col>
      <Col xs={24} lg={17}>
        <Card
          title={
            <Input.Search
              allowClear
              placeholder={t('documents.list.search')}
              aria-label={t('documents.list.search')}
              onSearch={(value) => {
                setSearch(value);
                setPage(1);
              }}
              style={{ maxWidth: 320 }}
              data-testid="documents-search"
            />
          }
          extra={
            canUpload ? (
              <UploadControls fileId={fileId} folders={folders} folderId={folderId} />
            ) : null
          }
        >
          <ListBody
            fileId={fileId}
            list={list}
            filtered={selection !== 'all' || search.trim() !== ''}
            folders={folders}
            rights={{ edit: canUpload, delete: canDelete }}
            page={page}
            onPage={setPage}
          />
        </Card>
      </Col>
    </Row>
  );
}
