import { PortalLoginRequestSchema } from '@nexlegtiq/shared-contracts';
import type { PortalLoginRequest } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Flex, Form, Input } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { parseForm, zodRule } from '../forms';
import { portalAuth, startSession } from '../session';

const FIELDS = ['email', 'password'];
const NOTICES = ['expired', 'signedOut', 'passwordReset'] as const;
type Notice = (typeof NOTICES)[number];
const isNotice = (value: string | null): value is Notice => NOTICES.includes(value as Notice);

export function LoginPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey: message, applyToForm } = useApiErrorHandler();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form] = Form.useForm();
  const reason = params.get('reason');

  const login = useMutation({
    gcTime: 0,
    mutationFn: (body: PortalLoginRequest) => portalAuth.login(body),
    onSuccess: (session) => {
      startSession(session);
      void navigate('/', { replace: true });
    },
    onError: (error) => applyToForm(form, error, FIELDS),
  });

  const submit = (values: unknown) => {
    const body = parseForm(PortalLoginRequestSchema, values, form, message);
    if (body) login.mutate(body);
  };

  return (
    <AuthLayout title={t('portal.login.title')} subtitle={t('portal.login.subtitle')}>
      <Flex vertical gap={16}>
        {isNotice(reason) && !login.isError ? (
          <Alert
            type="info"
            showIcon
            title={t(`auth.notice.${reason}`)}
            data-testid="login-notice"
          />
        ) : null}
        <ApiErrorAlert error={login.error} fields={FIELDS} testId="login-error" />
        <Form
          form={form}
          noValidate
          layout="vertical"
          requiredMark={false}
          onFinish={submit}
          disabled={login.isPending}
        >
          <Form.Item
            name="email"
            label={t('auth.fields.email')}
            rules={zodRule(PortalLoginRequestSchema.shape.email, message)}
          >
            <Input
              type="email"
              autoComplete="username"
              dir="ltr"
              autoFocus
              data-testid="login-email"
            />
          </Form.Item>
          <Form.Item
            name="password"
            label={t('auth.fields.password')}
            rules={zodRule(PortalLoginRequestSchema.shape.password, message)}
          >
            <Input.Password
              autoComplete="current-password"
              dir="ltr"
              data-testid="login-password"
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            block
            size="large"
            loading={login.isPending}
            data-testid="login-submit"
          >
            {t('auth.login.submit')}
          </Button>
        </Form>
        <Flex justify="center">
          <Link to="/forgot-password" data-testid="forgot-link">
            {t('auth.forgotPassword.link')}
          </Link>
        </Flex>
      </Flex>
    </AuthLayout>
  );
}
