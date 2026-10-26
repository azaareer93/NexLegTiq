import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  ErrorState,
  isApiError,
  LoadingSkeleton,
  PageHeader,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { Flex } from 'antd';
import { useTranslation } from 'react-i18next';

import { useNotificationPreferences, useProfile } from '../api/use-profile';
import { AvatarCard } from '../components/AvatarCard';
import { NotificationsCard } from '../components/NotificationsCard';
import { PasswordCard } from '../components/PasswordCard';
import { DisplayForm, PersonalForm } from '../components/ProfileForms';

/** `/profile` (D-146): the signed-in user's own details, display preferences, password and notifications. */
export function ProfilePage(): React.JSX.Element {
  const { t } = useTranslation();
  const { referenceOf } = useApiErrorHandler();
  const profile = useProfile();
  const preferences = useNotificationPreferences();
  const failed = profile.isError ? profile : preferences.isError ? preferences : null;

  let body: React.ReactNode;
  if (failed) {
    const { error } = failed;
    body = (
      <div data-testid="profile-error">
        <ErrorState
          code={isApiError(error) && isErrorCode(error.code) ? error.code : undefined}
          requestId={referenceOf(error)}
          onRetry={() => void failed.refetch()}
        />
      </div>
    );
  } else if (!profile.data || !preferences.data) {
    body = <LoadingSkeleton />;
  } else {
    body = (
      <>
        <AvatarCard profile={profile.data} />
        <PersonalForm profile={profile.data} />
        <DisplayForm profile={profile.data} />
        <PasswordCard />
        <NotificationsCard preferences={preferences.data} />
      </>
    );
  }
  return (
    <Flex vertical gap={16} component="section" data-testid="page-profile">
      <PageHeader title={t('profile.title')} />
      {body}
    </Flex>
  );
}
