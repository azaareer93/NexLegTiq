import { DismissCourtReportSchema } from '@nexlegtiq/shared-contracts';
import type { AdminCourtReport } from '@nexlegtiq/shared-contracts';
import { COURT_REPORT_STATUSES } from '@nexlegtiq/shared-types';
import type { CourtReportStatus } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, Bdi, StatusTag, useApiErrorHandler, useFormat } from '@nexlegtiq/shared-ui';
import { App, Button, Form, Input, Modal, Select, Space } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { CourtModal } from './CourtModal';
import { PagedTable, PAGE_SIZE } from './PagedTable';
import { parseForm, zodRule } from '../../auth/forms';
import { useCourtMutations, useCourtReports } from '../hooks';

const TONE = { PENDING: 'warning', ADDED: 'success', DISMISSED: 'neutral' } as const;

/** Courts offices reported missing (D-266): add the court or dismiss the report; the office is notified either way. */
export function CourtReportsTab(): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const [status, setStatus] = useState<CourtReportStatus | 'ALL'>('PENDING');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState<AdminCourtReport | null>(null);
  const [dismissing, setDismissing] = useState<AdminCourtReport | null>(null);
  const list = useCourtReports({
    page: String(page),
    limit: String(PAGE_SIZE),
    ...(status === 'ALL' ? {} : { status }),
  });

  return (
    <section data-testid="court-reports">
      <Select<CourtReportStatus | 'ALL'>
        value={status}
        onChange={(value) => {
          setStatus(value);
          setPage(1);
        }}
        options={[
          ...COURT_REPORT_STATUSES.map((value) => ({
            value,
            label: t(`enums.courtReportStatus.${value}`),
          })),
          { value: 'ALL' as const, label: t('admin.courts.reports.all') },
        ]}
        aria-label={t('admin.courts.reports.status')}
        style={{ minInlineSize: 180, marginBlockEnd: 16 }}
        data-testid="reports-status"
      />
      <PagedTable<AdminCourtReport>
        query={list}
        page={page}
        onPage={setPage}
        empty={t('admin.courts.reports.empty')}
        testId="reports"
        columns={[
          { title: t('admin.courts.columns.name'), render: (_, r) => <Bdi>{r.name}</Bdi> },
          { title: t('admin.courts.columns.city'), render: (_, r) => <Bdi>{r.city}</Bdi> },
          { title: t('admin.courts.columns.note'), render: (_, r) => <Bdi>{r.note}</Bdi> },
          {
            title: t('admin.courts.columns.office'),
            render: (_, r) => (
              <Bdi>
                {r.officeName} · {t(`enums.jurisdiction.${r.jurisdiction}`)}
              </Bdi>
            ),
          },
          {
            title: t('admin.courts.columns.reportedBy'),
            render: (_, r) => <Bdi>{r.reportedByName}</Bdi>,
          },
          {
            title: t('admin.courts.columns.reportedAt'),
            render: (_, r) => <Bdi>{format.date(r.createdAt)}</Bdi>,
          },
          {
            title: t('admin.courts.columns.status'),
            render: (_, r) => (
              <StatusTag tone={TONE[r.status]}>
                {t(`enums.courtReportStatus.${r.status}`)}
              </StatusTag>
            ),
          },
          {
            title: t('admin.courts.columns.actions'),
            render: (_, r) =>
              r.status === 'PENDING' ? (
                <Space>
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => setAdding(r)}
                    data-testid={`report-add-${r.id}`}
                  >
                    {t('admin.courts.reports.add')}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => setDismissing(r)}
                    data-testid={`report-dismiss-${r.id}`}
                  >
                    {t('admin.courts.reports.dismiss')}
                  </Button>
                </Space>
              ) : null,
          },
        ]}
      />
      {adding ? <CourtModal mode="report" report={adding} onClose={() => setAdding(null)} /> : null}
      {dismissing ? <DismissModal report={dismissing} onClose={() => setDismissing(null)} /> : null}
    </section>
  );
}

function DismissModal({
  report,
  onClose,
}: {
  readonly report: AdminCourtReport;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<{ reason?: string }>();
  const { dismiss } = useCourtMutations();

  const submit = async (): Promise<void> => {
    const reason = (form.getFieldValue('reason') as string | undefined)?.trim();
    const body = parseForm(DismissCourtReportSchema, reason ? { reason } : {}, form, translateKey);
    if (!body) return;
    try {
      await dismiss.mutateAsync({ id: report.id, body });
      void message.success(t('admin.courts.reports.dismissed'));
      onClose();
    } catch (error) {
      applyToForm(form, error, ['reason']);
    }
  };

  return (
    <Modal
      open
      title={t('admin.courts.reports.dismissTitle')}
      okText={t('admin.courts.reports.dismiss')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ danger: true, 'data-testid': 'dismiss-confirm' }}
      confirmLoading={dismiss.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Form form={form} layout="vertical" noValidate>
        <Form.Item
          name="reason"
          label={t('admin.courts.reports.reason')}
          rules={zodRule(DismissCourtReportSchema.shape.reason, translateKey)}
        >
          <Input.TextArea rows={3} dir="auto" data-testid="dismiss-reason" />
        </Form.Item>
      </Form>
      {dismiss.isError ? <ApiErrorAlert error={dismiss.error} fields={['reason']} /> : null}
    </Modal>
  );
}
