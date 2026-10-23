import { AddFilePartySchema } from '@nexlegtiq/shared-contracts';
import type { AddFilePartyResult } from '@nexlegtiq/shared-contracts';
import { PARTY_TYPES } from '@nexlegtiq/shared-types';
import type { PartyType } from '@nexlegtiq/shared-types';
import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { Flex, Form, Input, Modal, Segmented, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PartyFields } from './PartyFields';
import { useAddParty, usePartySearch } from './use-parties';
import { parseForm, zodRule } from '../../auth/forms';
import { useDebounced } from '../../clients/list-params';

type Mode = 'existing' | 'new';

export interface AddPartyValues {
  partyId?: string;
  party?: Record<string, unknown>;
  partyType: PartyType;
  roleLabel?: string;
}

/** Empty optional inputs are left out: the contract treats `''` as a value. */
const compact = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== ''),
  );

/** The request for what the form holds: an existing party or a new one, never both (`validation.partyChoice`). */
export function addRequest(mode: Mode, values: AddPartyValues): Record<string, unknown> {
  const base = compact({ partyType: values.partyType, roleLabel: values.roleLabel?.trim() });
  return mode === 'existing'
    ? { ...base, partyId: values.partyId }
    : { ...base, party: compact({ isIndividual: true, ...values.party }) };
}

function PartyPicker(): React.JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const search = useDebounced(text.trim());
  const found = usePartySearch(search);
  return (
    <Form.Item
      name="partyId"
      label={t('parties.add.pick')}
      rules={[{ required: true, message: t('validation.required') }]}
    >
      <Select<string>
        placeholder={t('parties.add.search')}
        showSearch={{ filterOption: false, searchValue: text, onSearch: setText }}
        loading={found.isFetching}
        notFoundContent={search && !found.isFetching ? t('parties.add.noMatch') : null}
        options={(found.data ?? []).map((party) => ({ value: party.id, label: party.name }))}
        data-testid="party-picker"
      />
    </Form.Item>
  );
}

/** Adds an existing registry party (search and reuse) or a new one to the file, in a role (D-135). */
export function AddPartyModal({
  open,
  fileId,
  onClose,
  onAdded,
}: {
  readonly open: boolean;
  readonly fileId: string;
  readonly onClose: () => void;
  readonly onAdded: (result: AddFilePartyResult) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [form] = Form.useForm<AddPartyValues>();
  const [mode, setMode] = useState<Mode>('existing');
  const { applyToForm, notify } = useApiErrorHandler();
  const add = useAddParty(fileId);
  const message = (key: string) => t(key as never);

  const submit = async () => {
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const body = parseForm(AddFilePartySchema, addRequest(mode, values), form, message);
    if (!body) return;
    try {
      onAdded(await add.mutateAsync(body));
    } catch (error) {
      if (!applyToForm(form, error, ['partyId', 'partyType', 'roleLabel'])) notify(error);
    }
  };

  return (
    <Modal
      open={open}
      title={t('parties.add.title')}
      okText={t('parties.add.submit')}
      cancelText={t('common.actions.cancel')}
      confirmLoading={add.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
      data-testid="add-party-modal"
    >
      <Flex vertical gap={16}>
        <Segmented<Mode>
          block
          value={mode}
          onChange={setMode}
          options={[
            { value: 'existing', label: t('parties.add.existing') },
            { value: 'new', label: t('parties.add.new') },
          ]}
          data-testid="add-party-mode"
        />
        <Form
          form={form}
          layout="vertical"
          noValidate
          preserve={false}
          initialValues={{ partyType: 'DEFENDANT' }}
        >
          {mode === 'existing' ? <PartyPicker /> : <PartyFields />}
          <Form.Item name="partyType" label={t('parties.add.partyType')}>
            <Select
              options={PARTY_TYPES.map((type) => ({
                value: type,
                label: t(`enums.partyType.${type}`),
              }))}
              data-testid="party-type"
            />
          </Form.Item>
          <Form.Item
            name="roleLabel"
            label={t('parties.add.roleLabel')}
            rules={zodRule(AddFilePartySchema.shape.roleLabel, message)}
          >
            <Input maxLength={100} data-testid="party-role-label" />
          </Form.Item>
        </Form>
      </Flex>
    </Modal>
  );
}
