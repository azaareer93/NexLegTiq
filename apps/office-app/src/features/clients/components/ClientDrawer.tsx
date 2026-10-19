import type { Client } from '@nexlegtiq/shared-contracts';
import { CreateClientSchema, UpdateClientSchema } from '@nexlegtiq/shared-contracts';
import { CLIENT_TYPES } from '@nexlegtiq/shared-types';
import type { ClientType } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, LoadingSkeleton, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button, Divider, Drawer, Flex, Form, Input, Select, Switch } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ContactsEditor } from './ContactsEditor';
import { parseForm, zodRule } from '../../auth/forms';
import { useClient, useCreateClient, useUpdateClient } from '../api/use-clients';
import { changesOf, createBody, FIELDS, isIndividual, newValues, valuesOf } from '../client-form';
import type { Field, Values } from '../client-form';

type Rules = (field: Exclude<Field, 'clientType' | 'isActive'>) => ReturnType<typeof zodRule>;

/** The name and identification fields of a person or an organisation (D-121). */
function TypeFields({
  type,
  rules,
}: {
  readonly type: unknown;
  readonly rules: Rules;
}): React.JSX.Element {
  const { t } = useTranslation();
  const person = isIndividual(type);
  return (
    <>
      <Form.Item
        name="displayName"
        label={person ? t('clients.fields.individualName') : t('clients.fields.organizationName')}
        rules={rules('displayName')}
      >
        <Input dir="auto" autoFocus data-testid="client-name-input" />
      </Form.Item>
      {person ? (
        <Form.Item
          name="nationalId"
          label={t('clients.fields.nationalId')}
          rules={rules('nationalId')}
        >
          <Input dir="ltr" data-testid="client-national-id-input" />
        </Form.Item>
      ) : (
        <>
          <Form.Item name="taxId" label={t('clients.fields.taxId')} rules={rules('taxId')}>
            <Input dir="ltr" data-testid="client-tax-id-input" />
          </Form.Item>
          <Form.Item name="industry" label={t('clients.fields.industry')} rules={rules('industry')}>
            <Input dir="auto" data-testid="client-industry-input" />
          </Form.Item>
        </>
      )}
    </>
  );
}

interface ClientFormProps {
  readonly client: Client | null;
  readonly initialName?: string;
  readonly onSaved: (client: Client) => void;
  readonly onCancel: () => void;
}

function ClientForm({
  client,
  initialName,
  onSaved,
  onCancel,
}: ClientFormProps): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const create = useCreateClient();
  const update = useUpdateClient(client?.id ?? '');
  const save = client ? update : create;
  const initial = client ? valuesOf(client) : newValues(initialName);
  // Before the form mounts the watch is empty: start from the initial type (no flash of the other fields).
  const type: unknown = Form.useWatch('clientType', form) ?? initial.clientType;
  const shape = CreateClientSchema.shape;
  const rules: Rules = (field) => zodRule(shape[field], translateKey);

  const submit = (values: Values) => {
    const done = (saved: Client) => {
      void message.success(t('common.feedback.saved'));
      onSaved(saved);
    };
    const onError = (error: unknown) => applyToForm(form, error, FIELDS);
    if (!client) {
      const body = parseForm(CreateClientSchema, createBody(values), form, translateKey);
      if (body) create.mutate(body, { onSuccess: done, onError });
      return;
    }
    const changes = changesOf(client, values);
    if (Object.keys(changes).length === 0) {
      onCancel();
      return;
    }
    const body = parseForm(UpdateClientSchema, changes, form, translateKey);
    if (body) update.mutate(body, { onSuccess: done, onError });
  };

  return (
    <Flex vertical gap={16}>
      <ApiErrorAlert error={save.error} fields={FIELDS} testId="client-error" />
      <Form
        form={form}
        layout="vertical"
        noValidate
        requiredMark={false}
        initialValues={initial}
        clearOnDestroy
        onFinish={submit}
        disabled={save.isPending}
      >
        <Form.Item name="clientType" label={t('clients.fields.clientType')}>
          <Select<ClientType>
            data-testid="client-type-input"
            options={CLIENT_TYPES.map((value) => ({
              value,
              label: t(`enums.clientType.${value}`),
            }))}
          />
        </Form.Item>
        <TypeFields type={type} rules={rules} />
        <Form.Item name="phone" label={t('clients.fields.phone')} rules={rules('phone')}>
          <Input dir="ltr" type="tel" inputMode="tel" data-testid="client-phone-input" />
        </Form.Item>
        <Form.Item name="email" label={t('clients.fields.email')} rules={rules('email')}>
          <Input dir="ltr" type="email" data-testid="client-email-input" />
        </Form.Item>
        <Form.Item name="address" label={t('clients.fields.address')} rules={rules('address')}>
          <Input.TextArea
            dir="auto"
            autoSize={{ minRows: 2, maxRows: 6 }}
            data-testid="client-address-input"
          />
        </Form.Item>
        {client ? (
          <Form.Item
            name="isActive"
            label={t('clients.fields.active')}
            valuePropName="checked"
            extra={t('clients.fields.activeHint')}
          >
            <Switch data-testid="client-active-input" />
          </Form.Item>
        ) : null}
        <Flex gap={8} justify="end">
          <Button onClick={onCancel} disabled={save.isPending} data-testid="client-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            loading={save.isPending}
            data-testid="client-save"
          >
            {t('common.actions.save')}
          </Button>
        </Flex>
      </Form>
    </Flex>
  );
}

/** The client's form once it is loaded (or a new client's), else its loading state or error. */
function DrawerBody({
  id,
  detail,
  initialName,
  onSaved,
  onCancel,
}: {
  readonly id: string | null;
  readonly detail: ReturnType<typeof useClient>;
  readonly initialName?: string;
  readonly onSaved: (client: Client) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  if (id && detail.isError && !detail.data) {
    return <ApiErrorAlert error={detail.error} testId="client-load-error" />;
  }
  if (id && !detail.data) {
    return <LoadingSkeleton rows={6} />;
  }
  return (
    <>
      <ClientForm
        key={id ?? 'new'}
        client={detail.data ?? null}
        initialName={initialName}
        onCancel={onCancel}
        onSaved={onSaved}
      />
      {detail.data ? (
        <>
          <Divider />
          <ContactsEditor client={detail.data} />
        </>
      ) : null}
    </>
  );
}

export interface ClientDrawerProps {
  readonly open: boolean;
  /** The client to edit; `null` creates one. */
  readonly clientId: string | null;
  /** A name to start a new client with (the search typed in `ClientSelect`). */
  readonly initialName?: string;
  readonly onClose: () => void;
  /**
   * Called with a newly created client. Without it the drawer stays open on the new client, so contact persons can be
   * added (they need the client to exist first).
   */
  readonly onCreated?: (client: Client) => void;
}

/** Creates or edits a client; an existing client also gets its contact persons (D-121). */
export function ClientDrawer({
  open,
  clientId,
  initialName,
  onClose,
  onCreated,
}: ClientDrawerProps): React.JSX.Element {
  const { t } = useTranslation();
  // A client created here is edited here next (its contacts can then be added).
  const [createdId, setCreatedId] = useState<string | null>(null);
  const id = clientId ?? createdId;
  const detail = useClient(open ? id : null);
  const close = () => {
    setCreatedId(null);
    onClose();
  };
  const saved = (client: Client) => {
    if (id) close();
    else if (onCreated) onCreated(client);
    else setCreatedId(client.id);
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      title={id ? t('clients.drawer.editTitle') : t('clients.drawer.createTitle')}
      size="large"
      destroyOnHidden
      data-testid="client-drawer"
    >
      <DrawerBody
        id={id}
        detail={detail}
        initialName={initialName}
        onCancel={close}
        onSaved={saved}
      />
    </Drawer>
  );
}
