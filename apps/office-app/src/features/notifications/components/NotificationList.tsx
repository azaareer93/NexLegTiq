import { isAppPath } from '@nexlegtiq/shared-contracts';
import type { Notification } from '@nexlegtiq/shared-contracts';
import { EmptyState, useFormat } from '@nexlegtiq/shared-ui';
import { Badge, Button, Flex, List, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useMarkRead } from '../api/use-notifications';

/** i18next options that are not interpolation values: a param named like one never changes how the text is read. */
const RESERVED = new Set([
  'lng',
  'lngs',
  'ns',
  'context',
  'returnObjects',
  'defaultValue',
  'postProcess',
]);
const values = (params: Notification['params']): Record<string, string | number> =>
  Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => !RESERVED.has(key))
      .map(([key, value]) => [key, value ?? '']),
  );

interface NotificationListProps {
  readonly items: readonly Notification[];
  readonly emptyText: string;
  /** Called after a notification was opened (the bell closes itself). */
  readonly onOpen?: () => void;
  readonly testId: string;
}

/**
 * Notifications as a list (D-149): the text comes from the row's i18n key and params in the reader's language; an unread
 * one is marked with a dot and the word (never colour alone). Opening one marks it read and follows its link.
 */
export function NotificationList({
  items,
  emptyText,
  onOpen,
  testId,
}: NotificationListProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { relative } = useFormat();
  const markRead = useMarkRead();

  if (items.length === 0) return <EmptyState description={emptyText} />;

  const opened = (item: Notification) => {
    if (!item.readAt) markRead.mutate(item.id);
    onOpen?.();
  };

  return (
    <List
      data-testid={testId}
      dataSource={[...items]}
      renderItem={(item) => {
        // A key this build does not know (a newer server) shows the generic title rather than the raw key.
        const title = i18n.exists(item.titleKey)
          ? t(item.titleKey as 'shell.notifications.generic', values(item.params))
          : t('shell.notifications.generic');
        // Only a path of this app becomes a link (the server checks it too, D-149).
        const link = item.link && isAppPath(item.link) ? item.link : null;
        return (
          <List.Item
            key={item.id}
            data-testid={`notification-${item.id}`}
            actions={
              item.readAt
                ? []
                : [
                    <Button
                      key="read"
                      type="link"
                      size="small"
                      onClick={() => markRead.mutate(item.id)}
                      aria-label={t('shell.notifications.markReadOf', { title })}
                      data-testid={`notification-read-${item.id}`}
                    >
                      {t('shell.notifications.markRead')}
                    </Button>,
                  ]
            }
          >
            <Flex vertical gap={2}>
              {link ? (
                // A real link: keyboard, screen readers and "open in a new tab" all work.
                <Link
                  to={link}
                  onClick={() => opened(item)}
                  data-testid={`notification-open-${item.id}`}
                >
                  {item.readAt ? title : <strong>{title}</strong>}
                </Link>
              ) : (
                <Typography.Text strong={!item.readAt} data-testid={`notification-open-${item.id}`}>
                  {title}
                </Typography.Text>
              )}
              <Flex gap={8} wrap>
                <Typography.Text type="secondary">{relative(item.createdAt)}</Typography.Text>
                {!item.readAt && (
                  <Badge status="processing" text={t('shell.notifications.unreadDot')} />
                )}
              </Flex>
            </Flex>
          </List.Item>
        );
      }}
    />
  );
}
