import { AuditOutlined } from '@ant-design/icons';
import { useCan } from '@nexlegtiq/shared-ui';
import { Button, Card, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

/** Settings → the office's audit log (D-180), for `view:audit` holders. */
export function AuditLink() {
  const { t } = useTranslation();
  if (!useCan('view:audit')) return null;
  return (
    <Card title={t('audit.title')} data-testid="settings-audit">
      <Typography.Paragraph type="secondary">{t('audit.settingsHint')}</Typography.Paragraph>
      <Link to="/settings/audit">
        <Button icon={<AuditOutlined />} data-testid="settings-audit-open">
          {t('audit.settingsLink')}
        </Button>
      </Link>
    </Card>
  );
}
