import { EditOutlined, FolderAddOutlined } from '@ant-design/icons';
import { CreateFolderSchema } from '@nexlegtiq/shared-contracts';
import type { Folder } from '@nexlegtiq/shared-contracts';
import { ErrorState, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { App, Button, Card, Flex, Tag, Tree } from 'antd';
import type { TreeDataNode } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NameDialog } from './NameDialog';
import { useCreateFolder, useFolders, useRenameFolder } from './use-documents';

/** What the list shows: every document, those at the file's root, or one folder's. */
export type FolderSelection = 'all' | 'root' | string;

export function useFolderName(): (folder: Folder) => string {
  const { t } = useTranslation();
  return (folder) =>
    folder.systemKey ? t(`enums.folderSystemKey.${folder.systemKey}`) : (folder.name ?? '');
}

/** System folders first (as the API orders them), then the office's own; nested by `parentId`. */
function tree(
  folders: readonly Folder[],
  name: (folder: Folder) => string,
  parent: string | null = null,
): TreeDataNode[] {
  return folders
    .filter((folder) => folder.parentId === parent)
    .map((folder) => ({
      key: folder.id,
      title: (
        <span data-testid={`folder-${folder.id}`}>
          <bdi>{name(folder)}</bdi>{' '}
          {folder.documentCount > 0 ? <Tag bordered={false}>{folder.documentCount}</Tag> : null}
        </span>
      ),
      children: tree(folders, name, folder.id),
    }));
}

/** The folder tree of the Documents tab (D-119, D-133): select to filter; create anywhere, rename the office's own. */
export function FolderTree({
  fileId,
  selected,
  onSelect,
  canEdit,
}: {
  readonly fileId: string;
  readonly selected: FolderSelection;
  readonly onSelect: (selection: FolderSelection) => void;
  readonly canEdit: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const folders = useFolders(fileId);
  const create = useCreateFolder(fileId);
  const rename = useRenameFolder(fileId);
  const name = useFolderName();
  const [dialog, setDialog] = useState<'create' | 'rename' | null>(null);
  const current = folders.data?.find((folder) => folder.id === selected);

  if (folders.isError && !folders.data)
    return <ErrorState onRetry={() => void folders.refetch()} />;
  if (!folders.data) return <LoadingSkeleton rows={4} />;

  const nodes: TreeDataNode[] = [
    { key: 'all', title: <span data-testid="folder-all">{t('documents.folders.all')}</span> },
    { key: 'root', title: <span data-testid="folder-root">{t('documents.folders.root')}</span> },
    ...tree(folders.data, name),
  ];

  return (
    <Card
      size="small"
      title={t('documents.folders.title')}
      extra={
        canEdit ? (
          <Flex gap={4}>
            <Button
              type="text"
              size="small"
              icon={<FolderAddOutlined />}
              aria-label={t('documents.folders.new')}
              title={t('documents.folders.new')}
              onClick={() => setDialog('create')}
              data-testid="folder-new"
            />
            {current?.name ? (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label={t('documents.folders.rename')}
                title={t('documents.folders.rename')}
                onClick={() => setDialog('rename')}
                data-testid="folder-rename"
              />
            ) : null}
          </Flex>
        ) : null
      }
    >
      <Tree
        blockNode
        defaultExpandAll
        selectedKeys={[selected]}
        treeData={nodes}
        onSelect={(keys) => {
          const key = keys[0];
          if (key !== undefined) onSelect(String(key));
        }}
      />
      <NameDialog
        open={dialog === 'create'}
        title={t('documents.folders.new')}
        label={t('documents.folders.name')}
        okText={t('documents.folders.create')}
        schema={CreateFolderSchema.shape.name}
        // A new folder goes inside the selected folder; at the root otherwise.
        onSubmit={async (folderName) => {
          await create.mutateAsync({
            name: folderName,
            ...(current ? { parentId: current.id } : {}),
          });
          void message.success(t('documents.folders.created'));
        }}
        onClose={() => setDialog(null)}
        testId="folder-create-dialog"
      />
      <NameDialog
        open={dialog === 'rename'}
        title={t('documents.folders.rename')}
        label={t('documents.folders.name')}
        initial={current?.name ?? ''}
        okText={t('documents.folders.save')}
        schema={CreateFolderSchema.shape.name}
        onSubmit={async (folderName) => {
          if (!current) return;
          await rename.mutateAsync({ id: current.id, body: { name: folderName } });
          void message.success(t('documents.folders.renamed'));
        }}
        onClose={() => setDialog(null)}
        testId="folder-rename-dialog"
      />
    </Card>
  );
}
