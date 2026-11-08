import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  ErrorState,
  isApiError,
  LoadingSkeleton,
  PageHeader,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { Button, Card, Flex, Segmented } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMarkAllRead, useNotificationPages } from '../api/use-notifications';
import { NotificationList } from '../components/NotificationList';

/** `/notifications` (D-149): every notification of the signed-in user, newest first, all or unread only. */
export function NotificationsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { referenceOf, notify } = useApiErrorHandler();
  const [unread, setUnread] = useState(false);
  const pages = useNotificationPages(unread);
  const markAll = useMarkAllRead();
  const items = pages.data?.pages.flatMap((page) => page.items) ?? [];

  let body: React.ReactNode;
  if (pages.isError) {
    const { error } = pages;
    body = (
      <ErrorState
        code={isApiError(error) && isErrorCode(error.code) ? error.code : undefined}
        requestId={referenceOf(error)}
        onRetry={() => void pages.refetch()}
      />
    );
  } else if (!pages.data) {
    body = <LoadingSkeleton />;
  } else {
    body = (
      <Flex vertical gap={12}>
        <NotificationList
          items={items}
          testId="notifications-page-list"
          emptyText={t(unread ? 'shell.notifications.emptyUnread' : 'shell.notifications.empty')}
        />
        {pages.hasNextPage && (
          <Button
            onClick={() => void pages.fetchNextPage()}
            loading={pages.isFetchingNextPage}
            data-testid="notifications-more"
          >
            {t('shell.notifications.loadMore')}
          </Button>
        )}
      </Flex>
    );
  }

  return (
    <Flex vertical gap={16}>
      <PageHeader
        title={t('shell.notifications.open')}
        extra={
          <Button
            onClick={() => markAll.mutate(undefined, { onError: notify })}
            loading={markAll.isPending}
            data-testid="notifications-read-all"
          >
            {t('shell.notifications.markAllRead')}
          </Button>
        }
      />
      <Card>
        <Flex vertical gap={12}>
          <Segmented
            value={unread ? 'unread' : 'all'}
            onChange={(value) => setUnread(value === 'unread')}
            options={[
              { value: 'all', label: t('shell.notifications.all') },
              { value: 'unread', label: t('shell.notifications.unread') },
            ]}
            data-testid="notifications-filter"
          />
          {body}
        </Flex>
      </Card>
    </Flex>
  );
}
