import { ApiError } from '@nexlegtiq/shared-api-client';
import { CreateCaseSchema } from '@nexlegtiq/shared-contracts';
import { FILE_TYPES, PRIORITIES } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, useApiErrorHandler, useCan } from '@nexlegtiq/shared-ui';
import { isolateLtr } from '@nexlegtiq/shared-utils';
import { App, Button, Flex, Form, Input, Modal, Select, Typography } from 'antd';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { BillingFields, CourtFields, PeopleFields } from './QuickCreateFields';
import { useSession } from '../../auth';
import { parseForm, zodRule } from '../../auth/forms';
import { ClientSelect } from '../../clients';
import { useCreateCase } from '../api/use-cases';
import { createBody, CREATE_FIELDS, defaultLawyer } from '../case-form';
import type { CreateValues } from '../case-form';
import { closeQuickCreateCase } from '../quick-create';

/** The API reports the client as `clientIds`/`primaryClientId`; the form has one `clientId` field. */
function onClientField(error: unknown): unknown {
  if (!(error instanceof ApiError) || !error.details) return error;
  const details = error.details.map((detail) =>
    detail.field === 'clientIds' || detail.field === 'primaryClientId'
      ? { ...detail, field: 'clientId' }
      : detail,
  );
  return { code: error.code, requestId: error.requestId, details };
}

/**
 * Quick-create case (D-123): the essentials first (title, client, type, priority, lawyer), then the optional court,
 * billing and description. "Create" stays where the user is; "Create & open" goes to the new file. Either way a toast
 * shows the generated number.
 */
export function QuickCreateCaseModal(): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<CreateValues>();
  const user = useSession((state) => state.user);
  const canBill = useCan('generate:invoice');
  const create = useCreateCase();
  // Which button submitted: read in onFinish, so a ref (no re-render needed).
  const openAfter = useRef(false);
  const shape = CreateCaseSchema.shape;
  const rules = (field: 'title' | 'fileType' | 'subType' | 'description') =>
    zodRule(shape[field], translateKey);

  const close = () => {
    // Closing mid-request would drop its callbacks: the case would exist without a toast or navigation.
    if (create.isPending) return;
    create.reset();
    closeQuickCreateCase();
  };

  const submit = (values: CreateValues) => {
    const body = parseForm(CreateCaseSchema, createBody(values), form, translateKey);
    if (!body) return;
    create.mutate(body, {
      onSuccess: (file) => {
        void message.success(t('cases.create.created', { number: isolateLtr(file.fileNumber) }));
        create.reset();
        closeQuickCreateCase();
        if (openAfter.current) void navigate(`/cases/${file.id}`);
      },
      onError: (error) => applyToForm(form, onClientField(error), [...CREATE_FIELDS]),
    });
  };
  const submitWith = (open: boolean) => () => {
    openAfter.current = open;
    form.submit();
  };

  return (
    <Modal
      open
      onCancel={close}
      title={t('cases.create.title')}
      width={640}
      keyboard={!create.isPending}
      closable={!create.isPending}
      mask={{ closable: !create.isPending }}
      data-testid="create-case-modal"
      footer={
        <Flex gap={8} justify="end" wrap>
          <Button onClick={close} disabled={create.isPending} data-testid="create-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            loading={create.isPending && !openAfter.current}
            disabled={create.isPending}
            onClick={submitWith(false)}
            data-testid="create-submit"
          >
            {t('cases.create.create')}
          </Button>
          <Button
            type="primary"
            loading={create.isPending && openAfter.current}
            disabled={create.isPending}
            onClick={submitWith(true)}
            data-testid="create-submit-open"
          >
            {t('cases.create.createAndOpen')}
          </Button>
        </Flex>
      }
    >
      <Flex vertical gap={12}>
        <Typography.Text type="secondary">
          {t('cases.create.shortcut', { keys: isolateLtr('Ctrl+Alt+N') })}
        </Typography.Text>
        <ApiErrorAlert error={create.error} fields={CREATE_FIELDS} testId="create-error" />
        <Form
          form={form}
          layout="vertical"
          noValidate
          requiredMark={false}
          initialValues={{ priority: 'MEDIUM', responsibleLawyerId: defaultLawyer(user) }}
          onFinish={submit}
          disabled={create.isPending}
        >
          <Form.Item name="title" label={t('cases.file.fields.title')} rules={rules('title')}>
            <Input dir="auto" autoFocus data-testid="create-title" />
          </Form.Item>
          <Form.Item
            name="clientId"
            label={t('cases.create.client')}
            rules={zodRule(shape.primaryClientId, translateKey)}
          >
            <ClientSelect data-testid="create-client" />
          </Form.Item>
          <Flex gap={12} wrap>
            <Form.Item
              name="fileType"
              label={t('cases.file.fields.fileType')}
              rules={rules('fileType')}
              style={{ flex: '1 1 200px' }}
            >
              <Select
                showSearch={{ optionFilterProp: 'label' }}
                options={FILE_TYPES.map((value) => ({
                  value,
                  label: t(`enums.fileType.${value}`),
                }))}
                data-testid="create-type"
              />
            </Form.Item>
            <Form.Item
              name="priority"
              label={t('cases.file.fields.priority')}
              style={{ flex: '1 1 160px' }}
            >
              <Select
                options={PRIORITIES.map((value) => ({
                  value,
                  label: t(`enums.priority.${value}`),
                }))}
                data-testid="create-priority"
              />
            </Form.Item>
          </Flex>
          <Form.Item name="subType" label={t('cases.file.fields.subType')} rules={rules('subType')}>
            <Input dir="auto" data-testid="create-subtype" />
          </Form.Item>
          <PeopleFields />
          <Typography.Text strong>{t('cases.create.more')}</Typography.Text>
          <CourtFields />
          {canBill ? <BillingFields /> : null}
          <Form.Item
            name="description"
            label={t('cases.file.fields.description')}
            rules={rules('description')}
          >
            <Input.TextArea
              dir="auto"
              autoSize={{ minRows: 2, maxRows: 8 }}
              data-testid="create-description"
            />
          </Form.Item>
        </Form>
      </Flex>
    </Modal>
  );
}
