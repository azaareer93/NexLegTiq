import { CreateTimeEntrySchema } from '@nexlegtiq/shared-contracts';
import type { TimeEntry, UpdateTimeEntryRequest } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { toWesternDigits } from '@nexlegtiq/shared-utils';
import { Checkbox, DatePicker, Form, Input, Modal } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { zodRule } from '../../auth/forms';
import { useTimeMutations } from '../api/use-billing';

interface Values {
  readonly workDate: Dayjs | null;
  readonly durationHours: string;
  readonly description: string;
  readonly isBillable: boolean;
}

const FIELDS = ['workDate', 'durationHours', 'description', 'isBillable'];

interface Body {
  readonly workDate: string | undefined;
  readonly durationHours: string;
  readonly description: string;
  readonly isBillable: boolean;
}

/** Only what differs from the stored entry (hours compared as numbers: "1.50" is "1.5"). */
export function changedFields(body: Body, entry: TimeEntry): UpdateTimeEntryRequest {
  const changed: Record<string, unknown> = {};
  if (body.workDate && body.workDate !== entry.workDate) changed.workDate = body.workDate;
  if (Number(body.durationHours) !== Number(entry.durationHours)) {
    changed.durationHours = body.durationHours;
  }
  if (body.description !== entry.description) changed.description = body.description;
  if (body.isBillable !== entry.isBillable) changed.isBillable = body.isBillable;
  return changed;
}

/** Add (entry null) or edit a time entry (D-152). A refusal such as BIZ-006 (invoiced meanwhile) shows in the dialog. */
export function EntryModal({
  fileId,
  entry,
  onClose,
}: {
  readonly fileId: string;
  readonly entry: TimeEntry | null;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const { create, update } = useTimeMutations();
  const { applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const [error, setError] = useState<unknown>(null);
  const message = (key: string) => t(key as never);
  const shape = CreateTimeEntrySchema.shape;
  const initial: Values = entry
    ? {
        workDate: dayjs(entry.workDate),
        durationHours: entry.durationHours,
        description: entry.description,
        isBillable: entry.isBillable,
      }
    : { workDate: null, durationHours: '', description: '', isBillable: true };

  const write = async (body: Body) => {
    if (!entry) return create.mutateAsync({ fileId, ...body });
    const changed = changedFields(body, entry);
    return Object.keys(changed).length > 0
      ? update.mutateAsync({ id: entry.id, body: changed })
      : undefined;
  };
  const submit = async (values: Values) => {
    setError(null);
    try {
      await write({
        durationHours: toWesternDigits(values.durationHours).trim(),
        description: values.description.trim(),
        isBillable: values.isBillable,
        workDate: values.workDate?.format('YYYY-MM-DD'),
      });
      onClose();
    } catch (failure) {
      if (!applyToForm(form, failure, FIELDS)) setError(failure);
    }
  };

  return (
    <Modal
      open
      title={t(entry ? 'billing.form.editTitle' : 'billing.form.addTitle')}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      confirmLoading={create.isPending || update.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
      okButtonProps={{ 'data-testid': 'entry-save' }}
    >
      <Form
        form={form}
        layout="vertical"
        noValidate
        initialValues={initial}
        onFinish={(values) => void submit(values)}
      >
        {error ? <ApiErrorAlert error={error} /> : null}
        <Form.Item
          name="workDate"
          label={t('billing.form.date')}
          extra={entry ? undefined : t('billing.form.dateHint')}
        >
          <DatePicker
            format="DD/MM/YYYY"
            allowClear={!entry}
            disabledDate={(day) => day.isAfter(dayjs(), 'day')}
            style={{ inlineSize: '100%' }}
            data-testid="entry-date"
          />
        </Form.Item>
        <Form.Item
          name="durationHours"
          label={t('billing.form.hours')}
          extra={t('billing.form.hoursHint')}
          rules={zodRule(shape.durationHours, message)}
          normalize={(value: string) => toWesternDigits(value)}
        >
          <Input inputMode="decimal" dir="ltr" maxLength={5} data-testid="entry-hours" />
        </Form.Item>
        <Form.Item
          name="description"
          label={t('billing.form.description')}
          rules={zodRule(shape.description, message)}
        >
          <Input.TextArea rows={3} maxLength={2000} data-testid="entry-description" />
        </Form.Item>
        <Form.Item name="isBillable" valuePropName="checked">
          <Checkbox data-testid="entry-billable">{t('billing.form.billable')}</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}
