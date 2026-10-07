import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from 'antd';
import { useTranslation } from 'react-i18next';

import { EmptyState, ErrorState, LoadingSkeleton } from './States';

const meta = { title: 'Feedback/States', component: EmptyState } satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

function EmptyWithAction(): React.JSX.Element {
  const { t } = useTranslation();
  return <EmptyState action={<Button type="primary">{t('common.actions.create')}</Button>} />;
}

export const Empty: Story = {};
export const EmptyWithCreateButton: Story = { render: () => <EmptyWithAction /> };
export const ErrorWithReference: Story = {
  render: () => (
    <ErrorState
      code="RES-001"
      requestId="0192f0aa-77c1-7c3e-9a51-2b3c4d5e6f70"
      onRetry={() => undefined}
    />
  ),
};
export const GenericError: Story = { render: () => <ErrorState onRetry={() => undefined} /> };
export const Loading: Story = { render: () => <LoadingSkeleton rows={4} /> };
