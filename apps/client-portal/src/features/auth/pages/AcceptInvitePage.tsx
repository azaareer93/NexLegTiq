import { ApiError } from '@nexlegtiq/shared-api-client';
import { NewPasswordSchema, PortalAcceptInviteRequestSchema } from '@nexlegtiq/shared-contracts';
import type { PortalAcceptInviteRequest, PortalInvitePreview } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  ApiErrorAlert,
  ErrorState,
  LoadingSkeleton,
  Ltr,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Descriptions, Flex, Form, Input, Result, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { parseForm, zodRule } from '../forms';
import { portalAuth, startSession } from '../session';
import { useLinkToken } from '../use-link-token';

const FIELDS = ['fullName', 'password', 'acceptTerms', 'acceptPrivacy'];
const shape = PortalAcceptInviteRequestSchema.shape;

/** A used, revoked, expired or unknown link (410 RES-004), or a malformed one (VAL-001). */
const isGone = (error: unknown) =>
  error instanceof ApiError && (error.code === 'RES-004' || error.code === 'VAL-001');

/** The page of the emailed portal invitation (D-158): a new account sets a password, an existing one confirms its own. */
export function AcceptInvitePage(): React.JSX.Element {
  const { t } = useTranslation();
  const token = useLinkToken();
  const preview = useQuery({
    queryKey: ['portal-invite-preview', token],
    queryFn: ({ signal }) => portalAuth.invitePreview(token ?? '', signal),
    enabled: token !== null,
    gcTime: 0,
    retry: (count, error) =>
      (!(error instanceof ApiError) || error.status === 0 || error.status >= 500) && count < 1,
  });

  let content: React.ReactNode;
  if (!token || isGone(preview.error)) content = <InvalidInvite />;
  else if (preview.isError)
    content = <PreviewFailed error={preview.error} onRetry={() => void preview.refetch()} />;
  else if (!preview.data) content = <LoadingSkeleton />;
  else content = <AcceptForm token={token} invitation={preview.data} />;
  return <AuthLayout title={t('portal.acceptInvite.title')}>{content}</AuthLayout>;
}

function InvalidInvite(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Result
      status="warning"
      title={t('auth.acceptInvite.invalidTitle')}
      subTitle={t('portal.acceptInvite.invalidBody')}
      data-testid="invite-invalid"
      extra={<Link to="/login">{t('auth.acceptInvite.signIn')}</Link>}
    />
  );
}

function PreviewFailed({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.JSX.Element {
  const { referenceOf } = useApiErrorHandler();
  const apiError = error instanceof ApiError ? error : null;
  const retryable = !apiError || apiError.status === 0 || apiError.status >= 500;
  return (
    <ErrorState
      code={apiError && isErrorCode(apiError.code) ? apiError.code : undefined}
      requestId={referenceOf(error)}
      {...(retryable && { onRetry })}
    />
  );
}

function AcceptForm({
  token,
  invitation,
}: {
  token: string;
  invitation: PortalInvitePreview;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey: message, applyToForm } = useApiErrorHandler();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const existing = invitation.accountExists;
  const accept = useMutation({
    // Never keep the password in the mutation cache after the page is gone.
    gcTime: 0,
    mutationFn: (body: PortalAcceptInviteRequest) => portalAuth.acceptInvite(body),
    onSuccess: (session) => {
      startSession(session);
      void navigate('/', { replace: true });
    },
    onError: (error) => applyToForm(form, error, FIELDS),
  });
  if (accept.error instanceof ApiError && accept.error.code === 'RES-004') return <InvalidInvite />;

  const submit = (values: Record<string, unknown>) => {
    // An existing account keeps its name (the server ignores it), so the invited client's name fills the required field.
    const fullName = existing ? invitation.clientName : values['fullName'];
    const body = parseForm(
      PortalAcceptInviteRequestSchema,
      { ...values, fullName, token },
      form,
      message,
    );
    if (body) accept.mutate(body);
  };

  return (
    <Flex vertical gap={16}>
      <Typography.Paragraph data-testid="invite-intro" style={{ margin: 0 }}>
        {t('portal.acceptInvite.intro', {
          office: isolate(invitation.officeName),
          client: isolate(invitation.clientName),
        })}
      </Typography.Paragraph>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label={t('auth.fields.email')}>
          <Ltr>{invitation.email}</Ltr>
        </Descriptions.Item>
      </Descriptions>
      {existing ? (
        <Alert
          type="info"
          showIcon
          title={t('portal.acceptInvite.existingAccount')}
          data-testid="invite-existing"
        />
      ) : null}
      <ApiErrorAlert error={accept.error} fields={FIELDS} />
      <Form
        form={form}
        noValidate
        layout="vertical"
        requiredMark={false}
        onFinish={submit}
        disabled={accept.isPending}
        initialValues={{ acceptTerms: false, acceptPrivacy: false }}
      >
        {existing ? null : (
          <Form.Item
            name="fullName"
            label={t('auth.fields.fullName')}
            rules={zodRule(shape.fullName, message)}
          >
            <Input autoComplete="name" autoFocus data-testid="invite-full-name" />
          </Form.Item>
        )}
        <Form.Item
          name="password"
          label={t('auth.fields.password')}
          {...(!existing && { extra: t('auth.passwordHint') })}
          rules={zodRule(existing ? shape.password : NewPasswordSchema, message)}
        >
          <Input.Password
            autoComplete={existing ? 'current-password' : 'new-password'}
            dir="ltr"
            autoFocus={existing}
            data-testid="invite-password"
          />
        </Form.Item>
        <Form.Item
          name="acceptTerms"
          valuePropName="checked"
          rules={zodRule(shape.acceptTerms, message)}
          style={{ marginBlockEnd: 8 }}
        >
          <Checkbox data-testid="invite-accept-terms">
            {t('auth.signup.accept')}{' '}
            <Typography.Link href="/legal/terms" target="_blank" rel="noopener noreferrer">
              {t('auth.signup.terms')}
            </Typography.Link>
          </Checkbox>
        </Form.Item>
        <Form.Item
          name="acceptPrivacy"
          valuePropName="checked"
          rules={zodRule(shape.acceptPrivacy, message)}
        >
          <Checkbox data-testid="invite-accept-privacy">
            {t('auth.signup.accept')}{' '}
            <Typography.Link href="/legal/privacy" target="_blank" rel="noopener noreferrer">
              {t('auth.signup.privacy')}
            </Typography.Link>
          </Checkbox>
        </Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          block
          size="large"
          loading={accept.isPending}
          data-testid="invite-submit"
        >
          {t('portal.acceptInvite.submit')}
        </Button>
      </Form>
    </Flex>
  );
}
