import { CreateCourtSchema, CreateJudgeSchema } from '@nexlegtiq/shared-contracts';
import type { Court, Judge } from '@nexlegtiq/shared-contracts';
import { COURT_TYPES } from '@nexlegtiq/shared-types';
import type { CourtType } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { Form, Input, Modal, Select } from 'antd';
import { useTranslation } from 'react-i18next';

import { parseForm, zodRule } from '../../auth/forms';
import { useCreateCourt, useCreateJudge } from '../api/use-cases';

interface CourtValues {
  nameAr: string;
  nameEn?: string;
  courtType?: CourtType;
  city?: string;
}

const COURT_FIELDS = ['nameAr', 'nameEn', 'courtType', 'city'];

const blankToUndefined = (value: string | undefined) => value?.trim() || undefined;

/**
 * Adds an office court without leaving the form (D-115: anyone who opens files or schedules hearings may): its Arabic
 * name (prefilled with what was searched), type, optional English name and city. The new court is picked.
 */
export function NewCourtModal({
  initialName,
  onClose,
  onCreated,
}: {
  readonly initialName: string | null;
  readonly onClose: () => void;
  readonly onCreated: (court: Court) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<CourtValues>();
  const create = useCreateCourt();
  const rule = (field: 'nameAr' | 'nameEn' | 'city') =>
    zodRule(CreateCourtSchema.shape[field], translateKey);

  const submit = (values: CourtValues) => {
    const body = parseForm(
      CreateCourtSchema,
      {
        nameAr: values.nameAr,
        courtType: values.courtType,
        nameEn: blankToUndefined(values.nameEn),
        city: blankToUndefined(values.city),
      },
      form,
      translateKey,
    );
    if (!body) return;
    create.mutate(body, {
      onSuccess: onCreated,
      onError: (error) => applyToForm(form, error, COURT_FIELDS),
    });
  };

  return (
    <Modal
      open={initialName !== null}
      title={t('cases.create.newCourt')}
      okText={t('common.actions.save')}
      okButtonProps={{ loading: create.isPending, 'data-testid': 'new-court-save' }}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
      data-testid="new-court-modal"
    >
      <ApiErrorAlert error={create.error} fields={COURT_FIELDS} testId="new-court-error" />
      <Form<CourtValues>
        form={form}
        layout="vertical"
        noValidate
        requiredMark={false}
        initialValues={{ nameAr: initialName ?? '' }}
        onFinish={submit}
        disabled={create.isPending}
      >
        <Form.Item name="nameAr" label={t('cases.create.courtNameAr')} rules={rule('nameAr')}>
          <Input dir="rtl" data-testid="new-court-name" />
        </Form.Item>
        <Form.Item
          name="courtType"
          label={t('cases.create.courtType')}
          rules={[{ required: true, message: translateKey('validation.required') }]}
        >
          <Select
            options={COURT_TYPES.map((value) => ({ value, label: t(`enums.courtType.${value}`) }))}
            data-testid="new-court-type"
          />
        </Form.Item>
        <Form.Item name="nameEn" label={t('cases.create.courtNameEn')} rules={rule('nameEn')}>
          <Input dir="ltr" data-testid="new-court-name-en" />
        </Form.Item>
        <Form.Item name="city" label={t('cases.create.city')} rules={rule('city')}>
          <Input dir="auto" data-testid="new-court-city" />
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
