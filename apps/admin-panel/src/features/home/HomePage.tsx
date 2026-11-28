import { Button, Flex, Layout, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, Outlet } from 'react-router';

import { APP_NAME } from '../../app/app-name';
import { signOut, useAdminSession } from '../auth';

/** Signed-in shell: header with the admin's name and sign-out; the page goes in the content area. */
export function HomePage(): React.JSX.Element {
  const { t } = useTranslation();
  const admin = useAdminSession((state) => state.admin);
  return (
    <Layout style={{ minBlockSize: '100vh' }}>
      <Layout.Header style={{ background: 'transparent', paddingInline: 24 }}>
        <Flex justify="space-between" align="center" style={{ blockSize: '100%' }}>
          <Flex gap={24} align="center" wrap>
            <Typography.Text strong style={{ fontSize: 18 }}>
              {APP_NAME}
            </Typography.Text>
            <Link to="/offices" data-testid="nav-offices">
              {t('admin.offices.title')}
            </Link>
            <Link to="/plans" data-testid="nav-plans">
              {t('admin.plans.title')}
            </Link>
            <Link to="/usage" data-testid="nav-usage">
              {t('admin.usage.title')}
            </Link>
            <Link to="/analytics" data-testid="nav-analytics">
              {t('admin.analytics.title')}
            </Link>
            <Link to="/queues" data-testid="nav-queues">
              {t('admin.queues.title')}
            </Link>
            <Link to="/audit" data-testid="nav-audit">
              {t('admin.audit.title')}
            </Link>
            <Link to="/courts" data-testid="nav-courts">
              {t('admin.courts.title')}
            </Link>
          </Flex>
          <Flex gap={12} align="center">
            <Typography.Text data-testid="admin-name">{admin?.fullName}</Typography.Text>
            <Button onClick={() => void signOut()} data-testid="sign-out">
              {t('admin.home.signOut')}
            </Button>
          </Flex>
        </Flex>
      </Layout.Header>
      <Layout.Content style={{ padding: 24 }} data-testid="home-page">
        <Outlet />
      </Layout.Content>
    </Layout>
  );
}
