import { DownloadOutlined } from '@ant-design/icons';
import { ApiErrorAlert } from '@nexlegtiq/shared-ui';
import { Button, Card, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useMyDataDownload } from '../../settings/components/DataSection';

/** Profile → your own data as a JSON file (MVP-106, D-184), for every user. */
export function MyDataCard() {
  const { t } = useTranslation();
  const download = useMyDataDownload();
  return (
    <Card title={t('profile.myData.title')} data-testid="profile-my-data">
      <Typography.Paragraph type="secondary">{t('profile.myData.hint')}</Typography.Paragraph>
      <Button
        icon={<DownloadOutlined />}
        loading={download.isPending}
        onClick={() => download.mutate()}
        data-testid="my-data-download"
      >
        {t('profile.myData.download')}
      </Button>
      {download.isError ? <ApiErrorAlert error={download.error} /> : null}
    </Card>
  );
}
