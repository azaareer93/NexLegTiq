import { ApiError } from '@nexlegtiq/shared-api-client';
import { ResendVerificationRequestSchema } from '@nexlegtiq/shared-contracts';
import type { ResendVerificationRequest } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, LoadingSkeleton, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Flex, Form, Input, Result } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { parseForm, zodRule } from '../forms';
import { auth } from '../session';
import { useLinkToken } from '../use-link-token';

/**
 * The page of the emailed confirmation link (D-083). Works signed in or not; the link may belong to another account than
 * the one signed in here, so the session is left alone (its `emailVerified` updates with the next refresh).
 */
export function VerifyEmailPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey: message } = useApiErrorHandler();
  const token = useLinkToken();
  const [form] = Form.useForm();
  const sent = useRef(false);

  const verify = useMutation({ mutationFn: (value: string) => auth.verifyEmail({ token: value }) });
  const resend = useMutation({ mutationFn: (body: ResendVerificationRequest) => auth.resendVerification(body) });
  const { mutate: verifyToken } = verify;

  useEffect(() => {
    // Once per page: a link is single use, so a second call (React StrictMode runs effects twice) would report it invalid.
    if (token && !sent.current) {
      sent.current = true;
      verifyToken(token);
    }
  }, [token, verifyToken]);

  if (verify.isSuccess) {
    return (
      <AuthLayout title={t('auth.verifyEmail.successTitle')}>
        <Result
          status="success"
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

  const linkGone = !token || (verify.error instanceof ApiError && verify.error.code === 'RES-004');

  if (token && !linkGone) {
    // Waiting, or a failure that says nothing about the link (offline, 5xx, 429): the token was taken out of the address
    // bar, so this page is the only place left to retry it.
    return (
      <AuthLayout title={t('auth.verifyEmail.verifying')}>
        {verify.isError ? (
          <Flex vertical gap={16}>
            <ApiErrorAlert error={verify.error} testId="verify-error" />
            <Button type="primary" onClick={() => verifyToken(token)} loading={verify.isPending} data-testid="verify-retry">
              {t('common.actions.retry')}
            </Button>
          </Flex>
        ) : (
          <LoadingSkeleton rows={2} />
        )}
      </AuthLayout>
    );
  }

  const submit = (values: unknown) => {
    const body = parseForm(ResendVerificationRequestSchema, values, form, message);
    if (body) resend.mutate(body);
  };

  // No token, or a used/expired/unknown link (410 RES-004): offer a new link.
  return (
    <AuthLayout title={t('auth.verifyEmail.invalidTitle')} subtitle={t('auth.verifyEmail.invalidBody')}>
      <Flex vertical gap={16} data-testid="verify-invalid">
        {resend.isSuccess ? (
          <Alert type="success" showIcon title={t('auth.verifyEmail.resentBody')} data-testid="verify-resent" />
        ) : (
          <Form form={form} noValidate layout="vertical" requiredMark={false} onFinish={submit} disabled={resend.isPending}>
            <Flex vertical gap={16}>
              <ApiErrorAlert error={resend.error} />
              <Form.Item name="email" label={t('auth.fields.email')} rules={zodRule(ResendVerificationRequestSchema.shape.email, message)}>
                <Input type="email" autoComplete="email" dir="ltr" data-testid="verify-email" />
              </Form.Item>
            </Flex>
            <Button type="primary" htmlType="submit" block loading={resend.isPending} data-testid="verify-resend">
              {t('auth.verifyEmail.resend')}
            </Button>
          </Form>
        )}
      </Flex>
    </AuthLayout>
  );
}
