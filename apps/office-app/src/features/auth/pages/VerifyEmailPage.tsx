import { ApiError } from '@nexlegtiq/shared-api-client';
import { ResendVerificationRequestSchema } from '@nexlegtiq/shared-contracts';
import type { ResendVerificationRequest } from '@nexlegtiq/shared-contracts';
import { LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Flex, Form, Input, Result } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { errorText, parseForm, useMessage, zodRule } from '../forms';
import { auth, useSession } from '../session';
import { useLinkToken } from '../use-link-token';

/** The page of the emailed confirmation link (D-083). Works signed in or not. */
export function VerifyEmailPage(): React.JSX.Element {
  const { t } = useTranslation();
  const message = useMessage();
  const token = useLinkToken();
  const [form] = Form.useForm();
  const sent = useRef(false);

  const verify = useMutation({
    mutationFn: (value: string) => auth.verifyEmail({ token: value }),
    onSuccess: () => {
      const { user } = useSession.getState();
      if (user) useSession.setState({ user: { ...user, emailVerified: true, verifyBy: null } });
    },
  });
  const resend = useMutation({ mutationFn: (body: ResendVerificationRequest) => auth.resendVerification(body) });

  useEffect(() => {
    // Once per page: a link is single use, so a second call (React StrictMode runs effects twice) would report it invalid.
    if (token && !sent.current) {
      sent.current = true;
      verify.mutate(token);
    }
  }, [token, verify]);

  if (verify.isSuccess) {
    return (
      <AuthLayout title={t('auth.verifyEmail.successTitle')}>
        <Result
          status="success"
          title={t('auth.verifyEmail.successTitle')}
          subTitle={t('auth.verifyEmail.successBody')}
          data-testid="verify-success"
          extra={
            <Link to="/" data-testid="verify-continue">
              {t('auth.verifyEmail.continue')}
            </Link>
          }
        />
      </AuthLayout>
    );
  }

  if (token && !verify.isError) {
    return (
      <AuthLayout title={t('auth.verifyEmail.verifying')}>
        <LoadingSkeleton rows={2} />
      </AuthLayout>
    );
  }

  const submit = (values: unknown) => {
    const body = parseForm(ResendVerificationRequestSchema, values, form, message);
    if (body) resend.mutate(body);
  };

  // No token, or a used/expired/unknown link (410 RES-004): offer a new link. Any other failure is shown as it is.
  return (
    <AuthLayout title={t('auth.verifyEmail.invalidTitle')} subtitle={t('auth.verifyEmail.invalidBody')}>
      <Flex vertical gap={16} data-testid="verify-invalid">
        {verify.isError && !(verify.error instanceof ApiError && verify.error.code === 'RES-004') ? (
          <Alert type="error" showIcon title={errorText(verify.error, message)} role="alert" />
        ) : null}
        {resend.isSuccess ? (
          <Alert type="success" showIcon title={t('auth.verifyEmail.resentBody')} data-testid="verify-resent" />
        ) : (
          <Form form={form} noValidate layout="vertical" requiredMark={false} onFinish={submit} disabled={resend.isPending}>
            {resend.isError ? <Alert type="error" showIcon title={errorText(resend.error, message)} role="alert" style={{ marginBlockEnd: 16 }} /> : null}
            <Form.Item name="email" label={t('auth.fields.email')} rules={zodRule(ResendVerificationRequestSchema.shape.email, message)}>
              <Input type="email" autoComplete="email" dir="ltr" data-testid="verify-email" />
            </Form.Item>
            <Button type="primary" htmlType="submit" block loading={resend.isPending} data-testid="verify-resend">
              {t('auth.verifyEmail.resend')}
            </Button>
          </Form>
        )}
      </Flex>
    </AuthLayout>
  );
}
