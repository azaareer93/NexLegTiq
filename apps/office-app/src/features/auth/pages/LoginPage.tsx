import { LoginRequestSchema } from '@nexlegtiq/shared-contracts';
import type { LoginRequest } from '@nexlegtiq/shared-contracts';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Flex, Form, Input, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { applyServerErrors, parseForm, safeNext, useMessage, zodRule } from '../forms';
import { auth, broadcast, startSession } from '../session';

/** Fields the API's VAL-001 details are shown on. */
const FIELDS = ['email', 'password'];

const NOTICES = ['idle', 'expired', 'signedOut', 'passwordReset'] as const;
type Notice = (typeof NOTICES)[number];
const isNotice = (value: string | null): value is Notice => NOTICES.includes(value as Notice);

export function LoginPage(): React.JSX.Element {
  const { t } = useTranslation();
  const message = useMessage();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form] = Form.useForm();
  const reason = params.get('reason');

  const login = useMutation({
    // Never keep the password in the mutation cache after the page is gone.
    gcTime: 0,
    mutationFn: (body: LoginRequest) => auth.login(body),
    onSuccess: (session) => {
      startSession(session);
      broadcast({ type: 'signedIn' });
      void navigate(safeNext(params.get('next')), { replace: true });
    },
    onError: (error) => applyServerErrors(form, error, FIELDS, message),
  });

  const submit = (values: unknown) => {
    const body = parseForm(LoginRequestSchema, values, form, message);
    if (body) login.mutate(body);
  };

  return (
    <AuthLayout title={t('auth.login.title')} subtitle={t('auth.login.subtitle')}>
      <Flex vertical gap={16}>
        {isNotice(reason) && !login.isError ? (
          <Alert type={reason === 'passwordReset' ? 'success' : 'info'} showIcon title={t(`auth.notice.${reason}`)} data-testid="login-notice" />
        ) : null}
        <FormError error={login.error} fields={FIELDS} testId="login-error" />
        <Form form={form} noValidate layout="vertical" requiredMark={false} onFinish={submit} initialValues={{ rememberMe: false }} disabled={login.isPending}>
          <Form.Item name="email" label={t('auth.fields.email')} rules={zodRule(LoginRequestSchema.shape.email, message)}>
            <Input type="email" autoComplete="username" dir="ltr" autoFocus data-testid="login-email" />
          </Form.Item>
          <Form.Item name="password" label={t('auth.fields.password')} rules={zodRule(LoginRequestSchema.shape.password, message)}>
            <Input.Password autoComplete="current-password" dir="ltr" data-testid="login-password" />
          </Form.Item>
          <Flex justify="space-between" align="center" style={{ marginBlockEnd: 24 }}>
            <Form.Item name="rememberMe" valuePropName="checked" noStyle>
              <Checkbox data-testid="login-remember">{t('auth.fields.rememberMe')}</Checkbox>
            </Form.Item>
            <Link to="/forgot-password" data-testid="login-forgot">
              {t('auth.forgotPassword.link')}
            </Link>
          </Flex>
          <Button type="primary" htmlType="submit" block loading={login.isPending} data-testid="login-submit">
            {t('auth.login.submit')}
          </Button>
        </Form>
        <Typography.Text type="secondary" style={{ textAlign: 'center' }}>
          {t('auth.login.noAccount')} <Link to="/signup">{t('auth.login.signupLink')}</Link>
        </Typography.Text>
      </Flex>
    </AuthLayout>
  );
}
