import type { Notification } from '@nexlegtiq/shared-contracts';
import { EmptyState, useFormat } from '@nexlegtiq/shared-ui';
import { Badge, Button, Flex, List, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useMarkRead } from '../api/use-notifications';

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
  const navigate = useNavigate();
  const markRead = useMarkRead();

  if (items.length === 0) return <EmptyState description={emptyText} />;

  const open = (item: Notification) => {
    if (!item.readAt) markRead.mutate(item.id);
    onOpen?.();
    if (item.link) void navigate(item.link);
  };

  return (
    <List
      data-testid={testId}
      dataSource={[...items]}
      renderItem={(item) => {
        // A key this build does not know (a newer server) shows the generic title rather than the raw key.
        const title = i18n.exists(item.titleKey)
          ? t(item.titleKey as 'shell.notifications.open', item.params as Record<string, string>)
          : t('shell.notifications.open');
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
                      data-testid={`notification-read-${item.id}`}
                    >
                      {t('shell.notifications.markRead')}
                    </Button>,
                  ]
            }
          >
            <Flex vertical gap={2}>
              <Typography.Link
                strong={!item.readAt}
                onClick={() => open(item)}
                data-testid={`notification-open-${item.id}`}
              >
                {title}
              </Typography.Link>
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
