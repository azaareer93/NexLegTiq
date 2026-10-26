import type { NotificationPreferences } from '@nexlegtiq/shared-contracts';
import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { Card, Switch, Table, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useUpdateNotificationPreferences } from '../api/use-profile';

type Row = NotificationPreferences[number];

/** One switch per category and channel (D-146); each change is saved at once. */
export function NotificationsCard({
  preferences,
}: {
  readonly preferences: NotificationPreferences;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { notify } = useApiErrorHandler();
  const update = useUpdateNotificationPreferences();
  const set = (row: Row, channel: 'inApp' | 'email', on: boolean) =>
    update.mutate({ [row.category]: { [channel]: on } }, { onError: notify });
  const label = (row: Row) => t(`enums.notificationCategory.${row.category}`);

  return (
    <Card title={t('profile.notifications.title')} data-testid="profile-notifications">
      <Table<Row>
        rowKey="category"
        dataSource={preferences}
        pagination={false}
        aria-label={t('profile.notifications.title')}
        size="small"
        columns={[
          { title: t('profile.notifications.category'), render: (_, row) => label(row) },
          {
            title: t('profile.notifications.inApp'),
            render: (_, row) => (
              <Switch
                checked={row.inApp}
                disabled={update.isPending}
                aria-label={t('profile.notifications.switchLabel', {
                  category: label(row),
                  channel: t('profile.notifications.inApp'),
                })}
                onChange={(on) => set(row, 'inApp', on)}
                data-testid={`pref-${row.category}-inApp`}
              />
            ),
          },
          {
            title: t('profile.notifications.email'),
            render: (_, row) =>
              row.email === null ? (
                <Typography.Text type="secondary">
                  {t('profile.notifications.noEmail')}
                </Typography.Text>
              ) : (
                <Switch
                  checked={row.email}
                  disabled={update.isPending}
                  aria-label={t('profile.notifications.switchLabel', {
                    category: label(row),
                    channel: t('profile.notifications.email'),
                  })}
                  onChange={(on) => set(row, 'email', on)}
                  data-testid={`pref-${row.category}-email`}
                />
              ),
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginBlockStart: 12, marginBlockEnd: 0 }}>
        {t('profile.notifications.hint')}
      </Typography.Paragraph>
    </Card>
  );
}
