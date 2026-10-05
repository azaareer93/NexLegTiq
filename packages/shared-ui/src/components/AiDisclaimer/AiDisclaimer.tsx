import { RobotOutlined } from '@ant-design/icons';
import { Alert } from 'antd';
import { useTranslation } from 'react-i18next';

/** Shown with every AI output (D-057, frontend.md): it may be wrong, and a person checks it before relying on it. */
export function AiDisclaimer(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Alert
      type="info"
      showIcon
      icon={<RobotOutlined aria-hidden />}
      title={t('common.ai.title')}
      description={t('common.ai.disclaimer')}
      data-testid="ai-disclaimer"
    />
  );
}
