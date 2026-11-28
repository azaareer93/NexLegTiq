import {
  AddReportedCourtSchema,
  CreateCourtSchema,
  UpdateCourtSchema,
} from '@nexlegtiq/shared-contracts';
import type { AdminCourtReport, Court } from '@nexlegtiq/shared-contracts';
import { COURT_TYPES } from '@nexlegtiq/shared-types';
import type { Jurisdiction } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Form, Input, Modal, Select } from 'antd';
import { useTranslation } from 'react-i18next';

import { parseForm, zodRule } from '../../auth/forms';
import { useCourtMutations } from '../hooks';

interface Values {
  courtType?: string;
  nameAr?: string;
  nameEn?: string;
  city?: string;
  address?: string;
  phone?: string;
  email?: string;
}

const FIELDS = ['courtType', 'nameAr', 'nameEn', 'city', 'address', 'phone', 'email'];
const OPTIONAL = ['city', 'address', 'phone', 'email'] as const;

/** Trimmed values; an empty optional field is left out on create and cleared (null) on edit. */
function bodyOf(v: Values, empty: undefined | null) {
  const body: Record<string, unknown> = {
    courtType: v.courtType,
    nameAr: v.nameAr?.trim(),
    nameEn: v.nameEn?.trim(),
  };
  for (const field of OPTIONAL) body[field] = v[field]?.trim() || empty;
  return body;
}

/** Only what changed, so a save never overwrites another admin's edit nor audits a no-op. */
const changed = (body: Record<string, unknown>, court: Court) =>
  Object.fromEntries(
    Object.entries(body).filter(([key, value]) => value !== (court[key as keyof Court] ?? null)),
  );

type Props = { readonly onClose: () => void } & (
  | { readonly mode: 'create'; readonly jurisdiction: Jurisdiction }
  | { readonly mode: 'edit'; readonly court: Court }
  | { readonly mode: 'report'; readonly report: AdminCourtReport }
);

/**
 * A platform court of a country (D-266): created, edited (the country is fixed), or added for a missing-court report
 * (prefilled with what the office wrote, created in the office's country).
 */
export function CourtModal(props: Props): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const { create, update, addReported } = useCourtMutations();
  const mutation = { create, edit: update, report: addReported }[props.mode];
  const rule = (field: keyof typeof CreateCourtSchema.shape) =>
    zodRule(CreateCourtSchema.shape[field], translateKey);

  const submit = async (): Promise<void> => {
    const v = form.getFieldsValue(true) as Values;
    try {
      if (props.mode === 'edit') {
        const diff = changed(bodyOf(v, null), props.court);
        if (Object.keys(diff).length === 0) return props.onClose();
        const body = parseForm(UpdateCourtSchema, diff, form, translateKey);
        if (!body) return;
        await update.mutateAsync({ id: props.court.id, body });
        void message.success(t('admin.courts.modal.updated'));
      } else if (props.mode === 'report') {
        const body = parseForm(AddReportedCourtSchema, bodyOf(v, undefined), form, translateKey);
        if (!body) return;
        await addReported.mutateAsync({ id: props.report.id, body });
        void message.success(t('admin.courts.reports.added'));
      } else {
        const values = { ...bodyOf(v, undefined), jurisdiction: props.jurisdiction };
        const body = parseForm(CreateCourtSchema, values, form, translateKey);
        if (!body) return;
        await create.mutateAsync(body);
        void message.success(t('admin.courts.modal.created'));
      }
      props.onClose();
    } catch (error) {
      applyToForm(form, error, FIELDS);
    }
  };

  const initial: Values =
    props.mode === 'edit'
      ? Object.fromEntries(
          Object.entries(props.court).map(([key, value]) => [key, value ?? undefined]),
        )
      : props.mode === 'report'
        ? { nameAr: props.report.name, city: props.report.city ?? undefined }
        : {};
  const title = {
    create: 'admin.courts.modal.createTitle',
    edit: 'admin.courts.modal.editTitle',
    report: 'admin.courts.modal.addReportedTitle',
  }[props.mode];
  return (
    <Modal
      open
      title={t(title)}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ 'data-testid': 'court-confirm' }}
      confirmLoading={mutation.isPending}
      onOk={() => void submit()}
      onCancel={props.onClose}
    >
      <Form form={form} layout="vertical" noValidate initialValues={initial}>
        <Form.Item
          name="courtType"
          label={t('admin.courts.columns.type')}
          rules={[{ required: true, message: translateKey('validation.required') }]}
        >
          <Select
            options={COURT_TYPES.map((value) => ({ value, label: t(`enums.courtType.${value}`) }))}
            data-testid="court-type"
          />
        </Form.Item>
        <Form.Item name="nameAr" label={t('admin.courts.columns.nameAr')} rules={rule('nameAr')}>
          <Input dir="rtl" data-testid="court-name-ar" />
        </Form.Item>
        <Form.Item name="nameEn" label={t('admin.courts.columns.nameEn')} rules={rule('nameEn')}>
          <Input dir="ltr" data-testid="court-name-en" />
        </Form.Item>
        <Form.Item name="city" label={t('admin.courts.columns.city')} rules={rule('city')}>
          <Input dir="auto" data-testid="court-city" />
        </Form.Item>
        <Form.Item name="address" label={t('admin.courts.fields.address')} rules={rule('address')}>
          <Input dir="auto" />
        </Form.Item>
        <Form.Item name="phone" label={t('admin.courts.fields.phone')} rules={rule('phone')}>
          <Input dir="ltr" inputMode="tel" />
        </Form.Item>
        <Form.Item name="email" label={t('admin.courts.fields.email')} rules={rule('email')}>
          <Input dir="ltr" inputMode="email" />
        </Form.Item>
      </Form>
      {mutation.isError ? <ApiErrorAlert error={mutation.error} fields={FIELDS} /> : null}
    </Modal>
  );
}
