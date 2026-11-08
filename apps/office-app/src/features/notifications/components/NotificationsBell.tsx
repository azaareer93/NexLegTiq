import { BellOutlined } from '@ant-design/icons';
import { EmptyState } from '@nexlegtiq/shared-ui';
import { Badge, Button, Popover } from 'antd';
import { useTranslation } from 'react-i18next';

/** The bell: a slot for the notifications feature, with its empty state until then. The popover belongs to the button. */
export function NotificationsBell(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Popover trigger="click" content={<EmptyState description={t('shell.notifications.empty')} />}>
      <Button
        type="text"
        aria-label={t('shell.notifications.open')}
        data-testid="notifications"
        icon={
          <Badge count={0} size="small">
            <BellOutlined />
          </Badge>
        }
      />
    </Popover>
  );
}
