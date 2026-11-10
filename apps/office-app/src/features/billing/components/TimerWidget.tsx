import { ClockCircleOutlined, PauseCircleOutlined } from '@ant-design/icons';
import { StopTimerSchema } from '@nexlegtiq/shared-contracts';
import type { Case, Timer } from '@nexlegtiq/shared-contracts';
import {
  ApiErrorAlert,
  ConfirmModal,
  Ltr,
  useApiErrorHandler,
  useCan,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { isolateLtr } from '@nexlegtiq/shared-utils';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Flex, Form, Input, Modal } from 'antd';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useMatch } from 'react-router';

import { StartTimerButton } from './StartTimerButton';
import { zodRule } from '../../auth/forms';
import { caseKeys } from '../../cases/api/use-cases';
import { useTimeMutations, useTimer } from '../api/use-billing';

const TICK_MS = 1000;

/** Seconds since `startedAt`, re-read every second while mounted (never negative: clocks differ). */
export function useElapsedSeconds(startedAt: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt ? Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000)) : 0;
}

/** hh:mm:ss in the user's digits. */
function useClock(seconds: number): string {
  const format = useFormat();
  const two = (n: number) => (n < 10 ? format.number(0) : '') + format.number(n);
  return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
    .map(two)
    .join(':');
}

interface StopValues {
  readonly description: string;
  readonly isBillable: boolean;
}

/** Asks what the time was spent on, then logs it (D-152: the description is required by then). */
function StopModal({ timer, onClose }: { readonly timer: Timer; readonly onClose: () => void }) {
  const { t } = useTranslation();
  const { stop } = useTimeMutations();
  const { applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<StopValues>();
  const [error, setError] = useState<unknown>(null);
  const message = (key: string) => t(key as never);
  const submit = async (values: StopValues) => {
    setError(null);
    try {
      await stop.mutateAsync(values);
      onClose();
    } catch (failure) {
      if (!applyToForm(form, failure, ['description'])) setError(failure);
    }
  };
  return (
    <Modal
      open
      title={t('billing.timer.stopTitle')}
      okText={t('billing.timer.save')}
      cancelText={t('common.actions.cancel')}
      confirmLoading={stop.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
      okButtonProps={{ 'data-testid': 'timer-save' }}
    >
      <Form
        form={form}
        layout="vertical"
        noValidate
        initialValues={{ description: timer.description ?? '', isBillable: true }}
        onFinish={(values) => void submit(values)}
      >
        <p>{t('billing.timer.stopHint')}</p>
        {error ? <ApiErrorAlert error={error} /> : null}
        <Form.Item
          name="description"
          label={t('billing.timer.description')}
          rules={zodRule(StopTimerSchema.shape.description.unwrap(), message)}
        >
          <Input.TextArea rows={3} maxLength={2000} data-testid="timer-description" />
        </Form.Item>
        <Form.Item name="isBillable" valuePropName="checked">
          <Checkbox data-testid="timer-billable">{t('billing.timer.billable')}</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** The running timer: case, elapsed time, Stop (log the time) and Discard. */
function RunningTimer({ timer, compact }: { readonly timer: Timer; readonly compact: boolean }) {
  const { t } = useTranslation();
  const { discard } = useTimeMutations();
  const { notify } = useApiErrorHandler();
  const [stopping, setStopping] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const clock = useClock(useElapsedSeconds(timer.startedAt));
  return (
    <>
      <Flex align="center" gap={4} data-testid="timer-widget">
        <Flex
          align="center"
          gap={6}
          role="timer"
          aria-label={t('billing.timer.running', { file: isolateLtr(timer.file.fileNumber) })}
        >
          <ClockCircleOutlined aria-hidden />
          {compact ? null : <Ltr>{timer.file.fileNumber}</Ltr>}
          <Ltr>
            <span data-testid="timer-elapsed">{clock}</span>
          </Ltr>
        </Flex>
        <Button
          icon={<PauseCircleOutlined aria-hidden />}
          onClick={() => setStopping(true)}
          data-testid="timer-stop"
        >
          {t('billing.timer.stop')}
        </Button>
        <Button danger onClick={() => setDiscarding(true)} data-testid="timer-discard">
          {t('billing.timer.discard')}
        </Button>
      </Flex>
      {stopping ? <StopModal timer={timer} onClose={() => setStopping(false)} /> : null}
      <ConfirmModal
        open={discarding}
        danger
        title={t('billing.timer.discardTitle')}
        confirmText={t('billing.timer.discard')}
        loading={discard.isPending}
        onConfirm={() =>
          discard.mutate(undefined, { onSettled: () => setDiscarding(false), onError: notify })
        }
        onCancel={() => setDiscarding(false)}
      >
        {t('billing.timer.discardBody')}
      </ConfirmModal>
    </>
  );
}

/**
 * The header's timer (D-152): while one runs, its case, the elapsed time, Stop and Discard; otherwise a Start button on
 * the case page being viewed. Needs `log:time`.
 */
export function TimerWidget({ compact = false }: { readonly compact?: boolean }) {
  const { t } = useTranslation();
  const can = useCan('log:time');
  const onFile = useMatch('/cases/:id')?.params.id;
  const timer = useTimer(can);
  // The file page's cached case, only read (never fetched here): an archived case takes no timer (D-052).
  const queryClient = useQueryClient();
  const caseStatus = useSyncExternalStore(
    (notify) => queryClient.getQueryCache().subscribe(notify),
    () => queryClient.getQueryData<Case>(caseKeys.detail(onFile ?? ''))?.status,
  );
  if (!can) return null;
  if (timer.data) return <RunningTimer timer={timer.data} compact={compact} />;
  if (!onFile || caseStatus === 'ARCHIVED') return null;
  return (
    <StartTimerButton
      fileId={onFile}
      label={compact ? null : t('billing.timer.start')}
      testId="timer-start"
    />
  );
}
