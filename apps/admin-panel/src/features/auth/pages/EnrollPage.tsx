import type { AdminClientSession } from '@nexlegtiq/shared-api-client';
import { AdminConfirmEnrollmentSchema } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, LoadingSkeleton, Ltr, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { App, Button, Checkbox, Flex, Form, Input, QRCode, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { IdleTimeout } from '../components/IdleTimeout';
import { parseForm, zodRule } from '../forms';
import { adminAuth, queryClient, startSession, useAdminSession } from '../session';

const FIELDS = ['code'];

/**
 * First sign-in of a platform admin (D-145): scan the secret, prove it with the first code, then keep the ten recovery
 * codes, which are shown here once and never again.
 */
export function EnrollPage(): React.JSX.Element {
  const pending = useAdminSession((state) => state.pendingEnrollment);
  const reason = useAdminSession((state) => state.signOutReason);
  const [session, setSession] = useState<AdminClientSession | null>(null);
  // Timed out (IdleTimeout below) or the session ended: nothing of the enrolment may stay on screen.
  if (reason) return <Navigate to={`/login?reason=${reason}`} replace />;
  if (session) {
    return (
      <>
        <IdleTimeout />
        <RecoveryCodes session={session} />
      </>
    );
  }
  // Reached without the sign-in page's credentials (a reload, a typed URL): start from sign-in again.
  if (!pending) return <Navigate to="/login" replace />;
  const confirmed = (next: AdminClientSession) => {
    setSession(next);
    // Done with the password and the secret: drop both from memory now.
    useAdminSession.setState({ pendingEnrollment: null });
    queryClient.removeQueries({ queryKey: ['admin', 'enrollment'] });
  };
  return (
    <>
      <IdleTimeout />
      <ScanAndConfirm credentials={pending} onConfirmed={confirmed} />
    </>
  );
}

function ScanAndConfirm({
  credentials,
  onConfirmed,
}: {
  readonly credentials: { readonly email: string; readonly password: string };
  readonly onConfirmed: (session: AdminClientSession) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey: message, applyToForm } = useApiErrorHandler();
  const navigate = useNavigate();
  const [form] = Form.useForm<{ code?: string }>();

  // One secret per visit: every enrol call replaces the unconfirmed one, so it is never refetched on its own.
  const secret = useQuery({
    queryKey: ['admin', 'enrollment', credentials.email],
    queryFn: () => adminAuth.enroll(credentials),
    staleTime: Infinity,
    // The secret leaves the cache as soon as the page does (an abandoned enrolment included).
    gcTime: 0,
    retry: false,
  });

  const confirm = useMutation({
    gcTime: 0,
    mutationFn: (code: string) => adminAuth.confirmEnrollment({ ...credentials, code }),
    onSuccess: onConfirmed,
    onError: (error) => applyToForm(form, error, FIELDS),
  });

  const submit = (values: { code?: string }) => {
    const body = parseForm(
      AdminConfirmEnrollmentSchema,
      { ...credentials, code: values.code },
      form,
      message,
    );
    if (body) confirm.mutate(body.code);
  };

  if (secret.isPending) return <LoadingSkeleton />;
  return (
    <AuthLayout title={t('admin.enroll.title')} subtitle={t('admin.enroll.subtitle')}>
      {secret.isError ? (
        // A wrong password, an enrolment window that has passed (RES-004), or an outage: back to sign-in.
        <Flex vertical gap={16}>
          <ApiErrorAlert error={secret.error} testId="enroll-error" />
          <Button
            block
            onClick={() => void navigate('/login', { replace: true })}
            data-testid="enroll-back"
          >
            {t('admin.enroll.back')}
          </Button>
        </Flex>
      ) : (
        <Flex vertical gap={16}>
          <Typography.Paragraph style={{ margin: 0 }}>
            {t('admin.enroll.scan')}
          </Typography.Paragraph>
          <Flex justify="center">
            {/* Rendered here from the otpauth URI: the secret never reaches a QR service (D-145). */}
            <QRCode
              value={secret.data.otpauthUri}
              size={200}
              bordered={false}
              aria-label={t('admin.enroll.qrLabel')}
              data-testid="enroll-qr"
            />
          </Flex>
          <Typography.Text type="secondary">{t('admin.enroll.manual')}</Typography.Text>
          <Ltr>
            <Typography.Text
              code
              copyable
              style={{ overflowWrap: 'anywhere' }}
              data-testid="enroll-secret"
            >
              {secret.data.secret}
            </Typography.Text>
          </Ltr>
          <ApiErrorAlert error={confirm.error} fields={FIELDS} testId="enroll-error" />
          <Form
            form={form}
            noValidate
            layout="vertical"
            requiredMark={false}
            onFinish={submit}
            disabled={confirm.isPending}
          >
            <Form.Item
              name="code"
              label={t('admin.fields.code')}
              rules={zodRule(AdminConfirmEnrollmentSchema.shape.code, message)}
            >
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                dir="ltr"
                autoFocus
                data-testid="enroll-code"
              />
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={confirm.isPending}
              data-testid="enroll-submit"
            >
              {t('admin.enroll.submit')}
            </Button>
          </Form>
        </Flex>
      )}
    </AuthLayout>
  );
}

function RecoveryCodes({ session }: { readonly session: AdminClientSession }): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [saved, setSaved] = useState(false);
  const codes = session.recoveryCodes ?? [];
  const text = codes.join('\n');

  const copy = () => {
    // No clipboard API outside a secure context: report it like any failed copy.
    (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'))).then(
      () => void message.success(t('admin.recovery.copied')),
      () => void message.error(t('admin.recovery.copyFailed')),
    );
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nexlegtiq-admin-recovery-codes.txt';
    link.click();
    // Revoked on the next tick: revoking at once can cancel the download in Firefox and Safari.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const finish = () => {
    startSession(session);
    void navigate('/', { replace: true });
  };

  return (
    <AuthLayout title={t('admin.recovery.title')} subtitle={t('admin.recovery.subtitle')}>
      <Flex vertical gap={16}>
        <Ltr>
          <ol
            data-testid="recovery-codes"
            style={{ margin: 0, paddingInlineStart: 24, columns: 2 }}
          >
            {codes.map((code) => (
              <li key={code} style={{ breakInside: 'avoid' }}>
                <Typography.Text code>{code}</Typography.Text>
              </li>
            ))}
          </ol>
        </Ltr>
        <Flex gap={8}>
          <Button onClick={copy} data-testid="recovery-copy">
            {t('admin.recovery.copy')}
          </Button>
          <Button onClick={download} data-testid="recovery-download">
            {t('admin.recovery.download')}
          </Button>
        </Flex>
        <Checkbox
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          data-testid="recovery-saved"
        >
          {t('admin.recovery.saved')}
        </Checkbox>
        <Button
          type="primary"
          block
          disabled={!saved}
          onClick={finish}
          data-testid="recovery-continue"
        >
          {t('admin.recovery.continue')}
        </Button>
      </Flex>
    </AuthLayout>
  );
}
