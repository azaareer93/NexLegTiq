import { ExclamationCircleOutlined } from '@ant-design/icons';
import { MarkInvoicePaidSchema } from '@nexlegtiq/shared-contracts';
import type { InvoiceListItem } from '@nexlegtiq/shared-contracts';
import { INVOICE_PAYMENT_METHODS } from '@nexlegtiq/shared-types';
import type { InvoiceStatus } from '@nexlegtiq/shared-types';
import type { StatusTone } from '@nexlegtiq/shared-ui';
import {
  ApiErrorAlert,
  ConfirmModal,
  StatusTag,
  useApiErrorHandler,
  useCan,
} from '@nexlegtiq/shared-ui';
import { App, Button, DatePicker, Form, Input, Modal, Select, Space } from 'antd';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { parseForm } from '../../auth/forms';
import { openDownload, useInvoiceMutations, useOfficeDay } from '../api/use-invoices';

const TONE: Record<InvoiceStatus, StatusTone> = {
  DRAFT: 'neutral',
  SENT: 'info',
  PAID: 'success',
  OVERDUE: 'error',
  VOID: 'neutral',
};

/** Status by colour, icon and text; an overdue invoice says so in words with a warning icon (never colour alone). */
export function InvoiceStatusTag({ status }: { readonly status: InvoiceStatus }) {
  const { t } = useTranslation();
  return (
    <StatusTag
      tone={TONE[status]}
      {...(status === 'OVERDUE' ? { icon: ExclamationCircleOutlined } : {})}
    >
      {status === 'OVERDUE' ? t('billing.invoices.overdue') : t(`enums.invoiceStatus.${status}`)}
    </StatusTag>
  );
}

interface PaidValues {
  readonly paidAt?: Dayjs;
  readonly method?: string;
  readonly reference?: string;
}

function MarkPaidModal({
  invoice,
  onClose,
}: {
  readonly invoice: InvoiceListItem;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<PaidValues>();
  const { markPaid } = useInvoiceMutations();
  const day = useOfficeDay();
  // Paying from the retainer needs the invoice's file (D-176): not offered on a consolidated invoice.
  const methods = INVOICE_PAYMENT_METHODS.filter((m) => m !== 'RETAINER' || invoice.file !== null);

  const submit = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as PaidValues;
    const parsed = parseForm(
      MarkInvoicePaidSchema,
      {
        // Noon local time keeps the chosen day in every office zone.
        paidAt: v.paidAt ? day.noon(v.paidAt) : undefined,
        method: v.method,
        reference: v.reference?.trim() || undefined,
      },
      form,
      translateKey,
    );
    if (!parsed) return;
    try {
      await markPaid.mutateAsync({ id: invoice.id, body: parsed });
      void message.success(t('billing.invoices.paid'));
      onClose();
    } catch (error) {
      applyToForm(form, error, ['paidAt', 'method', 'reference']);
    }
  };

  return (
    <Modal
      open
      title={t('billing.invoices.paidTitle')}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ 'data-testid': 'invoice-paid-confirm' }}
      confirmLoading={markPaid.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        noValidate
        initialValues={{ paidAt: day.today, method: 'BANK_TRANSFER' }}
      >
        <Form.Item name="paidAt" label={t('billing.invoices.paidAt')}>
          <DatePicker
            format="DD/MM/YYYY"
            disabledDate={day.isFuture}
            style={{ inlineSize: '100%' }}
            data-testid="invoice-paid-at"
          />
        </Form.Item>
        <Form.Item name="method" label={t('billing.invoices.method')}>
          <Select
            data-testid="invoice-paid-method"
            options={methods.map((m) => ({
              value: m,
              label: t(`enums.invoicePaymentMethod.${m}`),
            }))}
          />
        </Form.Item>
        <Form.Item name="reference" label={t('billing.invoices.reference')}>
          <Input dir="ltr" maxLength={200} data-testid="invoice-paid-reference" />
        </Form.Item>
      </Form>
      {markPaid.isError ? (
        <ApiErrorAlert error={markPaid.error} fields={['paidAt', 'method', 'reference']} />
      ) : null}
    </Modal>
  );
}

/** What can be done with an invoice in its state, for someone with the rights (D-162): send, mark paid, void, PDF. */
export function InvoiceActions({ invoice }: { readonly invoice: InvoiceListItem }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const mayGenerate = useCan('generate:invoice');
  const mayMarkPaid = useCan('mark:invoice:paid');
  const { send, void: voiding, pdf } = useInvoiceMutations();
  const [paying, setPaying] = useState(false);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const open = invoice.status === 'SENT' || invoice.status === 'OVERDUE';

  const download = async () => {
    try {
      const answer = await pdf.mutateAsync(invoice.id);
      if (answer.status === 'READY') openDownload(answer.downloadUrl);
      else void message.info(t('billing.invoices.pdfRendering'));
    } catch (error) {
      notify(error);
    }
  };

  return (
    <Space size={4} wrap>
      {invoice.status === 'DRAFT' && mayGenerate ? (
        <Button
          size="small"
          loading={send.isPending}
          onClick={() =>
            send.mutate(
              { id: invoice.id },
              {
                onSuccess: (sent) =>
                  void message.success(
                    t('billing.invoicing.sent', { number: sent.invoiceNumber ?? '' }),
                  ),
                onError: notify,
              },
            )
          }
          data-testid={`invoice-send-${invoice.id}`}
        >
          {t('billing.invoices.actions.send')}
        </Button>
      ) : null}
      {open && mayMarkPaid ? (
        <Button
          size="small"
          onClick={() => setPaying(true)}
          data-testid={`invoice-pay-${invoice.id}`}
        >
          {t('billing.invoices.actions.markPaid')}
        </Button>
      ) : null}
      {open && mayGenerate ? (
        <Button
          size="small"
          danger
          onClick={() => setConfirmVoid(true)}
          data-testid={`invoice-void-${invoice.id}`}
        >
          {t('billing.invoices.actions.void')}
        </Button>
      ) : null}
      {invoice.status !== 'DRAFT' ? (
        <Button
          size="small"
          loading={pdf.isPending}
          onClick={() => void download()}
          data-testid={`invoice-pdf-${invoice.id}`}
        >
          {t('billing.invoices.actions.pdf')}
        </Button>
      ) : null}
      {paying ? <MarkPaidModal invoice={invoice} onClose={() => setPaying(false)} /> : null}
      <ConfirmModal
        open={confirmVoid}
        danger
        title={t('billing.invoices.voidTitle')}
        confirmText={t('billing.invoices.actions.void')}
        loading={voiding.isPending}
        onConfirm={() =>
          voiding.mutate(invoice.id, {
            onSuccess: () => void message.success(t('billing.invoices.voided')),
            onError: notify,
            onSettled: () => setConfirmVoid(false),
          })
        }
        onCancel={() => setConfirmVoid(false)}
      >
        {t('billing.invoices.voidBody')}
      </ConfirmModal>
    </Space>
  );
}
