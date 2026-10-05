import type { Meta, StoryObj } from '@storybook/react-vite';
import { useTranslation } from 'react-i18next';

import { ConfirmModal } from './ConfirmModal';

const meta = {
  title: 'Feedback/ConfirmModal',
  component: ConfirmModal,
  args: { open: true, title: '', onConfirm: () => undefined, onCancel: () => undefined },
} satisfies Meta<typeof ConfirmModal>;
export default meta;
type Story = StoryObj<typeof meta>;

function DeleteConfirm(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ConfirmModal open danger title={t('common.actions.delete')} onConfirm={() => undefined} onCancel={() => undefined}>
      {t('legal.legalFile')}
    </ConfirmModal>
  );
}

export const Destructive: Story = { render: () => <DeleteConfirm /> };
