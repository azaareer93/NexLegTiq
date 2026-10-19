import { Alert } from 'antd';
import { useTranslation } from 'react-i18next';

import { useSubscription } from '../../settings';

/** While the office's subscription has ended (D-122): everything can be read, nothing added or changed. */
export function ReadOnlyBanner(): React.JSX.Element | null {
  const { t } = useTranslation();
  const { data } = useSubscription();
  if (!data?.readOnly) return null;
  return (
    <Alert banner type="error" title={t('shell.readOnly.banner')} data-testid="read-only-banner" />
  );
}
