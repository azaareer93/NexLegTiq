import { useLanguage } from '@nexlegtiq/shared-ui';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button } from 'antd';
import { useTranslation } from 'react-i18next';

import { auth, useSession } from '../../auth';

/** Until the email is confirmed (D-083): when access ends, and a way to get a new link. */
export function VerifyBanner(): React.JSX.Element | null {
  const { t } = useTranslation();
  const { locale } = useLanguage();
  const user = useSession((state) => state.user);
  const resend = useMutation({ mutationFn: (email: string) => auth.resendVerification({ email }) });

  if (!user || user.emailVerified) {
    return null;
  }
  const deadline = user.verifyBy
    ? ` ${t('shell.verify.deadline', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(user.verifyBy)) })}`
    : '';
  return (
    <Alert
      banner
      type="warning"
      title={t('shell.verify.banner') + deadline}
      data-testid="verify-banner"
      action={
        resend.isSuccess ? (
          <span data-testid="verify-banner-sent">{t('shell.verify.sent')}</span>
        ) : (
          <Button size="small" loading={resend.isPending} onClick={() => resend.mutate(user.email)} data-testid="verify-banner-resend">
            {t('shell.verify.resend')}
          </Button>
        )
      }
    />
  );
}
