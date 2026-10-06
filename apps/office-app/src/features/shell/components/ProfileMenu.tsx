import { BellOutlined, GlobalOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { Bdi, EmptyState, useLanguage } from '@nexlegtiq/shared-ui';
import { Avatar, Badge, Button, Dropdown, Popover } from 'antd';
import type { MenuProps } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { signOut, useSession } from '../../auth';

/** The bell: a slot for the notifications feature, with its empty state until then. */
export function NotificationsBell(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Popover trigger="click" content={<EmptyState description={t('shell.notifications.empty')} />}>
      <Badge count={0} size="small">
        <Button type="text" icon={<BellOutlined />} aria-label={t('shell.notifications.open')} data-testid="notifications" />
      </Badge>
    </Popover>
  );
}

/** Initials for the avatar: first letters of the first two words, in the name's own script. */
const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0])
    .join('');

/** The account menu: profile, language and sign-out. */
export function ProfileMenu({ compact = false }: { readonly compact?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { locale, setLocale } = useLanguage();
  const user = useSession((state) => state.user);

  // The language applies at once; saving it to the profile comes with `PATCH users/me` (D-087 `onLocaleChange`).
  const items: MenuProps['items'] = [
    { key: 'profile', icon: <UserOutlined />, label: t('shell.profile.profile'), 'data-testid': 'menu-profile' },
    {
      key: 'language',
      icon: <GlobalOutlined />,
      label: t('shell.profile.language'),
      children: [
        { key: 'lang-ar', label: <span lang="ar">{t('common.language.ar')}</span>, disabled: locale === 'ar', 'data-testid': 'menu-lang-ar' },
        { key: 'lang-en', label: <span lang="en">{t('common.language.en')}</span>, disabled: locale === 'en', 'data-testid': 'menu-lang-en' },
      ],
    },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: t('auth.logout'), danger: true, 'data-testid': 'sign-out' },
  ];

  const onClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'profile') void navigate('/profile');
    else if (key === 'lang-ar') setLocale('ar');
    else if (key === 'lang-en') setLocale('en');
    else if (key === 'logout') void signOut();
  };

  return (
    <Dropdown menu={{ items, onClick }} trigger={['click']}>
      <Button type="text" aria-label={t('shell.profile.menu')} data-testid="profile-menu" style={{ paddingInline: 4 }}>
        <Avatar size="small" aria-hidden="true">
          {initialsOf(user?.fullName ?? '')}
        </Avatar>
        {compact ? null : <Bdi>{user?.fullName}</Bdi>}
      </Button>
    </Dropdown>
  );
}
