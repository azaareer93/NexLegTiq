import type { AuditEntry } from '@nexlegtiq/shared-contracts';
import { Bdi, Ltr, useFormat } from '@nexlegtiq/shared-ui';
import { Button, Flex, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

const ACTION_COLOR: Partial<Record<AuditEntry['action'], string>> = {
  DELETE: 'error',
  PERMISSION_DENIED: 'error',
  SECURITY: 'warning',
  EXPORT: 'processing',
};

function Actor({ actor }: { readonly actor: AuditEntry['actor'] }) {
  const { t } = useTranslation();
  if (actor.type === 'USER' && actor.name) return <Bdi>{actor.name}</Bdi>;
  return <>{t(`audit.actor.${actor.type}`)}</>;
}

/**
 * Audit rows (D-180): time in the user's zone, who, the action in words, the entity and the fields written. Field names
 * are the stored ones (technical, LTR).
 */
export function AuditTable({
  entries,
  loading,
  hasMore,
  loadingMore,
  onMore,
}: {
  readonly entries: readonly AuditEntry[];
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onMore: () => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Flex vertical gap={12}>
      <Table<AuditEntry>
        rowKey="id"
        size="small"
        loading={loading}
        pagination={false}
        dataSource={[...entries]}
        locale={{ emptyText: t('audit.empty') }}
        scroll={{ x: 720 }}
        data-testid="audit-table"
        columns={[
          {
            key: 'time',
            title: t('audit.columns.time'),
            render: (_, e) => <Bdi>{format.dateTime(e.occurredAt)}</Bdi>,
          },
          {
            key: 'actor',
            title: t('audit.columns.actor'),
            render: (_, e) => <Actor actor={e.actor} />,
          },
          {
            key: 'action',
            title: t('audit.columns.action'),
            render: (_, e) => (
              <Tag color={ACTION_COLOR[e.action]}>{t(`enums.auditAction.${e.action}`)}</Tag>
            ),
          },
          {
            key: 'entity',
            title: t('audit.columns.entity'),
            render: (_, e) => t(`audit.entity.${e.entityType}`, { defaultValue: e.entityType }),
          },
          {
            key: 'changes',
            title: t('audit.columns.changes'),
            render: (_, e) =>
              e.changes.length ? (
                <Typography.Text type="secondary">
                  {t('audit.changed', { count: e.changes.length })}{' '}
                  <Ltr>{e.changes.map((c) => c.field).join(', ')}</Ltr>
                </Typography.Text>
              ) : null,
          },
        ]}
      />
      {hasMore ? (
        <Button
          onClick={onMore}
          loading={loadingMore}
          style={{ alignSelf: 'center' }}
          data-testid="audit-more"
        >
          {t('audit.loadMore')}
        </Button>
      ) : null}
    </Flex>
  );
}
