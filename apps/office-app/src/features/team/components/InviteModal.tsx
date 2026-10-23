import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { INVITABLE_ROLES, InviteUserSchema } from '@nexlegtiq/shared-contracts';
import { isApiError, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button, Flex, Form, Input, Modal, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { parseForm, zodRule } from '../../auth/forms';
import { useInvite } from '../api/use-team';

const shape = InviteUserSchema.shape;
const RowSchema = z.object({ email: shape.email, role: shape.role, fullName: shape.fullName });
const InviteFormSchema = z.object({ rows: RowSchema.array().min(1), message: shape.message });
type Row = z.output<typeof RowSchema>;

export interface InviteModalProps {
  readonly onClose: () => void;
}

/**
 * Invite several people at once (W2, D-134): one API call per row, one after the other, so each row gets its own answer.
 * Rows that were sent leave the form; a refused row stays with its reason (an existing email, the plan's user limit…).
 */
export function InviteModal({ onClose }: InviteModalProps): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, messageOf } = useApiErrorHandler();
  const [form] = Form.useForm();
  const invite = useInvite();
  const [sending, setSending] = useState(false);

  const submit = async (values: unknown) => {
    const parsed = parseForm(InviteFormSchema, values, form, translateKey);
    if (!parsed) return;
    setSending(true);
    const failed: Row[] = [];
    const errors: { name: (string | number)[]; errors: string[] }[] = [];
    for (const row of parsed.rows) {
      try {
        await invite.mutateAsync({ ...row, ...(parsed.message && { message: parsed.message }) });
      } catch (error) {
        const index = failed.push(row) - 1;
        const details = isApiError(error) ? (error.details ?? []) : [];
        const known = details.filter(
          (d) => d.field === 'email' || d.field === 'role' || d.field === 'fullName',
        );
        errors.push(
          ...(known.length > 0
            ? known.map((d) => ({
                name: ['rows', index, d.field ?? 'email'],
                errors: [translateKey(d.message)],
              }))
            : [{ name: ['rows', index, 'email'], errors: [messageOf(error)] }]),
        );
      }
    }
    setSending(false);
    const sent = parsed.rows.length - failed.length;
    if (sent > 0) void message.success(t('team.invite.sent', { count: sent }));
    if (failed.length === 0) {
      onClose();
      return;
    }
    form.setFieldsValue({ rows: failed });
    form.setFields(errors);
  };

  return (
    <Modal
      open
      title={t('team.invite.title')}
      okText={t('team.invite.submit')}
      cancelText={t('common.actions.cancel')}
      onOk={() => form.submit()}
      onCancel={onClose}
      confirmLoading={sending}
      okButtonProps={{ 'data-testid': 'invite-submit' }}
      width={720}
      destroyOnHidden
    >
      <Form
        form={form}
        noValidate
        layout="vertical"
        requiredMark={false}
        disabled={sending}
        onFinish={(values) => void submit(values)}
        initialValues={{ rows: [{ role: 'LAWYER' }] }}
      >
        <Form.List name="rows">
          {(fields, { add, remove }) => (
            <Flex vertical gap={8}>
              {fields.map((field, index) => (
                <Flex key={field.key} gap={8} align="end" wrap data-testid={`invite-row-${index}`}>
                  <Form.Item
                    name={[field.name, 'email']}
                    label={t('team.invite.email')}
                    rules={zodRule(shape.email, translateKey)}
                    style={{ flex: '2 1 200px', marginBlockEnd: 0 }}
                  >
                    <Input
                      type="email"
                      dir="ltr"
                      autoComplete="off"
                      data-testid={`invite-email-${index}`}
                    />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'role']}
                    label={t('team.invite.role')}
                    rules={zodRule(shape.role, translateKey)}
                    style={{ flex: '1 1 150px', marginBlockEnd: 0 }}
                  >
                    <Select
                      options={INVITABLE_ROLES.map((role) => ({
                        value: role,
                        label: t(`enums.role.${role}`),
                      }))}
                      data-testid={`invite-role-${index}`}
                    />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'fullName']}
                    label={t('team.invite.fullName')}
                    style={{ flex: '2 1 160px', marginBlockEnd: 0 }}
                  >
                    <Input data-testid={`invite-name-${index}`} />
                  </Form.Item>
                  {fields.length > 1 ? (
                    <Button
                      type="text"
                      icon={<DeleteOutlined />}
                      aria-label={t('team.invite.removeRow', { row: index + 1 })}
                      onClick={() => remove(field.name)}
                      data-testid={`invite-remove-${index}`}
                    />
                  ) : null}
                </Flex>
              ))}
              <Button
                type="dashed"
                icon={<PlusOutlined />}
                onClick={() => add({ role: 'LAWYER' })}
                data-testid="invite-add-row"
              >
                {t('team.invite.addRow')}
              </Button>
            </Flex>
          )}
        </Form.List>
        <Form.Item
          name="message"
          label={t('team.invite.message')}
          rules={zodRule(shape.message, translateKey)}
          style={{ marginBlockStart: 16 }}
        >
          <Input.TextArea rows={3} maxLength={500} showCount data-testid="invite-message" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
