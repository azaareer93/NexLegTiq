import { LockOutlined } from '@ant-design/icons';
import type { CaseListItem } from '@nexlegtiq/shared-contracts';
import type { FileStatus } from '@nexlegtiq/shared-types';
import { Bdi, StatusTag } from '@nexlegtiq/shared-ui';
import type { StatusTone } from '@nexlegtiq/shared-ui';
import { Flex, Tag } from 'antd';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

const STATUS_TONE: Record<FileStatus, StatusTone> = {
  OPEN: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'neutral',
  ARCHIVED: 'info',
};

export function FileStatusTag({ status }: { readonly status: FileStatus }): React.JSX.Element {
  const { t } = useTranslation();
  return <StatusTag tone={STATUS_TONE[status]}>{t(`enums.fileStatus.${status}`)}</StatusTag>;
}

/** The file's title as a link to its page (keyboard and new-tab friendly), with the confidential mark. */
export function TitleLink({ row }: { readonly row: CaseListItem }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Flex gap={8} align="center" wrap>
      <Link to={`/cases/${row.id}`} data-testid={`case-link-${row.id}`}>
        <Bdi>{row.title}</Bdi>
      </Link>
      {row.isConfidential ? (
        <Tag icon={<LockOutlined aria-hidden />}>{t('cases.list.confidential')}</Tag>
      ) : null}
    </Flex>
  );
}

/** A plain click on a row or card outside its link (the link handles itself, also Ctrl/middle-click to a new tab). */
export const isPlainClick = (event: MouseEvent): boolean =>
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !(event.target as Element).closest('a');
