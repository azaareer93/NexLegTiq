import { PlayCircleOutlined } from '@ant-design/icons';
import { ConfirmModal, isApiError, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import { App, Button } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { timerQuery, useTimeMutations } from '../api/use-billing';

/**
 * Starts the timer on a case. A 409 RES-002 means one already runs: the timer is read again, and if it is still not
 * shown (its case is no longer visible, D-152) the user may discard it and start again; otherwise it was started in
 * another tab and the widget now shows it.
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
  const queryClient = useQueryClient();
  const { start, discard } = useTimeMutations();
  const [stale, setStale] = useState(false);
  const onError = async (error: unknown) => {
    if (!(isApiError(error) && error.code === 'RES-002')) return notify(error);
    try {
      const running = await queryClient.fetchQuery({ ...timerQuery(), staleTime: 0 });
      if (running === null) {
        notify(error);
        setStale(true);
      }
    } catch (failure) {
      notify(failure);
    }
  };
  return (
    <>
      <Button
        icon={<PlayCircleOutlined aria-hidden />}
        loading={start.isPending}
        onClick={() => start.mutate(fileId, { onError: (error) => void onError(error) })}
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
