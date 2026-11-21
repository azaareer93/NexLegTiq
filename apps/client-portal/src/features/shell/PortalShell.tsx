import { OfflineBanner } from '@nexlegtiq/shared-ui';
import { Button, Flex, Layout, Menu, Typography, theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation } from 'react-router';

import { LanguageSwitch } from './LanguageSwitch';
import { APP_NAME } from '../../app/app-name';
import { signOut, useOffices } from '../auth';

/**
 * Signed-in shell, phone first: the office's name as the brand (the product name when the account spans several
 * offices), language and sign-out, then the two sections. Content is one column, at most 720 px wide.
 */
export function PortalShell(): React.JSX.Element {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const { pathname } = useLocation();
  const offices = useOffices();
  const officeNames = [...new Set(offices.map((office) => office.officeName))];
  const brand = officeNames.length === 1 ? officeNames[0] : APP_NAME;
  const section = pathname.startsWith('/invoices') ? 'invoices' : 'files';

  return (
    <Layout style={{ minBlockSize: '100vh' }}>
      <OfflineBanner />
      <Layout.Header
        style={{
          background: token.colorBgContainer,
          borderBlockEnd: `1px solid ${token.colorBorderSecondary}`,
          blockSize: 'auto',
          lineHeight: 'normal',
          paddingInline: 16,
          paddingBlock: 8,
        }}
      >
        <Flex vertical gap={4} style={{ maxInlineSize: 720, marginInline: 'auto' }}>
          <Flex justify="space-between" align="center" gap={8}>
            <Typography.Text strong style={{ fontSize: 18 }} ellipsis data-testid="portal-brand">
              {brand}
            </Typography.Text>
            <Flex gap={8} align="center">
              <LanguageSwitch />
              <Button size="small" onClick={() => void signOut()} data-testid="sign-out">
                {t('portal.nav.signOut')}
              </Button>
            </Flex>
          </Flex>
          <Menu
            mode="horizontal"
            aria-label={t('portal.nav.menu')}
            selectedKeys={[section]}
            style={{ borderBlockEnd: 'none' }}
            items={[
              {
                key: 'files',
                label: (
                  <Link to="/" data-testid="nav-files">
                    {t('portal.nav.files')}
                  </Link>
                ),
              },
              {
                key: 'invoices',
                label: (
                  <Link to="/invoices" data-testid="nav-invoices">
                    {t('portal.nav.invoices')}
                  </Link>
                ),
              },
            ]}
          />
        </Flex>
      </Layout.Header>
      <Layout.Content style={{ paddingInline: 16, paddingBlock: 16 }}>
        <div style={{ maxInlineSize: 720, marginInline: 'auto' }} data-testid="portal-content">
          <Outlet />
        </div>
      </Layout.Content>
    </Layout>
  );
}
