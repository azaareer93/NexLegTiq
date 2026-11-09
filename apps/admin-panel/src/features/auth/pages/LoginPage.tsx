import { ApiError } from '@nexlegtiq/shared-api-client';
import { AdminLoginSchema } from '@nexlegtiq/shared-contracts';
import type { AdminLoginRequest } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Flex, Form, Input } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { parseForm, zodRule } from '../forms';
import { adminAuth, startSession, useAdminSession } from '../session';

const FIELDS = ['email', 'password', 'code', 'recoveryCode'];
const NOTICES = ['idle', 'expired', 'signedOut'] as const;
type Notice = (typeof NOTICES)[number];
const isNotice = (value: string | null): value is Notice => NOTICES.includes(value as Notice);

/** AUTH-008 with this detail: the admin has no authenticator yet (D-145) and must enrol first. */
const needsEnrollment = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.code === 'AUTH-008' &&
  error.details.some((detail) => detail.message === 'validation.mfaEnrollment');

interface Values {
  email?: string;
  password?: string;
  code?: string;
  recoveryCode?: string;
}

export function LoginPage(): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey: message, applyToForm } = useApiErrorHandler();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form] = Form.useForm<Values>();
  const [useRecovery, setUseRecovery] = useState(false);
  const reason = params.get('reason');

  const login = useMutation({
    gcTime: 0,
    mutationFn: (body: AdminLoginRequest) => adminAuth.login(body),
    onSuccess: (session) => {
      startSession(session);
      void navigate('/', { replace: true });
    },
    onError: (error, body) => {
      if (needsEnrollment(error)) {
        useAdminSession.setState({
          pendingEnrollment: { email: body.email, password: body.password },
        });
        void navigate('/enroll');
        return;
      }
      applyToForm(form, error, FIELDS);
    },
  });

  const submit = (values: Values) => {
    // Only the code the admin chose to type is sent; an empty field means "none" (the contract's fields are optional).
    const body = parseForm(
      AdminLoginSchema,
      {
        email: values.email,
        password: values.password,
        code: !useRecovery && values.code ? values.code : undefined,
        recoveryCode: useRecovery && values.recoveryCode ? values.recoveryCode : undefined,
      },
      form,
      message,
    );
    if (body) login.mutate(body);
  };

  return (
    <AuthLayout title={t('admin.login.title')} subtitle={t('admin.login.subtitle')}>
      <Flex vertical gap={16}>
        {isNotice(reason) && !login.isError ? (
          <Alert
            type="info"
            showIcon
            title={t(`auth.notice.${reason}`)}
            data-testid="login-notice"
          />
        ) : null}
        {needsEnrollment(login.error) ? null : (
          <ApiErrorAlert error={login.error} fields={FIELDS} testId="login-error" />
        )}
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
            rules={zodRule(AdminLoginSchema.shape.email, message)}
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
            rules={zodRule(AdminLoginSchema.shape.password, message)}
          >
            <Input.Password
              autoComplete="current-password"
              dir="ltr"
              data-testid="login-password"
            />
          </Form.Item>
          {useRecovery ? (
            <Form.Item
              name="recoveryCode"
              label={t('admin.fields.recoveryCode')}
              extra={t('admin.login.recoveryHint')}
            >
              <Input autoComplete="off" dir="ltr" data-testid="login-recovery-code" />
            </Form.Item>
          ) : (
            <Form.Item name="code" label={t('admin.fields.code')} extra={t('admin.login.codeHint')}>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                dir="ltr"
                data-testid="login-code"
              />
            </Form.Item>
          )}
          <Button
            type="link"
            style={{ paddingInline: 0, marginBlockEnd: 16 }}
            onClick={() => setUseRecovery((value) => !value)}
            data-testid="login-toggle-recovery"
          >
            {useRecovery ? t('admin.login.useCode') : t('admin.login.useRecovery')}
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            block
            loading={login.isPending}
            data-testid="login-submit"
          >
            {t('admin.login.submit')}
          </Button>
        </Form>
      </Flex>
    </AuthLayout>
  );
}
