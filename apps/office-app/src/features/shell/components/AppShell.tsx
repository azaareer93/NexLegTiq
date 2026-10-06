import { AppstoreOutlined } from '@ant-design/icons';
import { Bdi, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { Button, Drawer, Flex, Grid, Layout, Menu, theme, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useNavigate, useNavigation } from 'react-router';

import { APP_NAME } from '../../../app/app-name';
import { useSession } from '../../auth';
import { navKeyOf, PRIMARY_KEYS, useNavItems } from '../nav';
import { NotificationsBell, ProfileMenu } from './ProfileMenu';
import { QuickActions } from './QuickActions';
import { SearchOverlay } from './SearchOverlay';
import { VerifyBanner } from './VerifyBanner';

/**
 * The signed-in layout (frontend.md#shell, D-091). Width decides the navigation: ≥1200 px a full side menu the user can
 * collapse, 768–1199 px an icon-only side menu, under 768 px a bottom bar with "Menu" for the rest. AntD lays the side
 * menu out in the reading direction, so it sits on the right in Arabic.
 */
export function AppShell(): React.JSX.Element {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const officeName = useSession((state) => state.user?.officeName);
  const items = useNavItems();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const wide = screens.xl === true;
  const phone = screens.md !== true;
  const selected = navKeyOf(location.pathname);
  const menuItems: MenuProps['items'] = items.map((item) => ({
    key: item.key,
    icon: item.icon,
    label: t(`shell.nav.${item.key}`),
    'data-testid': `nav-${item.key}`,
  }));
  const go: MenuProps['onClick'] = ({ key }) => {
    setDrawerOpen(false);
    const target = items.find((item) => item.key === key);
    if (target) void navigate(target.path);
  };
  const menu = (
    <Menu mode="inline" items={menuItems} selectedKeys={selected ? [selected] : []} onClick={go} aria-label={t('shell.nav.label')} style={{ borderInlineEnd: 0 }} />
  );

  return (
    <Layout style={{ minBlockSize: '100vh' }} data-testid="app-shell">
      {phone ? null : (
        <Layout.Sider
          theme="light"
          width={232}
          collapsible={wide}
          collapsed={wide ? collapsed : true}
          onCollapse={setCollapsed}
          trigger={wide ? undefined : null}
          data-testid="app-sider"
          data-collapsed={wide ? collapsed : true}
        >
          {menu}
        </Layout.Sider>
      )}
      <Layout>
        <Layout.Header
          style={{
            background: token.colorBgContainer,
            borderBlockEnd: `1px solid ${token.colorBorderSecondary}`,
            paddingInline: token.paddingMD,
            position: 'sticky',
            insetBlockStart: 0,
            zIndex: 10,
          }}
        >
          <Flex align="center" justify="space-between" gap={token.paddingSM} style={{ blockSize: '100%' }}>
            <Flex align="baseline" gap={token.paddingXS} style={{ minInlineSize: 0 }}>
              {/* The product name is a brand, not translated; the logo replaces it once hosted. */}
              <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
                {APP_NAME}
              </Typography.Text>
              {phone ? null : (
                <Typography.Text type="secondary" ellipsis data-testid="office-name">
                  <Bdi>{officeName}</Bdi>
                </Typography.Text>
              )}
            </Flex>
            <Flex align="center" gap={token.paddingXS}>
              <SearchOverlay compact={!wide} />
              <QuickActions compact={phone} />
              <NotificationsBell />
              <ProfileMenu compact={!wide} />
            </Flex>
          </Flex>
        </Layout.Header>
        <VerifyBanner />
        <Layout.Content style={{ padding: token.paddingLG, paddingBlockEnd: phone ? 80 : token.paddingLG }}>
          {navigation.state === 'loading' ? <LoadingSkeleton /> : <Outlet />}
        </Layout.Content>
      </Layout>
      {phone ? (
        <nav aria-label={t('shell.nav.label')} data-testid="bottom-nav">
          <Flex
            justify="space-around"
            style={{
              position: 'fixed',
              insetInline: 0,
              insetBlockEnd: 0,
              zIndex: 10,
              background: token.colorBgContainer,
              borderBlockStart: `1px solid ${token.colorBorderSecondary}`,
              paddingBlock: token.paddingXXS,
            }}
          >
            {items
              .filter((item) => PRIMARY_KEYS.includes(item.key))
              .map((item) => (
                <BottomItem
                  key={item.key}
                  icon={item.icon}
                  // The bottom bar is narrow: the dashboard is "Home" there.
                  label={t(item.key === 'dashboard' ? 'shell.nav.home' : `shell.nav.${item.key}`)}
                  current={selected === item.key}
                  onClick={() => void navigate(item.path)}
                  testId={`bottom-${item.key}`}
                />
              ))}
            <BottomItem icon={<AppstoreOutlined />} label={t('shell.nav.more')} onClick={() => setDrawerOpen(true)} testId="bottom-more" />
          </Flex>
          <Drawer placement="bottom" open={drawerOpen} onClose={() => setDrawerOpen(false)} title={t('shell.nav.more')} size="large">
            {menu}
          </Drawer>
        </nav>
      ) : null}
    </Layout>
  );
}

interface BottomItemProps {
  readonly icon: ReactNode;
  readonly label: string;
  readonly current?: boolean;
  readonly onClick: () => void;
  readonly testId: string;
}

/** One bottom-bar entry: icon over a short label, sharing the width equally so five fit on a 360 px phone. */
function BottomItem({ icon, label, current = false, onClick, testId }: BottomItemProps): React.JSX.Element {
  const { token } = theme.useToken();
  return (
    <Button
      type="text"
      onClick={onClick}
      aria-current={current ? 'page' : undefined}
      data-testid={testId}
      style={{ flex: '1 1 0', minInlineSize: 0, blockSize: 'auto', paddingBlock: token.paddingXXS, paddingInline: 0, color: current ? token.colorPrimary : undefined }}
    >
      <Flex vertical align="center" gap={2} style={{ minInlineSize: 0, inlineSize: '100%' }}>
        {icon}
        <Typography.Text ellipsis style={{ fontSize: token.fontSizeSM, color: 'inherit', maxInlineSize: '100%' }}>
          {label}
        </Typography.Text>
      </Flex>
    </Button>
  );
}
