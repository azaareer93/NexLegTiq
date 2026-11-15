import { RocketOutlined } from '@ant-design/icons';
import { useCan } from '@nexlegtiq/shared-ui';
import { Alert, Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useOnboarding } from '../api/use-onboarding';

/** On the dashboard while the wizard is unfinished: back to the step where it stopped (D-181). */
export function OnboardingNudge() {
  const { t } = useTranslation();
  const mayRun = useCan('manage:office');
  const onboarding = useOnboarding(mayRun);
  if (onboarding.data?.state?.status !== 'ACTIVE') return null;
  return (
    <Alert
      type="info"
      showIcon
      icon={<RocketOutlined />}
      title={t('onboarding.nudge')}
      style={{ marginBlockEnd: 16 }}
      data-testid="onboarding-nudge"
      action={
        <Link to="/onboarding">
          <Button size="small" type="primary">
            {t('onboarding.continue')}
          </Button>
        </Link>
      }
    />
  );
}
