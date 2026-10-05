import { Modal } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface ConfirmModalProps {
  readonly open: boolean;
  readonly title: ReactNode;
  /** What will happen, in plain words. */
  readonly children?: ReactNode;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Destructive actions (delete, close a case) get a red confirm button. */
  readonly danger?: boolean;
  /** Shows a spinner on the confirm button while the action runs. */
  readonly loading?: boolean;
  /** Defaults to "Confirm" / "Cancel". */
  readonly confirmText?: ReactNode;
  readonly cancelText?: ReactNode;
}

/** Asks before an action that is hard to undo. Controlled: the caller owns `open` and closes it when done. */
export function ConfirmModal({
  open,
  title,
  children,
  onConfirm,
  onCancel,
  danger = false,
  loading = false,
  confirmText,
  cancelText,
}: ConfirmModalProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      title={title}
      onOk={onConfirm}
      onCancel={onCancel}
      okText={confirmText ?? t('common.actions.confirm')}
      cancelText={cancelText ?? t('common.actions.cancel')}
      okButtonProps={{ danger, 'data-testid': 'confirm-ok' }}
      cancelButtonProps={{ 'data-testid': 'confirm-cancel' }}
      confirmLoading={loading}
      destroyOnHidden
    >
      {children}
    </Modal>
  );
}
