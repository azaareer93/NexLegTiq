import { Bdi, Ltr, PriorityTag } from '@nexlegtiq/shared-ui';
import { Card, Flex, Pagination, Spin, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { FileStatusTag, TitleLink } from './case-cells';
import type { CasesViewProps } from './CasesTable';

/** The phone list: one card per file, the whole card opens it, and a pager below. */
export function CasesCards({
  items,
  total,
  state,
  loading,
  onChange,
  onOpen,
}: CasesViewProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Spin spinning={loading}>
      <Flex vertical gap={12} data-testid="cases-cards">
        {items.map((row) => (
          <Card
            key={row.id}
            size="small"
            onClick={onOpen(row)}
            style={{ cursor: 'pointer' }}
            data-testid={`case-card-${row.id}`}
          >
            <Flex vertical gap={8}>
              <Typography.Text type="secondary">
                <Ltr>{row.fileNumber}</Ltr>
              </Typography.Text>
              <TitleLink row={row} />
              <Flex gap={4} wrap>
                <FileStatusTag status={row.status} />
                <PriorityTag priority={row.priority} />
                <Tag>{t(`enums.fileType.${row.fileType}`)}</Tag>
              </Flex>
              {row.primaryClient ? <Bdi>{row.primaryClient.displayName}</Bdi> : null}
              <Typography.Text type="secondary">
                <Bdi>{row.responsibleLawyer.fullName}</Bdi>
              </Typography.Text>
            </Flex>
          </Card>
        ))}
        <Pagination
          current={state.page}
          pageSize={state.limit}
          total={total}
          showSizeChanger={false}
          onChange={(next) => onChange({ page: next > 1 ? String(next) : undefined })}
          align="center"
        />
      </Flex>
    </Spin>
  );
}
