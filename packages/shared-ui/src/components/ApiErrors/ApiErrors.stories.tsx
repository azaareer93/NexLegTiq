import type { Meta, StoryObj } from '@storybook/react-vite';
import { App, Button, Flex, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { ApiErrorAlert, useApiErrorHandler } from './ApiErrors';
import { ErrorState } from '../States/States';

const meta = {
  title: 'Feedback/API errors',
  component: ApiErrorAlert,
  args: { error: null },
} satisfies Meta<typeof ApiErrorAlert>;
export default meta;
type Story = StoryObj<typeof meta>;

const REQUEST_ID = '0192f0aa-77c1-7c3e-9a51-2b3c4d5e6f70';

export const UserCanFix: Story = { args: { error: { code: 'AUTH-001' } } };
export const RateLimited: Story = { args: { error: { code: 'RATE-001', retryAfter: 30 } } };
export const UnknownCodeWithReference: Story = {
  args: { error: { code: 'ZZZ-999', requestId: REQUEST_ID } },
};
export const ServerFailureWithReference: Story = {
  args: { error: { code: 'SYS-001', requestId: REQUEST_ID } },
};

function Conventions(): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  return (
    <Flex vertical gap={16} style={{ maxInlineSize: 640 }}>
      <Typography.Title level={2}>How the apps give feedback</Typography.Title>
      <Typography.Paragraph>
        Success of an action: a short toast,{' '}
        <code>message.success(t(&apos;common.feedback.saved&apos;))</code>. Never for page loads.
      </Typography.Paragraph>
      <Button onClick={() => void message.success(t('common.feedback.saved'))}>Toast</Button>
      <Typography.Paragraph>
        A failed action without its own form (delete, upload, a toolbar button):{' '}
        <code>notify(error)</code> from <code>useApiErrorHandler()</code> — the message and, for
        server-side failures, the support reference.
      </Typography.Paragraph>
      <Button danger onClick={() => notify({ code: 'SYS-001', requestId: REQUEST_ID })}>
        Notification
      </Button>
      <Typography.Paragraph>
        A failed form: <code>applyToForm(form, error, FIELDS)</code> puts VAL-001 details on their
        fields, and <code>&lt;ApiErrorAlert error fields /&gt;</code> above the form explains the
        rest.
      </Typography.Paragraph>
      <ApiErrorAlert error={{ code: 'RES-002' }} />
      <Typography.Paragraph>
        A failed page or section load: <code>&lt;ErrorState code requestId onRetry /&gt;</code> in
        place of the content. Loading: <code>&lt;LoadingSkeleton /&gt;</code>. Offline: the shell
        shows <code>&lt;OfflineBanner /&gt;</code>; nothing else to do.
      </Typography.Paragraph>
      <ErrorState code="SYS-002" onRetry={() => undefined} />
      <Typography.Paragraph>
        Never show an error&apos;s own text or a raw code: only <code>errors.&lt;CODE&gt;</code>{' '}
        through these helpers.
      </Typography.Paragraph>
    </Flex>
  );
}

export const FeedbackConventions: Story = { render: () => <Conventions /> };
