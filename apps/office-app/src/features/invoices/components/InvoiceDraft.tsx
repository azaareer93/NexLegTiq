import type { Invoice } from '@nexlegtiq/shared-contracts';
import { Bdi, Ltr, useFormat } from '@nexlegtiq/shared-ui';
import { Button, Descriptions, Flex, Form, Input, Table, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

/** The draft as the server built it: its lines and totals (the server's money, D-162 — nothing is summed here). */
export function DraftPreview({ invoice }: { readonly invoice: Invoice }) {
  const { t } = useTranslation();
  const format = useFormat();
  const money = (amount: string) => <Bdi>{format.money(amount, invoice.currency)}</Bdi>;
  return (
    <Flex vertical gap={12} data-testid="invoice-draft">
      <Typography.Text type="secondary">{t('billing.invoicing.draftHint')}</Typography.Text>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={invoice.lines}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: t('billing.invoicing.lineDescription'), dataIndex: 'description' },
          {
            title: t('billing.invoicing.lineSource'),
            render: (_, l) =>
              t(l.timeEntryId ? 'billing.invoicing.timeLine' : 'billing.invoicing.extraLine'),
          },
          {
            title: t('billing.invoicing.lineQuantity'),
            align: 'end',
            render: (_, l) => <Ltr>{format.number(l.quantity)}</Ltr>,
          },
          {
            title: t('billing.invoicing.linePrice'),
            align: 'end',
            render: (_, l) => money(l.unitPrice),
          },
          {
            title: t('billing.invoices.columns.total'),
            align: 'end',
            render: (_, l) => money(l.amount),
          },
        ]}
      />
      <Descriptions column={1} size="small" bordered data-testid="invoice-totals">
        <Descriptions.Item label={t('billing.invoicing.subtotal')}>
          {money(invoice.subtotal)}
        </Descriptions.Item>
        <Descriptions.Item
          label={t('billing.invoicing.tax', { rate: format.number(invoice.taxRatePercent) })}
        >
          {money(invoice.taxAmount)}
        </Descriptions.Item>
        <Descriptions.Item label={t('billing.invoicing.total')}>
          <strong>{money(invoice.total)}</strong>
        </Descriptions.Item>
      </Descriptions>
    </Flex>
  );
}

/** The wizard's extra items (fees, expenses): description, quantity (1 by default) and unit price per row. */
export function ExtraLines() {
  const { t } = useTranslation();
  return (
    <Form.List name="extraLines">
      {(fields, { add, remove: drop }) => (
        <Flex vertical gap={8} style={{ marginBlock: 8 }}>
          {fields.map((field, index) => (
            <Flex key={field.key} gap={8} wrap align="start">
              <Form.Item name={[field.name, 'description']} style={{ flex: 3, marginBlockEnd: 0 }}>
                <Input
                  placeholder={t('billing.invoicing.lineDescription')}
                  aria-label={t('billing.invoicing.lineDescription')}
                  maxLength={500}
                  data-testid={`invoice-line-description-${index}`}
                />
              </Form.Item>
              <Form.Item name={[field.name, 'quantity']} style={{ flex: 1, marginBlockEnd: 0 }}>
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  placeholder={t('billing.invoicing.lineQuantity')}
                  aria-label={t('billing.invoicing.lineQuantity')}
                  data-testid={`invoice-line-quantity-${index}`}
                />
              </Form.Item>
              <Form.Item name={[field.name, 'unitPrice']} style={{ flex: 1, marginBlockEnd: 0 }}>
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  placeholder={t('billing.invoicing.linePrice')}
                  aria-label={t('billing.invoicing.linePrice')}
                  data-testid={`invoice-line-price-${index}`}
                />
              </Form.Item>
              <Button
                onClick={() => drop(field.name)}
                aria-label={t('billing.invoicing.removeLine')}
              >
                {t('billing.invoicing.removeLine')}
              </Button>
            </Flex>
          ))}
          <Button
            onClick={() => add({ quantity: '1' })}
            style={{ alignSelf: 'start' }}
            data-testid="invoice-line-add"
          >
            {t('billing.invoicing.addLine')}
          </Button>
        </Flex>
      )}
    </Form.List>
  );
}
