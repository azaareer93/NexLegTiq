import { CreateInvoiceSchema } from '@nexlegtiq/shared-contracts';
import type { Invoice } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, Bdi, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { toWesternDigits } from '@nexlegtiq/shared-utils';
import {
  App,
  Button,
  Checkbox,
  DatePicker,
  Flex,
  Form,
  Input,
  Modal,
  Select,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DraftPreview, ExtraLines } from './InvoiceDraft';
import { parseForm } from '../../auth/forms';
import { useInvoiceMutations } from '../api/use-invoices';

interface Line {
  readonly description?: string;
  readonly quantity?: string;
  readonly unitPrice?: string;
}

interface Values {
  readonly clientId?: string;
  readonly periodStart?: Dayjs;
  readonly periodEnd?: Dayjs;
  readonly includeTax?: boolean;
  readonly extraLines?: readonly Line[];
  readonly notes?: string;
}

const FIELDS = ['clientId', 'periodStart', 'periodEnd', 'includeTax', 'extraLines', 'notes'];

/**
 * Billing tab → "Generate invoice" (MVP-148): the period and extra items make a DRAFT on the server (its lines are the
 * unbilled billable time of the file, D-162), shown with its totals; then send it (optionally emailing the PDF, D-171),
 * delete it, or keep it as a draft.
 */
export function InvoiceWizard({
  fileId,
  clients,
  onClose,
}: {
  readonly fileId: string;
  readonly clients: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly isPrimary?: boolean;
  }[];
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const { create, send, remove } = useInvoiceMutations();
  const [draft, setDraft] = useState<Invoice | null>(null);
  const [emailClient, setEmailClient] = useState(false);
  const primary = clients.find((c) => c.isPrimary) ?? clients[0];

  const prepare = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as Values;
    const parsed = parseForm(
      CreateInvoiceSchema,
      {
        clientId: v.clientId,
        fileId,
        periodStart: v.periodStart?.format('YYYY-MM-DD'),
        periodEnd: v.periodEnd?.format('YYYY-MM-DD'),
        includeTax: v.includeTax !== false,
        // Every row is sent, so an error lands on the row that has it (an unwanted row is removed with its button).
        extraLines: (v.extraLines ?? []).map((l) => ({
          description: l.description?.trim(),
          quantity: toWesternDigits(l.quantity ?? '').trim(),
          unitPrice: toWesternDigits(l.unitPrice ?? '').trim(),
        })),
        notes: v.notes?.trim() || undefined,
      },
      form,
      translateKey,
    );
    if (!parsed) return;
    try {
      setDraft(await create.mutateAsync(parsed));
    } catch (error) {
      applyToForm(form, error, FIELDS);
    }
  };

  const sendDraft = async (invoice: Invoice) => {
    const sent = await send.mutateAsync({ id: invoice.id, body: { emailClient } });
    void message.success(t('billing.invoicing.sent', { number: sent.invoiceNumber ?? '' }));
    onClose();
  };
  const deleteDraft = async (invoice: Invoice) => {
    await remove.mutateAsync(invoice.id);
    void message.success(t('billing.invoicing.deleted'));
    onClose();
  };
  const failure = create.error ?? send.error ?? remove.error;

  return (
    <Modal
      open
      width="min(760px, 95vw)"
      // Closing mid-request would leave a draft the user never saw.
      closable={!create.isPending}
      maskClosable={!create.isPending}
      title={t(draft ? 'billing.invoicing.draftTitle' : 'billing.invoicing.title')}
      onCancel={onClose}
      footer={
        draft ? (
          <Flex gap={8} justify="end" wrap>
            <Button
              danger
              loading={remove.isPending}
              onClick={() => void deleteDraft(draft).catch(() => undefined)}
              data-testid="invoice-draft-delete"
            >
              {t('billing.invoicing.deleteDraft')}
            </Button>
            <Button onClick={onClose} data-testid="invoice-draft-keep">
              {t('billing.invoicing.keepDraft')}
            </Button>
            <Button
              type="primary"
              loading={send.isPending}
              onClick={() => void sendDraft(draft).catch(() => undefined)}
              data-testid="invoice-draft-send"
            >
              {t('billing.invoicing.send')}
            </Button>
          </Flex>
        ) : (
          <Flex gap={8} justify="end">
            <Button onClick={onClose}>{t('common.actions.cancel')}</Button>
            <Button
              type="primary"
              loading={create.isPending}
              onClick={() => void prepare()}
              data-testid="invoice-prepare"
            >
              {t('billing.invoicing.createDraft')}
            </Button>
          </Flex>
        )
      }
    >
      {draft ? (
        <>
          <DraftPreview invoice={draft} />
          <Checkbox
            checked={emailClient}
            onChange={(e) => setEmailClient(e.target.checked)}
            style={{ marginBlockStart: 12 }}
            data-testid="invoice-email-client"
          >
            {t('billing.invoicing.emailClient')}
          </Checkbox>
        </>
      ) : (
        <Form
          form={form}
          layout="vertical"
          noValidate
          initialValues={{
            clientId: primary?.id,
            periodStart: dayjs().startOf('month'),
            periodEnd: dayjs(),
            includeTax: true,
            extraLines: [],
          }}
        >
          <Form.Item name="clientId" label={t('billing.invoicing.client')}>
            <Select
              data-testid="invoice-client"
              options={clients.map((c) => ({ value: c.id, label: <Bdi>{c.displayName}</Bdi> }))}
            />
          </Form.Item>
          <Flex gap={12} wrap>
            <Form.Item
              name="periodStart"
              label={t('billing.invoicing.periodStart')}
              style={{ flex: 1 }}
            >
              <DatePicker
                format="DD/MM/YYYY"
                style={{ inlineSize: '100%' }}
                data-testid="invoice-period-start"
              />
            </Form.Item>
            <Form.Item
              name="periodEnd"
              label={t('billing.invoicing.periodEnd')}
              style={{ flex: 1 }}
            >
              <DatePicker
                format="DD/MM/YYYY"
                style={{ inlineSize: '100%' }}
                data-testid="invoice-period-end"
              />
            </Form.Item>
          </Flex>
          <Typography.Paragraph type="secondary">
            {t('billing.invoicing.periodHint')}
          </Typography.Paragraph>
          <Form.Item name="includeTax" valuePropName="checked">
            <Checkbox data-testid="invoice-include-tax">
              {t('billing.invoicing.includeTax')}
            </Checkbox>
          </Form.Item>
          <Typography.Text strong>{t('billing.invoicing.extraLines')}</Typography.Text>
          <ExtraLines />
          <Form.Item name="notes" label={t('billing.invoicing.notes')}>
            <Input.TextArea rows={2} maxLength={2000} data-testid="invoice-notes" />
          </Form.Item>
        </Form>
      )}
      {failure ? <ApiErrorAlert error={failure} fields={FIELDS} /> : null}
    </Modal>
  );
}
