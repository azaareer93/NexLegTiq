import type { Case } from '@nexlegtiq/shared-contracts';
import { UpdateCaseSchema } from '@nexlegtiq/shared-contracts';
import { BILLING_METHODS, PRIORITIES } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, Ltr, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button, Drawer, Flex, Form, Input, Select, Switch } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { parseForm, zodRule } from '../../auth/forms';
import { useUpdateCase } from '../api/use-cases';
import type { FileActions } from '../file-page';

const TEXT_FIELDS = ['title', 'description', 'subType', 'courtCaseNumber'] as const;
const BILLING_FIELDS = ['billingMethod', 'hourlyRate', 'fixedFee'] as const;
const FIELDS = [...TEXT_FIELDS, 'priority', ...BILLING_FIELDS, 'isConfidential'] as const;
type Field = (typeof FIELDS)[number];
type Values = Partial<Record<Field, string | boolean | null>>;

/** The form's starting values: the file as it is (empty optional text as ''). */
function valuesOf(file: Case): Values {
  return {
    title: file.title,
    description: file.description ?? '',
    subType: file.subType ?? '',
    courtCaseNumber: file.courtCaseNumber ?? '',
    priority: file.priority,
    billingMethod: file.billingMethod,
    hourlyRate: file.hourlyRate ?? '',
    fixedFee: file.fixedFee ?? '',
    isConfidential: file.isConfidential,
  };
}

/**
 * The PATCH body: only the fields the user may edit and really changed; '' clears an optional field (null). Money is
 * compared as written — the server compares decimals and audits only real changes (D-096).
 */
export function changesOf(file: Case, values: Values, actions: FileActions): Values {
  const before = valuesOf(file);
  const editable: readonly Field[] = [
    ...TEXT_FIELDS,
    'priority',
    ...(actions.billing ? BILLING_FIELDS : []),
    ...(actions.confidentiality ? (['isConfidential'] as const) : []),
  ];
  const changes: Values = {};
  for (const field of editable) {
    const value = typeof values[field] === 'string' ? values[field].trim() : values[field];
    if (value !== undefined && value !== before[field]) {
      changes[field] = value === '' && field !== 'title' ? null : value;
    }
  }
  return changes;
}

interface EditCaseDrawerProps {
  readonly file: Case;
  readonly actions: FileActions;
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * Edits the file's own fields (D-118); status, team, lawyer and court have their own flows. Every opening gets a fresh
 * form, so a cancelled edit leaves nothing behind (not `clearOnDestroy`: StrictMode's dev remount wipes initial values).
 */
export function EditCaseDrawer(props: EditCaseDrawerProps): React.JSX.Element {
  const [opening, setOpening] = useState({ open: props.open, count: 0 });
  if (props.open !== opening.open) {
    setOpening({ open: props.open, count: opening.count + (props.open ? 1 : 0) });
  }
  return <CaseEditDrawer key={opening.count} {...props} />;
}

function CaseEditDrawer({ file, actions, open, onClose }: EditCaseDrawerProps): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const update = useUpdateCase(file.id);
  const shape = UpdateCaseSchema.shape;
  const rules = (field: Field) =>
    // Every PATCH field is optional; the title may not be emptied.
    zodRule(field === 'title' ? shape.title.unwrap() : shape[field], translateKey);

  const close = () => {
    update.reset();
    onClose();
  };

  const submit = (values: Values) => {
    const changes = changesOf(file, values, actions);
    if (Object.keys(changes).length === 0) {
      close();
      return;
    }
    const body = parseForm(UpdateCaseSchema, changes, form, translateKey);
    if (body) {
      update.mutate(body, {
        onSuccess: () => {
          void message.success(t('common.feedback.saved'));
          close();
        },
        onError: (error) => applyToForm(form, error, FIELDS),
      });
    }
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      title={t('cases.file.edit.title')}
      size="large"
      destroyOnHidden
      mask={{ closable: !update.isPending }}
      data-testid="case-edit-drawer"
      footer={
        <Flex gap={8} justify="end">
          <Button onClick={close} disabled={update.isPending} data-testid="case-edit-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            type="primary"
            loading={update.isPending}
            onClick={() => form.submit()}
            data-testid="case-edit-save"
          >
            {t('common.actions.save')}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={16}>
        <ApiErrorAlert error={update.error} fields={FIELDS} testId="case-edit-error" />
        <Form
          form={form}
          layout="vertical"
          noValidate
          requiredMark={false}
          initialValues={valuesOf(file)}
          onFinish={submit}
          disabled={update.isPending}
        >
          <Form.Item name="title" label={t('cases.file.fields.title')} rules={rules('title')}>
            <Input dir="auto" data-testid="case-title-input" />
          </Form.Item>
          <Form.Item name="priority" label={t('cases.file.fields.priority')}>
            <Select
              data-testid="case-priority-input"
              options={PRIORITIES.map((value) => ({
                value,
                label: t(`enums.priority.${value}`),
              }))}
            />
          </Form.Item>
          <Form.Item name="subType" label={t('cases.file.fields.subType')} rules={rules('subType')}>
            <Input dir="auto" data-testid="case-subtype-input" />
          </Form.Item>
          <Form.Item
            name="courtCaseNumber"
            label={t('legal.courtCaseNumber')}
            rules={rules('courtCaseNumber')}
          >
            <Input dir="ltr" data-testid="case-court-number-input" />
          </Form.Item>
          <Form.Item
            name="description"
            label={t('cases.file.fields.description')}
            rules={rules('description')}
          >
            <Input.TextArea
              dir="auto"
              autoSize={{ minRows: 3, maxRows: 10 }}
              data-testid="case-description-input"
            />
          </Form.Item>
          {actions.billing ? (
            <>
              <Form.Item name="billingMethod" label={t('cases.file.billing.method')}>
                <Select
                  data-testid="case-billing-input"
                  options={BILLING_METHODS.map((value) => ({
                    value,
                    label: t(`enums.billingMethod.${value}`),
                  }))}
                />
              </Form.Item>
              <Form.Item
                name="hourlyRate"
                label={t('cases.file.billing.rate')}
                rules={rules('hourlyRate')}
              >
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  suffix={<Ltr>{file.currency}</Ltr>}
                  data-testid="case-rate-input"
                />
              </Form.Item>
              <Form.Item
                name="fixedFee"
                label={t('cases.file.billing.fee')}
                rules={rules('fixedFee')}
              >
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  suffix={<Ltr>{file.currency}</Ltr>}
                  data-testid="case-fee-input"
                />
              </Form.Item>
            </>
          ) : null}
          {actions.confidentiality ? (
            <Form.Item
              name="isConfidential"
              label={t('cases.file.fields.confidential')}
              valuePropName="checked"
              extra={t('cases.file.edit.confidentialHint')}
            >
              <Switch data-testid="case-confidential-input" />
            </Form.Item>
          ) : null}
        </Form>
      </Flex>
    </Drawer>
  );
}
