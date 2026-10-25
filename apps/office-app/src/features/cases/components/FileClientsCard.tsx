import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { Case } from '@nexlegtiq/shared-contracts';
import { Bdi, ConfirmModal, useApiErrorHandler, useCan } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, Card, Checkbox, Flex, Form, List, Modal, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ClientSelect } from '../../clients';
import { useFileClientMutations } from '../api/use-cases';

function AddClientModal({
  fileId,
  onClose,
}: {
  readonly fileId: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const errors = useApiErrorHandler();
  const [form] = Form.useForm<{ clientId: string; isPrimary: boolean }>();
  const { addClient } = useFileClientMutations(fileId);
  const submit = async () => {
    const values = await form.validateFields();
    try {
      await addClient.mutateAsync({ clientId: values.clientId, isPrimary: values.isPrimary });
      void message.success(t('common.feedback.saved'));
      onClose();
    } catch (error) {
      if (!errors.applyToForm(form, error, ['clientId'])) errors.notify(error);
    }
  };
  return (
    <Modal
      open
      title={t('cases.file.people.addClientTitle')}
      okText={t('cases.file.people.add')}
      onOk={() => void submit()}
      onCancel={onClose}
      confirmLoading={addClient.isPending}
      okButtonProps={{ 'data-testid': 'add-client-submit' }}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" noValidate initialValues={{ isPrimary: false }}>
        <Form.Item
          name="clientId"
          label={t('cases.file.people.client')}
          rules={[{ required: true, message: t('validation.required') }]}
        >
          <ClientSelect data-testid="add-client-select" />
        </Form.Item>
        <Form.Item name="isPrimary" valuePropName="checked">
          <Checkbox data-testid="add-client-primary">
            {t('cases.file.people.makePrimaryOnAdd')}
          </Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** The file's clients, primary first; add, make primary and remove with edit rights (the last one stays, BIZ-018). */
export function ClientsCard({
  file,
  canEdit,
}: {
  readonly file: Case;
  readonly canEdit: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const errors = useApiErrorHandler();
  // The client picker searches `GET /clients` (D-121).
  const canPick = useCan('manage:clients');
  const { makePrimary, removeClient } = useFileClientMutations(file.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Case['clients'][number] | null>(null);
  const remove = async () => {
    if (!removing) return;
    try {
      await removeClient.mutateAsync(removing.id);
      setRemoving(null);
    } catch (error) {
      setRemoving(null);
      errors.notify(error);
    }
  };
  return (
    <Card
      title={t('cases.file.cards.clients')}
      data-testid="case-card-clients"
      extra={
        canEdit && canPick ? (
          <Button
            size="small"
            icon={<PlusOutlined aria-hidden />}
            onClick={() => setAdding(true)}
            data-testid="add-client"
          >
            {t('cases.file.people.addClient')}
          </Button>
        ) : null
      }
    >
      <List
        size="small"
        dataSource={file.clients}
        locale={{ emptyText: t('cases.file.noClients') }}
        renderItem={(client) => (
          <List.Item
            data-testid={`file-client-${client.id}`}
            actions={
              canEdit
                ? [
                    ...(client.isPrimary
                      ? []
                      : [
                          <Button
                            key="primary"
                            type="link"
                            size="small"
                            loading={makePrimary.isPending && makePrimary.variables === client.id}
                            aria-label={t('cases.file.people.makePrimaryLabel', {
                              name: isolate(client.displayName),
                            })}
                            onClick={() =>
                              makePrimary.mutate(client.id, {
                                onError: (error) => errors.notify(error),
                              })
                            }
                            data-testid={`make-primary-${client.id}`}
                          >
                            {t('cases.file.people.makePrimary')}
                          </Button>,
                        ]),
                    ...(file.clients.length > 1
                      ? [
                          <Button
                            key="remove"
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined aria-hidden />}
                            aria-label={t('cases.file.people.removeClient', {
                              name: isolate(client.displayName),
                            })}
                            onClick={() => setRemoving(client)}
                            data-testid={`remove-client-${client.id}`}
                          />,
                        ]
                      : []),
                  ]
                : []
            }
          >
            <Flex gap={8} align="center" wrap>
              <Bdi>{client.displayName}</Bdi>
              <Typography.Text type="secondary">
                {t(`enums.clientType.${client.clientType}`)}
              </Typography.Text>
              {client.isPrimary ? <Tag color="blue">{t('cases.file.primaryClient')}</Tag> : null}
            </Flex>
          </List.Item>
        )}
      />
      {adding ? <AddClientModal fileId={file.id} onClose={() => setAdding(false)} /> : null}
      <ConfirmModal
        open={removing !== null}
        danger
        title={t('cases.file.people.removeClientTitle')}
        confirmText={t('cases.file.people.remove')}
        loading={removeClient.isPending}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      >
        {removing
          ? t('cases.file.people.removeClientBody', { name: isolate(removing.displayName) })
          : null}
      </ConfirmModal>
    </Card>
  );
}
