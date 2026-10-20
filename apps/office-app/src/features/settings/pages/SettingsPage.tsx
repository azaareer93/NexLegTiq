import { PageHeader } from '@nexlegtiq/shared-ui';
import { Flex } from 'antd';
import { useTranslation } from 'react-i18next';

import { SubscriptionSection } from '../components/SubscriptionSection';

/** `/settings` (`manage:office`, D-091). The subscription section comes first; office preferences join it later. */
export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Flex vertical gap={16} component="section" data-testid="page-settings">
      <PageHeader title={t('settings.title')} />
      <SubscriptionSection />
    </Flex>
  );
}
