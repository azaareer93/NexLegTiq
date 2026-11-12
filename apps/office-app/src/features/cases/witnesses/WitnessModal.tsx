import { CreateWitnessSchema } from '@nexlegtiq/shared-contracts';
import type { UpdateWitnessRequest, Witness } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { Checkbox, Form, Input, Modal } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useWitnessMutations } from './use-witnesses';
import { zodRule } from '../../auth/forms';

const TEXT_FIELDS = ['fullName', 'expertiseArea', 'phone', 'email', 'address', 'notes'] as const;
type TextField = (typeof TEXT_FIELDS)[number];
// Unmounted fields (expertise when not an expert) come back undefined.
type Values = Partial<Record<TextField, string>> & {
  readonly isExpert: boolean;
  readonly fullName: string;
};

/** The form's values for a stored witness (or a new one): every text field a string. */
function stored(witness: Witness | null): Values {
  const text = Object.fromEntries(TEXT_FIELDS.map((field) => [field, witness?.[field] ?? '']));
  return { ...text, fullName: witness?.fullName ?? '', isExpert: witness?.isExpert ?? false };
}

/** What the form changed: trimmed, an empty field clears an optional field (null on edit, left out on create). */
export function witnessChanges(values: Values, witness: Witness | null): UpdateWitnessRequest {
  const before = stored(witness);
  const changed: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) {
    // A witness who is no longer an expert has no field of expertise.
    const raw = field === 'expertiseArea' && !values.isExpert ? '' : values[field];
    const value = (raw ?? '').trim();
    if (value === before[field]) continue;
    if (value !== '') changed[field] = value;
    else if (witness) changed[field] = null;
  }
  if (values.isExpert !== before.isExpert) changed.isExpert = values.isExpert;
  return changed;
}

/** Add (witness null) or edit a witness or expert of the file (D-163). */
export function WitnessModal({
  fileId,
  witness,
  onClose,
}: {
  readonly fileId: string;
  readonly witness: Witness | null;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { create, update } = useWitnessMutations(fileId);
  const { applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const [error, setError] = useState<unknown>(null);
  const isExpert = Form.useWatch('isExpert', form);
  const message = (key: string) => t(key as never);
  const shape = CreateWitnessSchema.shape;
  const initial = stored(witness);

  const submit = async (values: Values) => {
    setError(null);
    const changed = witnessChanges(values, witness);
    try {
      if (!witness) {
        // On create nothing is null: empty fields were left out.
        const fields = changed as Record<string, string | boolean>;
        await create.mutateAsync({ ...fields, fullName: values.fullName.trim() });
      } else if (Object.keys(changed).length > 0) {
        await update.mutateAsync({ id: witness.id, body: changed });
      }
      onClose();
    } catch (failure) {
      if (!applyToForm(form, failure, [...TEXT_FIELDS, 'isExpert'])) setError(failure);
    }
  };

  return (
    <Modal
      open
      title={t(witness ? 'parties.witnesses.editTitle' : 'parties.witnesses.addTitle')}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      confirmLoading={create.isPending || update.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
      okButtonProps={{ 'data-testid': 'witness-save' }}
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
          name="fullName"
          label={t('parties.witnesses.fullName')}
          rules={zodRule(shape.fullName, message)}
        >
          <Input maxLength={200} data-testid="witness-name" />
        </Form.Item>
        <Form.Item name="isExpert" valuePropName="checked">
          <Checkbox data-testid="witness-expert">{t('parties.witnesses.isExpert')}</Checkbox>
        </Form.Item>
        {isExpert ? (
          <Form.Item name="expertiseArea" label={t('parties.witnesses.expertiseArea')}>
            <Input maxLength={200} data-testid="witness-expertise" />
          </Form.Item>
        ) : null}
        <Form.Item name="phone" label={t('parties.witnesses.phone')}>
          <Input dir="ltr" maxLength={30} data-testid="witness-phone" />
        </Form.Item>
        <Form.Item name="email" label={t('parties.witnesses.email')}>
          <Input dir="ltr" type="email" maxLength={254} data-testid="witness-email" />
        </Form.Item>
        <Form.Item name="address" label={t('parties.witnesses.address')}>
          <Input maxLength={500} />
        </Form.Item>
        <Form.Item name="notes" label={t('parties.witnesses.notes')}>
          <Input.TextArea rows={3} maxLength={2000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
