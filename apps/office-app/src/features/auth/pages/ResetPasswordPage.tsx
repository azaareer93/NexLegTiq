import { ApiError } from '@nexlegtiq/shared-api-client';
import { NewPasswordSchema, ResetPasswordRequestSchema } from '@nexlegtiq/shared-contracts';
import type { ResetPasswordRequest } from '@nexlegtiq/shared-contracts';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Flex, Form, Input, Result } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { applyServerErrors, errorText, isFieldError, parseForm, useMessage, zodRule } from '../forms';
import { auth } from '../session';
import { useLinkToken } from '../use-link-token';

/** Fields the API's VAL-001 details are shown on. */
const FIELDS = ['newPassword', 'confirmPassword'];

/** The page of the emailed reset link: a used, expired or unknown link is 410 RES-004 (D-086). */
export function ResetPasswordPage(): React.JSX.Element {
  const { t } = useTranslation();
  const message = useMessage();
  const navigate = useNavigate();
  const token = useLinkToken();
  const [form] = Form.useForm();

  const reset = useMutation({
    mutationFn: (body: ResetPasswordRequest) => auth.resetPassword(body),
    // Every session of the user has ended (D-086): sign in again with the new password.
    onSuccess: () => void navigate('/login?reason=passwordReset', { replace: true }),
    onError: (error) => applyServerErrors(form, error, FIELDS, message),
  });

  const invalidLink = !token || (reset.error instanceof ApiError && (reset.error.code === 'RES-004' || reset.error.details.some((d) => d.field === 'token')));
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
        {reset.isError && !isFieldError(reset.error, FIELDS) ? <Alert type="error" showIcon title={errorText(reset.error, message)} role="alert" /> : null}
        <Form form={form} noValidate layout="vertical" requiredMark={false} onFinish={submit} disabled={reset.isPending}>
          <Form.Item name="newPassword" label={t('auth.fields.newPassword')} extra={t('auth.passwordHint')} rules={zodRule(NewPasswordSchema, message)}>
            <Input.Password autoComplete="new-password" autoFocus data-testid="reset-new-password" />
          </Form.Item>
          <Form.Item name="confirmPassword" label={t('auth.fields.confirmPassword')}>
            <Input.Password autoComplete="new-password" data-testid="reset-confirm-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={reset.isPending} data-testid="reset-submit">
            {t('auth.resetPassword.submit')}
          </Button>
        </Form>
      </Flex>
    </AuthLayout>
  );
}
