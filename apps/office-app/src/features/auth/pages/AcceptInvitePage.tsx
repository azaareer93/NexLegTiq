import { ApiError } from '@nexlegtiq/shared-api-client';
import { AcceptInviteRequestSchema } from '@nexlegtiq/shared-contracts';
import type { AcceptInviteRequest, InvitePreview } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  ApiErrorAlert,
  Bdi,
  ErrorState,
  LoadingSkeleton,
  Ltr,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Descriptions, Flex, Form, Input, Result, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { parseForm, zodRule } from '../forms';
import { auth, broadcast, startSession } from '../session';
import { useLinkToken } from '../use-link-token';

const FIELDS = ['fullName', 'password', 'phone', 'acceptTerms', 'acceptPrivacy'];
const shape = AcceptInviteRequestSchema.shape;

/** A used, revoked, expired or unknown link (410 RES-004), or a malformed one (VAL-001). */
const isGone = (error: unknown) =>
  error instanceof ApiError && (error.code === 'RES-004' || error.code === 'VAL-001');

/**
 * The page of the emailed invitation link (W2, D-134): shows the office and role, then creates the account and signs it in.
 * Works signed in or not: accepting signs in as the new user.
 */
export function AcceptInvitePage(): React.JSX.Element {
  const { t } = useTranslation();
  const token = useLinkToken();
  const preview = useQuery({
    queryKey: ['invite-preview', token],
    queryFn: ({ signal }) => auth.invitePreview(token ?? '', signal),
    enabled: token !== null,
    gcTime: 0,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 1,
  });

  let content: React.ReactNode;
  if (!token || isGone(preview.error)) content = <InvalidInvite />;
  else if (preview.isError)
    content = <PreviewFailed error={preview.error} onRetry={() => void preview.refetch()} />;
  else if (!preview.data) content = <LoadingSkeleton />;
  else content = <AcceptForm token={token} invitation={preview.data} />;
  return <AuthLayout title={t('auth.acceptInvite.title')}>{content}</AuthLayout>;
}

function InvalidInvite(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Result
      status="warning"
      title={t('auth.acceptInvite.invalidTitle')}
      subTitle={t('auth.acceptInvite.invalidBody')}
      data-testid="invite-invalid"
      extra={<Link to="/login">{t('auth.acceptInvite.signIn')}</Link>}
    />
  );
}

/** A refusal (a suspended office, AUTH-006) is explained; only an outage or a 5xx is worth retrying. */
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
  invitation: InvitePreview;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey: message, applyToForm } = useApiErrorHandler();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const accept = useMutation({
    // Never keep the password in the mutation cache after the page is gone.
    gcTime: 0,
    mutationFn: (body: AcceptInviteRequest) => auth.acceptInvite(body),
    onSuccess: (session) => {
      startSession(session);
      broadcast({ type: 'signedIn' });
      void navigate('/', { replace: true });
    },
    onError: (error) => applyToForm(form, error, FIELDS),
  });
  if (accept.error instanceof ApiError && accept.error.code === 'RES-004') return <InvalidInvite />;

  const submit = (values: Record<string, unknown>) => {
    const body = parseForm(
      AcceptInviteRequestSchema,
      { ...values, phone: values['phone'] || undefined, token },
      form,
      message,
    );
    if (body) accept.mutate(body);
  };

  return (
    <Flex vertical gap={16}>
      <Typography.Paragraph data-testid="invite-intro">
        {t('auth.acceptInvite.intro', {
          inviter: isolate(invitation.inviterName),
          office: isolate(invitation.officeName),
        })}
      </Typography.Paragraph>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label={t('auth.fields.email')}>
          <Ltr>{invitation.email}</Ltr>
        </Descriptions.Item>
        <Descriptions.Item label={t('auth.acceptInvite.role')}>
          <Bdi>{t(`enums.role.${invitation.role}`)}</Bdi>
        </Descriptions.Item>
      </Descriptions>
      <ApiErrorAlert error={accept.error} fields={FIELDS} />
      <Form
        form={form}
        noValidate
        layout="vertical"
        requiredMark={false}
        onFinish={submit}
        disabled={accept.isPending}
        initialValues={{
          fullName: invitation.fullName ?? '',
          acceptTerms: false,
          acceptPrivacy: false,
        }}
      >
        <Form.Item
          name="fullName"
          label={t('auth.fields.fullName')}
          rules={zodRule(shape.fullName, message)}
        >
          <Input autoComplete="name" autoFocus data-testid="invite-full-name" />
        </Form.Item>
        <Form.Item
          name="password"
          label={t('auth.fields.password')}
          extra={t('auth.passwordHint')}
          rules={zodRule(shape.password, message)}
        >
          <Input.Password autoComplete="new-password" dir="ltr" data-testid="invite-password" />
        </Form.Item>
        <Form.Item
          name="phone"
          label={t('auth.fields.phone')}
          rules={zodRule(shape.phone, message)}
        >
          <Input type="tel" autoComplete="tel" dir="ltr" data-testid="invite-phone" />
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
          loading={accept.isPending}
          data-testid="invite-submit"
        >
          {t('auth.acceptInvite.submit')}
        </Button>
      </Form>
    </Flex>
  );
}
