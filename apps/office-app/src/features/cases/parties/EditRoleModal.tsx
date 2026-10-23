import { UpdateFilePartySchema } from '@nexlegtiq/shared-contracts';
import type { AddFilePartyResult, FileParty } from '@nexlegtiq/shared-contracts';
import { PARTY_TYPES } from '@nexlegtiq/shared-types';
import type { PartyType } from '@nexlegtiq/shared-types';
import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Form, Input, Modal, Select } from 'antd';
import { useTranslation } from 'react-i18next';

import { useUpdateParty } from './use-parties';
import { zodRule } from '../../auth/forms';

/** Only what changed; a cleared description is `null`. */
export function roleChanges(
  row: FileParty,
  values: { partyType: PartyType; roleLabel?: string },
): { partyType?: PartyType; roleLabel?: string | null } {
  const roleLabel = values.roleLabel?.trim() || null;
  return {
    ...(values.partyType !== row.partyType && { partyType: values.partyType }),
    ...(roleLabel !== row.roleLabel && { roleLabel }),
  };
}

/** Change a party's role on this file; a retype may raise or clear conflicts (D-135). */
export function EditRoleModal({
  fileId,
  row,
  onClose,
  onConflicts,
}: {
  readonly fileId: string;
  readonly row: FileParty | null;
  readonly onClose: () => void;
  readonly onConflicts: (result: AddFilePartyResult) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { applyToForm, notify } = useApiErrorHandler();
  const [form] = Form.useForm<{ partyType: PartyType; roleLabel?: string }>();
  const update = useUpdateParty(fileId);
  const submit = async () => {
    if (!row) return;
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    const body = roleChanges(row, values);
    if (Object.keys(body).length === 0) return onClose();
    try {
      const result = await update.mutateAsync({ id: row.id, body });
      void message.success(t('parties.edit.saved'));
      onClose();
      // Only a new role can raise conflicts; a label edit would just repeat the known ones.
      if (body.partyType) onConflicts(result);
    } catch (error) {
      if (!applyToForm(form, error, ['partyType', 'roleLabel'])) notify(error);
    }
  };
  return (
    <Modal
      open={row !== null}
      title={t('parties.edit.title')}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      confirmLoading={update.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnHidden
      data-testid="edit-party-modal"
    >
      <Form
        key={row?.id}
        form={form}
        layout="vertical"
        noValidate
        preserve={false}
        initialValues={{ partyType: row?.partyType, roleLabel: row?.roleLabel ?? '' }}
      >
        <Form.Item name="partyType" label={t('parties.add.partyType')}>
          <Select
            options={PARTY_TYPES.map((type) => ({
              value: type,
              label: t(`enums.partyType.${type}`),
            }))}
            data-testid="edit-party-type"
          />
        </Form.Item>
        <Form.Item
          name="roleLabel"
          label={t('parties.add.roleLabel')}
          rules={zodRule(UpdateFilePartySchema.shape.roleLabel, (key) => t(key as never))}
        >
          <Input maxLength={100} data-testid="edit-party-role-label" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
