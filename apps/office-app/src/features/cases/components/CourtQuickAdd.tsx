import { CreateJudgeSchema, ReportCourtSchema } from '@nexlegtiq/shared-contracts';
import type { Judge } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Form, Input, Modal, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { parseForm, zodRule } from '../../auth/forms';
import { useCreateJudge, useReportCourt } from '../api/use-cases';

interface ReportValues {
  name: string;
  city?: string;
  note?: string;
}

const REPORT_FIELDS = ['name', 'city', 'note'];

const blankToUndefined = (value: string | undefined) => value?.trim() || undefined;

/**
 * Offices no longer add courts (D-266): a court missing from the list is reported (name prefilled with what was searched,
 * city, note) for the platform team, who adds it and notifies the reporter.
 */
export function ReportCourtModal({
  initialName,
  onClose,
}: {
  readonly initialName: string | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<ReportValues>();
  const report = useReportCourt();
  const rule = (field: 'name' | 'city' | 'note') =>
    zodRule(ReportCourtSchema.shape[field], translateKey);

  const submit = (values: ReportValues) => {
    const body = parseForm(
      ReportCourtSchema,
      {
        name: values.name,
        city: blankToUndefined(values.city),
        note: blankToUndefined(values.note),
      },
      form,
      translateKey,
    );
    if (!body) return;
    report.mutate(body, {
      onSuccess: () => {
        void message.success(t('cases.create.reportSent'));
        onClose();
      },
      onError: (error) => applyToForm(form, error, REPORT_FIELDS),
    });
  };

  return (
    <Modal
      open={initialName !== null}
      title={t('cases.create.reportCourt')}
      okText={t('cases.create.reportSend')}
      okButtonProps={{ loading: report.isPending, 'data-testid': 'report-court-send' }}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
      data-testid="report-court-modal"
    >
      <Typography.Paragraph type="secondary">
        {t('cases.create.reportCourtHint')}
      </Typography.Paragraph>
      <ApiErrorAlert error={report.error} fields={REPORT_FIELDS} testId="report-court-error" />
      <Form<ReportValues>
        form={form}
        layout="vertical"
        noValidate
        requiredMark={false}
        initialValues={{ name: initialName ?? '' }}
        onFinish={submit}
        disabled={report.isPending}
      >
        <Form.Item name="name" label={t('cases.create.reportName')} rules={rule('name')}>
          <Input dir="auto" data-testid="report-court-name" />
        </Form.Item>
        <Form.Item name="city" label={t('cases.create.city')} rules={rule('city')}>
          <Input dir="auto" data-testid="report-court-city" />
        </Form.Item>
        <Form.Item name="note" label={t('cases.create.reportNote')} rules={rule('note')}>
          <Input.TextArea rows={2} dir="auto" data-testid="report-court-note" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Adds an office judge at the picked court (also at a platform court, D-115); the new judge is picked. */
export function NewJudgeModal({
  courtId,
  open,
  onClose,
  onCreated,
}: {
  readonly courtId: string | undefined;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (judge: Judge) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<{ fullName: string }>();
  const create = useCreateJudge(courtId);
  return (
    <Modal
      open={open}
      title={t('cases.create.newJudge')}
      okText={t('common.actions.save')}
      okButtonProps={{ loading: create.isPending, 'data-testid': 'new-judge-save' }}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
      data-testid="new-judge-modal"
    >
      <ApiErrorAlert error={create.error} fields={['fullName']} testId="new-judge-error" />
      <Form<{ fullName: string }>
        form={form}
        layout="vertical"
        noValidate
        requiredMark={false}
        onFinish={(values) =>
          create.mutate(
            { fullName: values.fullName },
            {
              onSuccess: onCreated,
              onError: (error) => applyToForm(form, error, ['fullName']),
            },
          )
        }
        disabled={create.isPending}
      >
        <Form.Item
          name="fullName"
          label={t('cases.create.judgeName')}
          rules={zodRule(CreateJudgeSchema.shape.fullName, translateKey)}
        >
          <Input dir="auto" data-testid="new-judge-name" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
