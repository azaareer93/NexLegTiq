import type { AdminPayment } from '@nexlegtiq/shared-contracts';
import {
  Bdi,
  EmptyState,
  ErrorState,
  Ltr,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { App, Button, Card, Space, Table } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RecordPaymentModal, VoidPaymentModal } from './PaymentModals';
import { usePaymentMutations, usePayments } from '../hooks';

/** The office's manual payments (MVP-170, D-174): record, void, open the receipt PDF. */
export function PaymentsCard({
  officeId,
  currency,
}: {
  readonly officeId: string;
  readonly currency: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const { message } = App.useApp();
  const { referenceOf, notify } = useApiErrorHandler();
  const query = usePayments(officeId);
  const { receipt } = usePaymentMutations(officeId);
  const [recording, setRecording] = useState(false);
  const [voiding, setVoiding] = useState<AdminPayment | null>(null);

  const openReceipt = async (id: string): Promise<void> => {
    try {
      const answer = await receipt.mutateAsync(id);
      if (answer.status === 'READY') window.open(answer.downloadUrl, '_blank', 'noopener');
      else void message.info(t('admin.offices.payments.receiptRendering'));
    } catch (error) {
      notify(error);
    }
  };

  let body: React.ReactNode;
  if (query.isError) {
    body = <ErrorState requestId={referenceOf(query.error)} onRetry={() => void query.refetch()} />;
  } else if (query.data && query.data.length === 0) {
    body = <EmptyState title={t('admin.offices.payments.empty')} />;
  } else {
    body = (
      <Table<AdminPayment>
        data-testid="office-payments"
        rowKey="id"
        loading={query.isLoading}
        dataSource={query.data ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: t('admin.offices.payments.columns.receipt'),
            render: (_, p) => <Ltr>{p.receiptNumber}</Ltr>,
          },
          {
            title: t('admin.offices.payments.columns.paidAt'),
            render: (_, p) => format.date(p.paidAt),
          },
          {
            title: t('admin.offices.payments.columns.amount'),
            render: (_, p) => <Bdi>{format.money(p.amount, p.currency)}</Bdi>,
          },
          {
            title: t('admin.offices.payments.columns.method'),
            render: (_, p) => t(`enums.platformPaymentMethod.${p.method}`),
          },
          {
            title: t('admin.offices.payments.columns.reference'),
            render: (_, p) => (p.reference ? <Ltr>{p.reference}</Ltr> : t('admin.offices.none')),
          },
          {
            title: t('admin.offices.payments.columns.status'),
            render: (_, p) => (
              <StatusTag tone={p.voidedAt ? 'error' : 'success'}>
                {t(`admin.offices.payments.status.${p.voidedAt ? 'VOIDED' : 'VALID'}`)}
              </StatusTag>
            ),
          },
          {
            title: t('admin.offices.payments.columns.recordedBy'),
            render: (_, p) => <Bdi>{p.recordedBy.fullName}</Bdi>,
          },
          {
            title: t('admin.offices.payments.columns.actions'),
            render: (_, p) => (
              <Space size={4}>
                <Button
                  size="small"
                  onClick={() => void openReceipt(p.id)}
                  data-testid={`payment-receipt-${p.id}`}
                >
                  {t('admin.offices.payments.actions.receipt')}
                </Button>
                {p.voidedAt ? null : (
                  <Button
                    size="small"
                    danger
                    onClick={() => setVoiding(p)}
                    data-testid={`payment-void-${p.id}`}
                  >
                    {t('admin.offices.payments.actions.void')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
    );
  }

  return (
    <Card
      title={t('admin.offices.payments.title')}
      style={{ marginBlockEnd: 16 }}
      extra={
        <Button type="primary" onClick={() => setRecording(true)} data-testid="payment-new">
          {t('admin.offices.payments.record')}
        </Button>
      }
    >
      {body}
      {recording ? (
        <RecordPaymentModal
          officeId={officeId}
          currency={currency}
          onClose={() => setRecording(false)}
        />
      ) : null}
      {voiding ? (
        <VoidPaymentModal officeId={officeId} payment={voiding} onClose={() => setVoiding(null)} />
      ) : null}
    </Card>
  );
}
