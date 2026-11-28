import { useFormat } from '@nexlegtiq/shared-ui';
import { Alert } from 'antd';
import { useTranslation } from 'react-i18next';

import { useSubscription } from '../../settings';

/**
 * While the office is read-only: its subscription has ended (D-122) or its deletion is scheduled (D-251). Everything can
 * be read, nothing added or changed.
 */
export function ReadOnlyBanner(): React.JSX.Element | null {
  const { t } = useTranslation();
  const format = useFormat();
  const { data } = useSubscription();
  if (!data?.readOnly) return null;
  const title = data.deletionScheduledFor
    ? t('shell.readOnly.deletion', { date: format.dateTime(data.deletionScheduledFor) })
    : t('shell.readOnly.banner');
  return <Alert banner type="error" title={title} data-testid="read-only-banner" />;
}
