import { FilePdfOutlined } from '@ant-design/icons';
import type { PortalInvoice } from '@nexlegtiq/shared-contracts';
import {
  Bdi,
  EmptyState,
  LoadingSkeleton,
  Ltr,
  PageHeader,
  StatusTag,
  useFormat,
} from '@nexlegtiq/shared-ui';
import type { StatusTone } from '@nexlegtiq/shared-ui';
import { isolateLtr } from '@nexlegtiq/shared-utils';
import { Button, Card, Flex, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useOffices } from '../../auth';
import { LoadFailed } from '../../files/components/ListStates';
import { useInvoicePdf, useInvoices } from '../../files/hooks';

const TONE: Record<PortalInvoice['status'], StatusTone> = {
  SENT: 'warning',
  OVERDUE: 'error',
  PAID: 'success',
};

/** The invoices the offices shared with the client: paid or not, and the PDF. */
export function InvoicesPage(): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const invoices = useInvoices();
  const pdf = useInvoicePdf();
  const severalOffices = new Set(useOffices().map((office) => office.officeId)).size > 1;

  let content: React.ReactNode;
  if (invoices.isError) {
    content = <LoadFailed error={invoices.error} onRetry={() => void invoices.refetch()} />;
  } else if (!invoices.data) content = <LoadingSkeleton />;
  else if (invoices.data.length === 0) {
    content = (
      <EmptyState title={t('portal.invoices.empty')} description={t('portal.invoices.emptyHint')} />
    );
  } else {
    content = (
      <Flex vertical gap={12} data-testid="invoices-list">
        {invoices.data.map((invoice) => (
          <Card size="small" key={invoice.id} data-testid={`invoice-${invoice.id}`}>
            <Flex vertical gap={4}>
              <Flex justify="space-between" align="start" gap={8}>
                <Typography.Text strong>
                  {t('portal.invoices.number', { number: isolateLtr(invoice.invoiceNumber) })}
                </Typography.Text>
                <StatusTag tone={TONE[invoice.status]}>
                  {t(`portal.invoices.status.${invoice.status}`)}
                </StatusTag>
              </Flex>
              <Typography.Text strong style={{ fontSize: 18 }}>
                <Bdi>{format.money(invoice.total, invoice.currency)}</Bdi>
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('portal.invoices.issued')}: <Bdi>{format.date(invoice.issueDate)}</Bdi>
                {t('timeline.separator')}
                {invoice.paidAt ? (
                  <Bdi>{t('portal.invoices.paidOn', { date: format.date(invoice.paidAt) })}</Bdi>
                ) : (
                  <>
                    {t('portal.invoices.due')}: <Bdi>{format.date(invoice.dueDate)}</Bdi>
                  </>
                )}
              </Typography.Text>
              {invoice.file || severalOffices ? (
                <Typography.Text type="secondary">
                  {severalOffices ? <bdi>{invoice.officeName}</bdi> : null}
                  {severalOffices && invoice.file ? t('timeline.separator') : null}
                  {invoice.file ? (
                    <>
                      {t('portal.invoices.file')}: <Ltr>{invoice.file.fileNumber}</Ltr>{' '}
                      <bdi>{invoice.file.title}</bdi>
                    </>
                  ) : null}
                </Typography.Text>
              ) : null}
              <Flex>
                <Button
                  icon={<FilePdfOutlined aria-hidden />}
                  loading={pdf.isPending && pdf.variables === invoice.id}
                  onClick={() => pdf.mutate(invoice.id)}
                  data-testid={`invoice-pdf-${invoice.id}`}
                >
                  {t('portal.invoices.pdf')}
                </Button>
              </Flex>
            </Flex>
          </Card>
        ))}
      </Flex>
    );
  }

  return (
    <Flex vertical gap={16}>
      <PageHeader title={t('portal.invoices.title')} />
      {content}
    </Flex>
  );
}
