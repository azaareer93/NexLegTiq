import { GlobalOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { Bdi, DirectionalIcon, useLanguage } from '@nexlegtiq/shared-ui';
import { Avatar, Button, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { signOut, useSession } from '../../auth';

/**
 * Initials for the avatar: first letters of the first two words. Arabic letters would join into one cursive shape, so they
 * are kept apart with a zero-width non-joiner; Latin ones are upper-cased.
 */
export function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0] ?? '');
  return /^[A-Za-z]/.test(letters[0] ?? '')
    ? letters.join('').toLocaleUpperCase()
    : letters.join('‌');
}

/** The account menu: my account, language and sign-out. */
export function ProfileMenu({
  compact = false,
}: {
  readonly compact?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { locale, setLocale } = useLanguage();
  const user = useSession((state) => state.user);
  const name = user?.fullName ?? '';

  // The language applies at once; saving it to the profile comes with `PATCH users/me` (D-087 `onLocaleChange`).
  const items: MenuProps['items'] = [
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: t('shell.profile.profile'),
      'data-testid': 'menu-profile',
    },
    {
      key: 'language',
      icon: <GlobalOutlined />,
      label: t('shell.profile.language'),
      'data-testid': 'menu-language',
      children: [
        {
          key: 'lang-ar',
          label: <span lang="ar">{t('common.language.ar')}</span>,
          disabled: locale === 'ar',
          'data-testid': 'menu-lang-ar',
        },
        {
          key: 'lang-en',
          label: <span lang="en">{t('common.language.en')}</span>,
          disabled: locale === 'en',
          'data-testid': 'menu-lang-en',
        },
      ],
    },
    { type: 'divider' },
    // The sign-out arrow points out of the page, so it follows the reading direction.
    {
      key: 'logout',
      icon: <DirectionalIcon icon={LogoutOutlined} />,
      label: t('auth.logout'),
      danger: true,
      'data-testid': 'sign-out',
    },
  ];

  const onClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'profile') void navigate('/profile');
    else if (key === 'lang-ar') setLocale('ar');
    else if (key === 'lang-en') setLocale('en');
    else if (key === 'logout') void signOut();
  };

  return (
    // Submenus open on click: hover is unreliable on touch screens.
    <Dropdown menu={{ items, onClick, triggerSubMenuAction: 'click' }} trigger={['click']}>
      <Button
        type="text"
        // With the name visible, the name is the label (WCAG 2.5.3); icon-only, the menu says what it is and whose it is.
        aria-label={compact ? `${t('shell.profile.menu')} — ${name}` : undefined}
        data-testid="profile-menu"
        style={{ paddingInline: 4 }}
      >
        <Avatar size="small" aria-hidden="true">
          <bdi>{initialsOf(name)}</bdi>
        </Avatar>
        {compact ? null : <Bdi>{name}</Bdi>}
      </Button>
    </Dropdown>
  );
}
