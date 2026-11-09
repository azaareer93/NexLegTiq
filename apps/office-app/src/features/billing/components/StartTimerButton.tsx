import { PlayCircleOutlined } from '@ant-design/icons';
import { ConfirmModal, isApiError, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTimeMutations } from '../api/use-billing';

/**
 * Starts the timer on a case. A 409 RES-002 means one already runs although none is shown (its case is no longer
 * visible, D-152): the error is shown and the user may discard it, then start again.
 */
export function StartTimerButton({
  fileId,
  label,
  testId,
}: {
  readonly fileId: string;
  readonly label: string | null;
  readonly testId: string;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const { start, discard } = useTimeMutations();
  const [stale, setStale] = useState(false);
  const onError = (error: unknown) => {
    notify(error);
    if (isApiError(error) && error.code === 'RES-002') setStale(true);
  };
  return (
    <>
      <Button
        icon={<PlayCircleOutlined aria-hidden />}
        loading={start.isPending}
        onClick={() => start.mutate(fileId, { onError })}
        aria-label={t('billing.timer.startOnFile')}
        data-testid={testId}
      >
        {label}
      </Button>
      <ConfirmModal
        open={stale}
        danger
        title={t('billing.timer.staleTitle')}
        confirmText={t('billing.timer.discardRunning')}
        loading={discard.isPending}
        onConfirm={() =>
          discard.mutate(undefined, {
            onSuccess: () => void message.success(t('billing.timer.discarded')),
            onSettled: () => setStale(false),
            onError: notify,
          })
        }
        onCancel={() => setStale(false)}
      >
        {t('billing.timer.staleBody')}
      </ConfirmModal>
    </>
  );
}
