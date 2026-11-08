import { BellOutlined } from '@ant-design/icons';
import { LoadingSkeleton, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { Badge, Button, Flex, Popover, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { NotificationList } from './NotificationList';
import { useLatestNotifications, useMarkAllRead, useUnreadCount } from '../api/use-notifications';

/**
 * The bell (D-149): the unread count, and on click the latest ten notifications with "mark all as read" and a link to
 * the notifications page. The list loads only once opened; the realtime bridge refreshes both on a new notification.
 */
export function NotificationsBell(): React.JSX.Element {
  const { t } = useTranslation();
  const { notify, messageOf } = useApiErrorHandler();
  const [open, setOpen] = useState(false);
  const count = useUnreadCount().data?.count ?? 0;
  const latest = useLatestNotifications(open);
  const markAll = useMarkAllRead();

  const content = (
    <Flex
      vertical
      gap={8}
      style={{ inlineSize: 'min(360px, 85vw)' }}
      data-testid="notifications-panel"
    >
      <Flex justify="space-between" align="center" gap={8}>
        <Typography.Text strong>{t('shell.notifications.open')}</Typography.Text>
        {count > 0 && (
          <Button
            type="link"
            size="small"
            onClick={() => markAll.mutate(undefined, { onError: notify })}
            data-testid="notifications-bell-read-all"
          >
            {t('shell.notifications.markAllRead')}
          </Button>
        )}
      </Flex>
      {latest.isError ? (
        <Typography.Text type="danger" role="alert">
          {messageOf(latest.error)}
        </Typography.Text>
      ) : latest.data ? (
        <NotificationList
          items={latest.data.items}
          emptyText={t('shell.notifications.empty')}
          onOpen={() => setOpen(false)}
          testId="notifications-bell-list"
        />
      ) : (
        <LoadingSkeleton />
      )}
      <Link to="/notifications" onClick={() => setOpen(false)} data-testid="notifications-view-all">
        {t('shell.notifications.viewAll')}
      </Link>
    </Flex>
  );

  return (
    <Popover trigger="click" open={open} onOpenChange={setOpen} content={content}>
      <Button
        type="text"
        aria-label={
          count > 0
            ? t('shell.notifications.openWithCount', { count })
            : t('shell.notifications.open')
        }
        data-testid="notifications"
        icon={
          <Badge count={count} size="small" overflowCount={99} aria-hidden>
            <BellOutlined />
          </Badge>
        }
      />
    </Popover>
  );
}
