import { DeleteOutlined, EditOutlined, StarOutlined } from '@ant-design/icons';
import type { Client, ContactPerson } from '@nexlegtiq/shared-contracts';
import { CreateContactPersonSchema } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, Bdi, ConfirmModal, Ltr, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { Button, Card, Flex, Form, Input, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { parseForm, zodRule } from '../../auth/forms';
import { useAddContact, useRemoveContact, useUpdateContact } from '../api/use-clients';

const FIELDS = ['fullName', 'position', 'email', 'phone'] as const;
type Field = (typeof FIELDS)[number];
type Values = Partial<Record<Field, string>>;

const valuesOf = (contact: ContactPerson): Values => ({
  fullName: contact.fullName,
  position: contact.position ?? '',
  email: contact.email ?? '',
  phone: contact.phone ?? '',
});

/** The fields that changed ('' clears an optional one), or every filled field for a new contact. */
function bodyOf(values: Values, before: Values | null): Record<string, string | null> {
  const body: Record<string, string | null> = {};
  for (const field of FIELDS) {
    const value = (values[field] ?? '').trim();
    if (before === null) {
      if (value !== '') body[field] = value;
    } else if (value !== before[field]) {
      body[field] = value === '' && field !== 'fullName' ? null : value;
    }
  }
  return body;
}

/** A client's contact persons (D-108): exactly one is primary once there are any; the server keeps that true. */
export function ContactsEditor({ client }: { readonly client: Client }): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  // null: the form adds a contact; otherwise it edits that one.
  const [editing, setEditing] = useState<ContactPerson | null>(null);
  const [removing, setRemoving] = useState<ContactPerson | null>(null);
  const add = useAddContact(client.id);
  const update = useUpdateContact(client.id);
  const remove = useRemoveContact(client.id);
  const save = editing ? update : add;
  const shape = CreateContactPersonSchema.shape;
  const rules = (field: Field) =>
    zodRule(field === 'fullName' ? shape.fullName : shape[field].unwrap(), translateKey);

  const reset = () => {
    setEditing(null);
    form.resetFields();
    add.reset();
    update.reset();
  };

  const submit = (values: Values) => {
    const body = bodyOf(values, editing ? valuesOf(editing) : null);
    const onError = (error: unknown) => applyToForm(form, error, FIELDS);
    if (!editing) {
      const parsed = parseForm(CreateContactPersonSchema, body, form, translateKey);
      if (parsed) add.mutate(parsed, { onSuccess: reset, onError });
    } else if (Object.keys(body).length === 0) {
      reset();
    } else {
      update.mutate({ contactId: editing.id, ...body }, { onSuccess: reset, onError });
    }
  };

  return (
    <Flex vertical gap={12} data-testid="client-contacts">
      <Typography.Title level={5} style={{ margin: 0 }}>
        {t('clients.contacts.title')}
      </Typography.Title>
      <ApiErrorAlert error={remove.error ?? update.error} testId="contact-error" />
      {client.contacts.length === 0 ? (
        <Typography.Text type="secondary">{t('clients.contacts.empty')}</Typography.Text>
      ) : (
        client.contacts.map((contact) => (
          <Card key={contact.id} size="small" data-testid={`contact-${contact.id}`}>
            <Flex justify="space-between" align="start" gap={8} wrap>
              <Flex vertical gap={2}>
                <Flex gap={8} align="center" wrap>
                  <Typography.Text strong>
                    <Bdi>{contact.fullName}</Bdi>
                  </Typography.Text>
                  {contact.isPrimary ? (
                    <Tag color="blue">{t('clients.contacts.primary')}</Tag>
                  ) : null}
                </Flex>
                {contact.position ? <Bdi>{contact.position}</Bdi> : null}
                {contact.phone ? <Ltr>{contact.phone}</Ltr> : null}
                {contact.email ? <Ltr>{contact.email}</Ltr> : null}
              </Flex>
              <Flex gap={4}>
                {contact.isPrimary ? null : (
                  <Button
                    size="small"
                    icon={<StarOutlined />}
                    loading={
                      update.isPending && update.variables?.contactId === contact.id && !editing
                    }
                    onClick={() => update.mutate({ contactId: contact.id, isPrimary: true })}
                    data-testid={`contact-primary-${contact.id}`}
                  >
                    {t('clients.contacts.makePrimary')}
                  </Button>
                )}
                <Button
                  size="small"
                  icon={<EditOutlined />}
                  aria-label={`${t('common.actions.edit')} — ${contact.fullName}`}
                  onClick={() => {
                    setEditing(contact);
                    form.setFieldsValue(valuesOf(contact));
                  }}
                  data-testid={`contact-edit-${contact.id}`}
                />
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={`${t('common.actions.delete')} — ${contact.fullName}`}
                  onClick={() => setRemoving(contact)}
                  data-testid={`contact-remove-${contact.id}`}
                />
              </Flex>
            </Flex>
          </Card>
        ))
      )}
      <Card size="small" title={editing ? t('common.actions.edit') : t('clients.contacts.add')}>
        <ApiErrorAlert error={add.error} fields={FIELDS} testId="contact-add-error" />
        <Form
          form={form}
          layout="vertical"
          noValidate
          requiredMark={false}
          onFinish={submit}
          disabled={save.isPending}
        >
          <Form.Item
            name="fullName"
            label={t('clients.contacts.fullName')}
            rules={rules('fullName')}
          >
            <Input dir="auto" data-testid="contact-name-input" />
          </Form.Item>
          <Form.Item
            name="position"
            label={t('clients.contacts.position')}
            rules={rules('position')}
          >
            <Input dir="auto" data-testid="contact-position-input" />
          </Form.Item>
          <Form.Item name="phone" label={t('clients.contacts.phone')} rules={rules('phone')}>
            <Input dir="ltr" type="tel" inputMode="tel" data-testid="contact-phone-input" />
          </Form.Item>
          <Form.Item name="email" label={t('clients.contacts.email')} rules={rules('email')}>
            <Input dir="ltr" type="email" data-testid="contact-email-input" />
          </Form.Item>
          <Flex gap={8} justify="end">
            {editing ? (
              <Button onClick={reset} data-testid="contact-cancel">
                {t('common.actions.cancel')}
              </Button>
            ) : null}
            <Button htmlType="submit" loading={save.isPending} data-testid="contact-save">
              {editing ? t('common.actions.save') : t('clients.contacts.add')}
            </Button>
          </Flex>
        </Form>
      </Card>
      <ConfirmModal
        open={removing !== null}
        danger
        title={t('clients.contacts.removeTitle')}
        confirmText={t('common.actions.delete')}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) {
            remove.mutate(removing.id, {
              onSuccess: () => {
                if (editing?.id === removing.id) reset();
                setRemoving(null);
              },
              onError: () => setRemoving(null),
            });
          }
        }}
      >
        {removing ? t('clients.contacts.removeBody', { name: removing.fullName }) : null}
      </ConfirmModal>
    </Flex>
  );
}
