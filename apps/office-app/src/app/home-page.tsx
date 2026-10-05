import { Button, Flex, Typography } from 'antd';
import { Trans, useTranslation } from 'react-i18next';

import { signOut, useSession } from '../features/auth';
import { APP_NAME } from './app-name';

/** Placeholder until the app shell (MVP-45) lands: who is signed in, and a way out. */
export function HomePage(): React.JSX.Element {
  const { t } = useTranslation();
  const user = useSession((state) => state.user);
  return (
    <main data-testid="home-page">
      <Flex vertical align="start" gap={16} style={{ padding: 24 }}>
        {/* The product name is a brand, not translated. */}
        <Typography.Title level={1}>{APP_NAME}</Typography.Title>
        <Typography.Text>
          <Trans i18nKey="auth.home.welcome" values={{ name: user?.fullName ?? '' }} components={{ name: <bdi /> }} />
        </Typography.Text>
        <Button onClick={() => void signOut()} data-testid="sign-out">
          {t('auth.logout')}
        </Button>
      </Flex>
    </main>
  );
}
