import { ApiError } from '@nexlegtiq/shared-api-client';
import { NewPasswordSchema, ResetPasswordRequestSchema } from '@nexlegtiq/shared-contracts';
import type { ResetPasswordRequest } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { useMutation } from '@tanstack/react-query';
import { Button, Flex, Form, Input, Result } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { parseForm, zodRule } from '../forms';
import { endSession, portalAuth, usePortalSession } from '../session';
import { useLinkToken } from '../use-link-token';

const FIELDS = ['newPassword', 'confirmPassword'];

/** The page of the emailed reset link: a used, expired or unknown link is 410 RES-004; a reset ends every session. */
export function ResetPasswordPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey: message, applyToForm } = useApiErrorHandler();
  const navigate = useNavigate();
  const token = useLinkToken();
  const [form] = Form.useForm();

  const reset = useMutation({
    gcTime: 0,
    mutationFn: (body: ResetPasswordRequest) => portalAuth.resetPassword(body),
    onSuccess: () => {
      if (usePortalSession.getState().status === 'authenticated') endSession(null);
      void navigate('/login?reason=passwordReset', { replace: true });
    },
    onError: (error) => applyToForm(form, error, FIELDS),
  });

  const invalidLink =
    !token ||
    (reset.error instanceof ApiError &&
      (reset.error.code === 'RES-004' || reset.error.details.some((d) => d.field === 'token')));
  if (invalidLink) {
    return (
      <AuthLayout title={t('auth.resetPassword.title')}>
        <Result
          status="warning"
          title={t('auth.resetPassword.invalidTitle')}
          subTitle={t('auth.resetPassword.invalidBody')}
          data-testid="reset-invalid"
          extra={
            <Link to="/forgot-password" data-testid="reset-request-new">
              {t('auth.resetPassword.requestNew')}
            </Link>
          }
        />
      </AuthLayout>
    );
  }

  const submit = (values: Record<string, unknown>) => {
    const body = parseForm(ResetPasswordRequestSchema, { ...values, token }, form, message);
    if (body) reset.mutate(body);
  };

  return (
    <AuthLayout title={t('auth.resetPassword.title')}>
      <Flex vertical gap={16}>
        <ApiErrorAlert error={reset.error} fields={FIELDS} />
        <Form
          form={form}
          noValidate
          layout="vertical"
          requiredMark={false}
          onFinish={submit}
          disabled={reset.isPending}
        >
          <Form.Item
            name="newPassword"
            label={t('auth.fields.newPassword')}
            extra={t('auth.passwordHint')}
            rules={zodRule(NewPasswordSchema, message)}
          >
            <Input.Password
              autoComplete="new-password"
              dir="ltr"
              autoFocus
              data-testid="reset-new-password"
            />
          </Form.Item>
          <Form.Item name="confirmPassword" label={t('auth.fields.confirmPassword')}>
            <Input.Password
              autoComplete="new-password"
              dir="ltr"
              data-testid="reset-confirm-password"
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            block
            size="large"
            loading={reset.isPending}
            data-testid="reset-submit"
          >
            {t('auth.resetPassword.submit')}
          </Button>
        </Form>
      </Flex>
    </AuthLayout>
  );
}
