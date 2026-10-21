import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { Form, Input, Modal } from 'antd';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

import { zodRule } from '../../auth/forms';

/** A one-field dialog for a name (new folder, rename folder, rename document), checked with the contract's field. */
export function NameDialog({
  open,
  title,
  label,
  initial,
  okText,
  schema,
  onSubmit,
  onClose,
  testId,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly label: string;
  readonly initial?: string;
  readonly okText: string;
  readonly schema: z.ZodType;
  readonly onSubmit: (name: string) => Promise<unknown>;
  readonly onClose: () => void;
  readonly testId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [form] = Form.useForm<{ name: string }>();
  const { applyToForm, notify } = useApiErrorHandler();
  const submit = async () => {
    const { name } = await form.validateFields();
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (error) {
      if (!applyToForm(form, error, ['name'])) notify(error);
    }
  };
  return (
    <Modal
      open={open}
      title={title}
      okText={okText}
      cancelText={t('common.actions.cancel')}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
      data-testid={testId}
    >
      {/* Keyed per opening: a fresh form with this opening's starting value (StrictMode-safe, D-121). */}
      <Form
        key={initial ?? ''}
        form={form}
        layout="vertical"
        noValidate
        preserve={false}
        initialValues={{ name: initial ?? '' }}
        onFinish={() => void submit()}
      >
        <Form.Item name="name" label={label} rules={zodRule(schema, (key) => t(key as never))}>
          <Input autoFocus maxLength={255} data-testid={`${testId}-input`} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
