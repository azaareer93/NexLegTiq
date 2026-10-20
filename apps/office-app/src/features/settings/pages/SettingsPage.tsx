import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  ConfirmModal,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  PageHeader,
} from '@nexlegtiq/shared-ui';
import { Flex } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import { useOfficeProfile, useOfficeSettings } from '../api/use-office';
import { DefaultsSection, SecuritySection } from '../components/DefaultsSections';
import { PreferencesSection, ProfileSection } from '../components/ProfileSections';
import { SubscriptionSection } from '../components/SubscriptionSection';

type Section = 'profile' | 'preferences' | 'defaults' | 'security';

/** Which sections have unsaved changes; leaving the page (in the app or the browser) asks first. */
function useUnsavedGuard() {
  const [dirty, setDirty] = useState<ReadonlySet<Section>>(new Set());
  const reporters = useMemo(() => {
    const report = (section: Section) => (isDirty: boolean) =>
      setDirty((current) => {
        if (current.has(section) === isDirty) return current;
        const next = new Set(current);
        if (isDirty) next.add(section);
        else next.delete(section);
        return next;
      });
    return {
      profile: report('profile'),
      preferences: report('preferences'),
      defaults: report('defaults'),
      security: report('security'),
    };
  }, []);
  const unsaved = dirty.size > 0;
  const blocker = useBlocker(
    useCallback(
      ({ currentLocation, nextLocation }) =>
        unsaved && currentLocation.pathname !== nextLocation.pathname,
      [unsaved],
    ),
  );
  useEffect(() => {
    if (!unsaved) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Safari and older Chromium show the prompt only with a return value.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  return { reporters, blocker };
}

/**
 * `/settings` (`manage:office`, D-091, D-125): office profile, preferences, practice defaults and security, each saved on
 * its own, then the subscription (read-only, D-122).
 */
export function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation();
  const profile = useOfficeProfile();
  const settings = useOfficeSettings();
  const { reporters, blocker } = useUnsavedGuard();
  const failed = profile.error ?? settings.error;

  const sections = () => {
    if (failed) {
      return (
        <ErrorState
          code={isApiError(failed) && isErrorCode(failed.code) ? failed.code : undefined}
          requestId={isApiError(failed) ? failed.requestId : undefined}
          onRetry={() => {
            void profile.refetch();
            void settings.refetch();
          }}
        />
      );
    }
    if (!profile.data || !settings.data) return <LoadingSkeleton rows={6} />;
    return (
      <>
        <ProfileSection profile={profile.data} onDirtyChange={reporters.profile} />
        <PreferencesSection profile={profile.data} onDirtyChange={reporters.preferences} />
        <DefaultsSection settings={settings.data} onDirtyChange={reporters.defaults} />
        <SecuritySection settings={settings.data} onDirtyChange={reporters.security} />
      </>
    );
  };

  return (
    <Flex vertical gap={16} component="section" data-testid="page-settings">
      <PageHeader title={t('settings.title')} />
      {sections()}
      <SubscriptionSection />
      <ConfirmModal
        open={blocker.state === 'blocked'}
        title={t('settings.unsaved.title')}
        danger
        confirmText={t('settings.unsaved.leave')}
        cancelText={t('settings.unsaved.stay')}
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      >
        {t('settings.unsaved.body')}
      </ConfirmModal>
    </Flex>
  );
}
