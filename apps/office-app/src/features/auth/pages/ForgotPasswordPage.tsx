import { ForgotPasswordRequestSchema } from '@nexlegtiq/shared-contracts';
import type { ForgotPasswordRequest } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { useMutation } from '@tanstack/react-query';
import { Button, Flex, Form, Input, Result } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { parseForm, zodRule } from '../forms';
import { auth } from '../session';

/** Always the same answer, whether or not the email has an account (D-086). */
export function ForgotPasswordPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey: message } = useApiErrorHandler();
  const [form] = Form.useForm();
  const request = useMutation({ mutationFn: (body: ForgotPasswordRequest) => auth.forgotPassword(body) });

  const submit = (values: unknown) => {
    const body = parseForm(ForgotPasswordRequestSchema, values, form, message);
    if (body) request.mutate(body);
  };

  const backToLogin = (
    <Link to="/login" data-testid="back-to-login">
      {t('auth.forgotPassword.backToLogin')}
    </Link>
  );

  if (request.isSuccess) {
    return (
      <AuthLayout title={t('auth.forgotPassword.title')}>
        <Result status="success" title={t('auth.forgotPassword.sentTitle')} subTitle={t('auth.forgotPassword.sentBody')} extra={backToLogin} data-testid="forgot-sent" />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('auth.forgotPassword.title')} subtitle={t('auth.forgotPassword.subtitle')}>
      <Flex vertical gap={16}>
        <ApiErrorAlert error={request.error} />
        <Form form={form} noValidate layout="vertical" requiredMark={false} onFinish={submit} disabled={request.isPending}>
          <Form.Item name="email" label={t('auth.fields.email')} rules={zodRule(ForgotPasswordRequestSchema.shape.email, message)}>
            <Input type="email" autoComplete="email" dir="ltr" autoFocus data-testid="forgot-email" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={request.isPending} data-testid="forgot-submit">
            {t('auth.forgotPassword.submit')}
          </Button>
        </Form>
        <Flex justify="center">{backToLogin}</Flex>
      </Flex>
    </AuthLayout>
  );
}
