import { ApiError } from '@nexlegtiq/shared-api-client';
import { useFormat } from '@nexlegtiq/shared-ui';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Flex, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { auth, useSession } from '../../auth';

/** Until the email is confirmed (D-083): when access ends, and a way to get a new link. */
export function VerifyBanner(): React.JSX.Element | null {
  const { t, i18n } = useTranslation();
  const format = useFormat();
  const user = useSession((state) => state.user);
  const resend = useMutation({ mutationFn: (email: string) => auth.resendVerification({ email }) });

  if (!user || user.emailVerified) {
    return null;
  }
  const title = user.verifyBy ? t('shell.verify.bannerWithDeadline', { date: format.date(user.verifyBy, 'long') }) : t('shell.verify.banner');
  // A refusal says why (too many requests: wait), anything else gets the generic message.
  const failure =
    resend.error instanceof ApiError && i18n.exists(`errors.${resend.error.code}` as never)
      ? (t as unknown as (key: string) => string)(`errors.${resend.error.code}`)
      : t('common.states.error');

  return (
    <Alert
      banner
      type="warning"
      title={title}
      data-testid="verify-banner"
      action={
        resend.isSuccess ? (
          <span role="status" data-testid="verify-banner-sent">
            {t('shell.verify.sent')}
          </span>
        ) : (
          <Flex vertical align="end" gap={4}>
            <Button size="small" loading={resend.isPending} onClick={() => resend.mutate(user.email)} data-testid="verify-banner-resend">
              {t('shell.verify.resend')}
            </Button>
            {resend.isError ? (
              <Typography.Text type="danger" role="alert" data-testid="verify-banner-error">
                {failure}
              </Typography.Text>
            ) : null}
          </Flex>
        )
      }
    />
  );
}
