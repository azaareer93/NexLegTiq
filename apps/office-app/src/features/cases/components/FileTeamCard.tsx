import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { Case, FileTeamMember } from '@nexlegtiq/shared-contracts';
import type { FileTeamRole, Role } from '@nexlegtiq/shared-types';
import { Bdi, ConfirmModal, useApiErrorHandler, useCan } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, Card, Flex, Form, List, Modal, Select, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDirectory, useFileParticipants } from '../api/use-cases';
import type { FileActions } from '../file-page';

const LAWYER_ROLES: readonly Role[] = ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER'];

/** The file roles a colleague's office role may hold (D-096, D-140); RESPONSIBLE_LAWYER also needs `reassign`. */
function eligibleRoles(role: Role | undefined, reassign: boolean): FileTeamRole[] {
  return [
    'MEMBER',
    ...(role === 'PARALEGAL' ? (['PARALEGAL'] as const) : []),
    ...(reassign && role && LAWYER_ROLES.includes(role) ? (['RESPONSIBLE_LAWYER'] as const) : []),
  ];
}

function AddMemberModal({
  file,
  reassign,
  onClose,
}: {
  readonly file: Case;
  readonly reassign: boolean;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const errors = useApiErrorHandler();
  const [form] = Form.useForm<{ userId: string; role: FileTeamRole }>();
  const directory = useDirectory();
  const { addMember } = useFileParticipants(file.id);
  const userId = Form.useWatch('userId', form);
  const onTeam = new Set(file.team.map((member) => member.id));
  const people = (directory.data ?? []).filter((person) => !onTeam.has(person.id));
  const picked = people.find((person) => person.id === userId);
  const roles = eligibleRoles(picked?.role, reassign);
  const submit = async () => {
    const values = await form.validateFields();
    try {
      await addMember.mutateAsync(values);
      void message.success(t('common.feedback.saved'));
      onClose();
    } catch (error) {
      if (!errors.applyToForm(form, error, ['userId', 'role'])) errors.notify(error);
    }
  };
  return (
    <Modal
      open
      title={t('cases.file.people.addMemberTitle')}
      okText={t('cases.file.people.add')}
      onOk={() => void submit()}
      onCancel={onClose}
      confirmLoading={addMember.isPending}
      okButtonProps={{ 'data-testid': 'add-member-submit' }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" noValidate initialValues={{ role: 'MEMBER' }}>
        <Form.Item
          name="userId"
          label={t('cases.file.people.member')}
          rules={[{ required: true, message: t('validation.required') }]}
        >
          <Select
            showSearch
            optionFilterProp="label"
            loading={directory.isLoading}
            options={people.map((person) => ({
              value: person.id,
              label: t('cases.file.people.personOption', {
                name: isolate(person.fullName),
                role: t(`enums.role.${person.role}`),
              }),
            }))}
            // A new pick may not hold the chosen role: back to MEMBER.
            onChange={() => form.setFieldValue('role', 'MEMBER')}
            data-testid="add-member-select"
          />
        </Form.Item>
        <Form.Item
          name="role"
          label={t('cases.file.people.role')}
          extra={roles.includes('RESPONSIBLE_LAWYER') ? t('cases.file.people.reassignHint') : null}
        >
          <Select
            options={roles.map((role) => ({ value: role, label: t(`enums.fileTeamRole.${role}`) }))}
            data-testid="add-member-role"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/**
 * The file's team. With edit rights: add colleagues (on a confidential file only the office manager or the responsible
 * lawyer, D-096), change roles and remove — the responsible lawyer stays until another is named (BIZ-019), and naming
 * one is a reassignment (`edit:any:case`, D-118).
 */
export function TeamCard({
  file,
  actions,
}: {
  readonly file: Case;
  readonly actions: Pick<FileActions, 'edit' | 'reassign' | 'confidentiality'>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const errors = useApiErrorHandler();
  // The people picker reads the directory (D-123), open to the roles whose forms pick people.
  const canPick = [
    useCan('create:case'),
    useCan('create:task'),
    useCan('assign:task'),
    useCan('create:session'),
  ].some(Boolean);
  const directory = useDirectory(actions.edit && canPick);
  const { changeRole, removeMember } = useFileParticipants(file.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<FileTeamMember | null>(null);
  const canAdd = actions.edit && canPick && (!file.isConfidential || actions.confidentiality);
  const officeRole = (id: string) => directory.data?.find((person) => person.id === id)?.role;
  const remove = async () => {
    if (!removing) return;
    try {
      await removeMember.mutateAsync(removing.id);
      setRemoving(null);
    } catch (error) {
      setRemoving(null);
      errors.notify(error);
    }
  };
  const roleOf = (member: FileTeamMember) => {
    const label = t(`enums.fileTeamRole.${member.role}`);
    if (!actions.edit || member.role === 'RESPONSIBLE_LAWYER') {
      return <Typography.Text type="secondary">{label}</Typography.Text>;
    }
    const roles = eligibleRoles(officeRole(member.id), actions.reassign);
    return (
      <Select
        size="small"
        value={member.role}
        aria-label={t('cases.file.people.roleOf', { name: isolate(member.fullName) })}
        options={[...new Set<FileTeamRole>([member.role, ...roles])].map((role) => ({
          value: role,
          label: t(`enums.fileTeamRole.${role}`),
        }))}
        disabled={changeRole.isPending}
        onChange={(role: FileTeamRole) =>
          changeRole.mutate(
            { userId: member.id, role },
            { onError: (error) => errors.notify(error) },
          )
        }
        data-testid={`member-role-${member.id}`}
      />
    );
  };
  return (
    <Card
      title={t('cases.file.cards.team')}
      data-testid="case-card-team"
      extra={
        canAdd ? (
          <Button
            size="small"
            icon={<PlusOutlined aria-hidden />}
            onClick={() => setAdding(true)}
            data-testid="add-member"
          >
            {t('cases.file.people.addMember')}
          </Button>
        ) : null
      }
    >
      <List
        size="small"
        dataSource={file.team}
        locale={{ emptyText: t('cases.file.noTeam') }}
        renderItem={(member) => (
          <List.Item
            data-testid={`file-member-${member.id}`}
            actions={
              actions.edit && member.role !== 'RESPONSIBLE_LAWYER'
                ? [
                    <Button
                      key="remove"
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined aria-hidden />}
                      aria-label={t('cases.file.people.removeMember', {
                        name: isolate(member.fullName),
                      })}
                      onClick={() => setRemoving(member)}
                      data-testid={`remove-member-${member.id}`}
                    />,
                  ]
                : []
            }
          >
            <Flex gap={8} align="center" wrap>
              <Bdi>{member.fullName}</Bdi>
              {roleOf(member)}
            </Flex>
          </List.Item>
        )}
      />
      {adding ? (
        <AddMemberModal file={file} reassign={actions.reassign} onClose={() => setAdding(false)} />
      ) : null}
      <ConfirmModal
        open={removing !== null}
        danger
        title={t('cases.file.people.removeMemberTitle')}
        confirmText={t('cases.file.people.remove')}
        loading={removeMember.isPending}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      >
        {removing
          ? t('cases.file.people.removeMemberBody', { name: isolate(removing.fullName) })
          : null}
      </ConfirmModal>
    </Card>
  );
}
