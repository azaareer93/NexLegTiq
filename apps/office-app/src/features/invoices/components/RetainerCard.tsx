import { RetainerDepositSchema } from '@nexlegtiq/shared-contracts';
import { RETAINER_DEPOSIT_METHODS } from '@nexlegtiq/shared-types';
import {
  ApiErrorAlert,
  Bdi,
  ErrorState,
  LoadingSkeleton,
  Ltr,
  useApiErrorHandler,
  useCan,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { toWesternDigits } from '@nexlegtiq/shared-utils';
import {
  App,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  List,
  Modal,
  Select,
  Statistic,
  Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { parseForm } from '../../auth/forms';
import { useInvoiceMutations, useOfficeDay, useRetainer } from '../api/use-invoices';

interface Values {
  readonly amount?: string;
  readonly paidAt?: Dayjs;
  readonly method?: string;
  readonly reference?: string;
}

const FIELDS = ['amount', 'paidAt', 'method', 'reference'];

function DepositModal({
  fileId,
  currency,
  onClose,
}: {
  readonly fileId: string;
  readonly currency: string;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const { deposit } = useInvoiceMutations();
  const day = useOfficeDay();

  const submit = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as Values;
    const parsed = parseForm(
      RetainerDepositSchema,
      {
        amount: toWesternDigits(v.amount ?? '').trim(),
        paidAt: v.paidAt ? day.noon(v.paidAt) : undefined,
        method: v.method,
        reference: v.reference?.trim() || undefined,
      },
      form,
      translateKey,
    );
    if (!parsed) return;
    try {
      await deposit.mutateAsync({ fileId, body: parsed });
      void message.success(t('billing.retainer.deposited'));
      onClose();
    } catch (error) {
      applyToForm(form, error, FIELDS);
    }
  };

  return (
    <Modal
      open
      title={t('billing.retainer.depositTitle')}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ 'data-testid': 'retainer-deposit-confirm' }}
      confirmLoading={deposit.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        noValidate
        initialValues={{ paidAt: day.today, method: 'BANK_TRANSFER' }}
      >
        <Form.Item name="amount" label={t('billing.retainer.amount', { currency })}>
          <Input dir="ltr" inputMode="decimal" data-testid="retainer-amount" />
        </Form.Item>
        <Form.Item name="paidAt" label={t('billing.retainer.paidAt')}>
          <DatePicker
            format="DD/MM/YYYY"
            disabledDate={day.isFuture}
            style={{ inlineSize: '100%' }}
            data-testid="retainer-paid-at"
          />
        </Form.Item>
        <Form.Item name="method" label={t('billing.retainer.method')}>
          <Select
            data-testid="retainer-method"
            options={RETAINER_DEPOSIT_METHODS.map((m) => ({
              value: m,
              label: t(`enums.invoicePaymentMethod.${m}`),
            }))}
          />
        </Form.Item>
        <Form.Item name="reference" label={t('billing.retainer.reference')}>
          <Input dir="ltr" maxLength={200} data-testid="retainer-reference" />
        </Form.Item>
      </Form>
      {deposit.isError ? <ApiErrorAlert error={deposit.error} fields={FIELDS} /> : null}
    </Modal>
  );
}

/** The file's retainer (D-176): balance, the latest movements and, for those who may, a deposit. */
export function RetainerCard({
  fileId,
  archived,
}: {
  readonly fileId: string;
  readonly archived: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const mayDeposit = useCan('mark:invoice:paid');
  const retainer = useRetainer(fileId);
  const { referenceOf } = useApiErrorHandler();
  const [depositing, setDepositing] = useState(false);
  if (retainer.isError) {
    return (
      <Card title={t('billing.retainer.title')} data-testid="retainer-card">
        <ErrorState
          requestId={referenceOf(retainer.error)}
          onRetry={() => void retainer.refetch()}
        />
      </Card>
    );
  }
  if (!retainer.data) return <LoadingSkeleton rows={2} />;
  const { balance, currency, entries } = retainer.data;
  return (
    <Card
      title={t('billing.retainer.title')}
      data-testid="retainer-card"
      extra={
        mayDeposit && !archived ? (
          <Button onClick={() => setDepositing(true)} data-testid="retainer-deposit">
            {t('billing.retainer.deposit')}
          </Button>
        ) : null
      }
    >
      <Statistic
        title={t('billing.retainer.balance')}
        valueRender={() => (
          <span data-testid="retainer-balance">
            <Bdi>{format.money(balance, currency)}</Bdi>
          </span>
        )}
      />
      <Typography.Text strong style={{ display: 'block', marginBlockStart: 12 }}>
        {t('billing.retainer.entries')}
      </Typography.Text>
      <List
        size="small"
        dataSource={entries.slice(0, 5)}
        locale={{ emptyText: t('billing.retainer.noEntries') }}
        renderItem={(e) => (
          <List.Item>
            <Ltr>{format.date(e.paidAt)}</Ltr>
            <span>
              {t(`enums.retainerEntryKind.${e.kind}`)}
              {e.invoice?.invoiceNumber ? (
                <>
                  {' '}
                  <Ltr>{e.invoice.invoiceNumber}</Ltr>
                </>
              ) : null}
            </span>
            <Bdi>{format.money(e.amount, currency)}</Bdi>
          </List.Item>
        )}
      />
      {depositing ? (
        <DepositModal fileId={fileId} currency={currency} onClose={() => setDepositing(false)} />
      ) : null}
    </Card>
  );
}
