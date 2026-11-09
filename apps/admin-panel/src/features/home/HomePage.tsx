import { EmptyState, PageHeader } from '@nexlegtiq/shared-ui';
import { Button, Flex, Layout, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { APP_NAME } from '../../app/app-name';
import { signOut, useAdminSession } from '../auth/session';

/** Signed-in landing page until the offices, plans and usage screens (their own stories) arrive. */
export function HomePage(): React.JSX.Element {
  const { t } = useTranslation();
  const admin = useAdminSession((state) => state.admin);
  return (
    <Layout style={{ minBlockSize: '100vh' }}>
      <Layout.Header style={{ background: 'transparent', paddingInline: 24 }}>
        <Flex justify="space-between" align="center" style={{ blockSize: '100%' }}>
          <Typography.Text strong style={{ fontSize: 18 }}>
            {APP_NAME}
          </Typography.Text>
          <Flex gap={12} align="center">
            <Typography.Text data-testid="admin-name">{admin?.fullName}</Typography.Text>
            <Button onClick={() => void signOut()} data-testid="sign-out">
              {t('auth.idle.signOut')}
            </Button>
          </Flex>
        </Flex>
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }} data-testid="home-page">
        <PageHeader title={t('admin.home.title')} />
        <EmptyState description={t('admin.home.empty')} />
      </Layout.Content>
    </Layout>
  );
}
