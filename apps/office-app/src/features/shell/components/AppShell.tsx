import { AppstoreOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons';
import { Bdi, DirectionalIcon, LoadingSkeleton, OfflineBanner } from '@nexlegtiq/shared-ui';
import { Button, Drawer, Flex, Grid, Layout, Menu, theme, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Outlet, useLocation, useNavigation } from 'react-router';

import { APP_NAME } from '../../../app/app-name';
import { useSession } from '../../auth';
import { navKeyOf, PRIMARY_KEYS, useNavItems } from '../nav';
import { NotificationsBell } from './NotificationsBell';
import { ProfileMenu } from './ProfileMenu';
import { QuickActions } from './QuickActions';
import { SearchOverlay } from './SearchOverlay';
import { VerifyBanner } from './VerifyBanner';

/** Height of the phone bottom bar, which the content keeps clear of (plus the iPhone home-indicator area). */
const BOTTOM_BAR_PX = 64;

/**
 * The signed-in layout (frontend.md#shell, D-091). Width decides the navigation: ≥1200 px a full side menu the user can
 * collapse, 768–1199 px an icon-only side menu, under 768 px a bottom bar with "Menu" for the rest. AntD lays the side
 * menu out in the reading direction, so it sits on the right in Arabic. Menu entries are links (new tab, screen readers).
 */
export function AppShell(): React.JSX.Element {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const location = useLocation();
  const navigation = useNavigation();
  const officeName = useSession((state) => state.user?.officeName);
  const items = useNavItems();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const wide = screens.xl === true;
  const phone = screens.md !== true;
  if (!phone && drawerOpen) {
    // Grown out of phone width: the drawer must not reappear when shrinking back.
    setDrawerOpen(false);
  }
  const selected = navKeyOf(location.pathname);
  // A skeleton only while moving to another page: a page reloading its own data (filters, after a save) stays mounted.
  const changingPage = navigation.state === 'loading' && navigation.location.pathname !== location.pathname;

  const menuItems: MenuProps['items'] = items.map((item) => ({
    key: item.key,
    icon: item.icon,
    label: (
      <Link to={item.path} onClick={() => setDrawerOpen(false)}>
        {t(`shell.nav.${item.key}`)}
      </Link>
    ),
    'data-testid': `nav-${item.key}`,
  }));
  const menu = <Menu mode="inline" items={menuItems} selectedKeys={selected ? [selected] : []} style={{ borderInlineEnd: 0 }} />;

  return (
    <Layout style={{ minBlockSize: '100vh' }} data-testid="app-shell">
      {phone ? null : (
        <Layout.Sider
          theme="light"
          width={232}
          collapsed={wide ? collapsed : true}
          trigger={null}
          data-testid="app-sider"
          data-collapsed={wide ? collapsed : true}
          style={{ position: 'sticky', insetBlockStart: 0, blockSize: '100vh', overflow: 'auto' }}
        >
          <Flex vertical justify="space-between" style={{ minBlockSize: '100%' }}>
            <nav aria-label={t('shell.nav.label')}>{menu}</nav>
            {wide ? (
              <Button
                type="text"
                block
                onClick={() => setCollapsed((value) => !value)}
                aria-expanded={!collapsed}
                aria-label={t(collapsed ? 'shell.nav.expand' : 'shell.nav.collapse')}
                icon={<DirectionalIcon icon={collapsed ? MenuUnfoldOutlined : MenuFoldOutlined} />}
                data-testid="sider-toggle"
                style={{ marginBlock: token.marginSM }}
              />
            ) : null}
          </Flex>
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
        <OfflineBanner />
        <VerifyBanner />
        <Layout.Content
          style={{
            padding: token.paddingLG,
            paddingBlockEnd: phone ? `calc(${BOTTOM_BAR_PX + token.paddingLG}px + env(safe-area-inset-bottom))` : token.paddingLG,
          }}
        >
          {changingPage ? <LoadingSkeleton /> : <Outlet />}
        </Layout.Content>
      </Layout>
      {phone ? (
        <>
          <nav aria-label={t('shell.nav.label')} data-testid="bottom-nav">
            <Flex
              style={{
                position: 'fixed',
                insetInline: 0,
                insetBlockEnd: 0,
                zIndex: 10,
                background: token.colorBgContainer,
                borderBlockStart: `1px solid ${token.colorBorderSecondary}`,
                paddingBlockStart: token.paddingXXS,
                paddingBlockEnd: `calc(${token.paddingXXS}px + env(safe-area-inset-bottom))`,
              }}
            >
              {items
                .filter((item) => PRIMARY_KEYS.includes(item.key))
                .map((item) => (
                  <BottomItem
                    key={item.key}
                    to={item.path}
                    icon={item.icon}
                    // The bottom bar is narrow: the dashboard is "Home" there.
                    label={t(item.key === 'dashboard' ? 'shell.nav.home' : `shell.nav.${item.key}`)}
                    current={selected === item.key}
                    testId={`bottom-${item.key}`}
                  />
                ))}
              <BottomItem icon={<AppstoreOutlined />} label={t('shell.nav.more')} onClick={() => setDrawerOpen(true)} testId="bottom-more" />
            </Flex>
          </nav>
          <Drawer placement="bottom" open={drawerOpen} onClose={() => setDrawerOpen(false)} title={t('shell.nav.more')}>
            {menu}
          </Drawer>
        </>
      ) : null}
    </Layout>
  );
}

interface BottomItemProps {
  readonly icon: ReactNode;
  readonly label: string;
  /** A link to a page, or (without `to`) a button such as "Menu". */
  readonly to?: string;
  readonly current?: boolean;
  readonly onClick?: () => void;
  readonly testId: string;
}

/** One bottom-bar entry: icon over a short label, sharing the width equally so five fit on a 360 px phone. */
function BottomItem({ icon, label, to, current = false, onClick, testId }: BottomItemProps): React.JSX.Element {
  const { token } = theme.useToken();
  const style: React.CSSProperties = {
    flex: '1 1 0',
    minInlineSize: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
    paddingBlock: token.paddingXXS,
    color: current ? token.colorPrimary : token.colorText,
    background: 'none',
    border: 0,
    cursor: 'pointer',
    font: 'inherit',
  };
  const content = (
    <>
      {icon}
      <Typography.Text ellipsis style={{ fontSize: token.fontSizeSM, color: 'inherit', maxInlineSize: '100%' }}>
        {label}
      </Typography.Text>
    </>
  );
  return to ? (
    <Link to={to} aria-current={current ? 'page' : undefined} data-testid={testId} style={style}>
      {content}
    </Link>
  ) : (
    <button type="button" onClick={onClick} data-testid={testId} style={style}>
      {content}
    </button>
  );
}
