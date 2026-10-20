import type { TeamMember } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';
import {
  ApiErrorAlert,
  Bdi,
  isApiError,
  Ltr,
  LoadingSkeleton,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { isolate, isolateLtr } from '@nexlegtiq/shared-utils';
import { Alert, App, Form, Modal, Select, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useDeactivate, useOpenFiles } from '../api/use-team';

/** Who may be a file's responsible lawyer (the API's rule, D-096). */
const LAWYER_ROLES: ReadonlySet<Role> = new Set(['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER']);

export interface DeactivateModalProps {
  readonly member: TeamMember;
  readonly team: readonly TeamMember[];
  readonly onClose: () => void;
}

/**
 * The deactivate wizard (W5, D-124): every open file the user is responsible for gets a new lawyer — one by one or all at
 * once — before the account is deactivated; the server refuses anything less.
 */
export function DeactivateModal({
  member,
  team,
  onClose,
}: DeactivateModalProps): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey } = useApiErrorHandler();
  const [form] = Form.useForm<Record<string, string | undefined>>();
  const files = useOpenFiles(member.id);
  const deactivate = useDeactivate();
  const name = isolate(member.fullName);
  const lawyers = team
    .filter((m) => m.isActive && m.id !== member.id && LAWYER_ROLES.has(m.role))
    .map((m) => ({ value: m.id, label: isolate(m.fullName) }));
  const list = files.data ?? [];

  const giveAll = (lawyerId: string) =>
    form.setFieldsValue(Object.fromEntries(list.map((file) => [file.id, lawyerId])));

  /** VAL-001 on `reassignments.<i>.newResponsibleLawyerId` goes on that file's picker. */
  const showOnPickers = (error: unknown) => {
    if (!isApiError(error)) return;
    form.setFields(
      (error.details ?? []).flatMap((detail) => {
        const file = list[Number(/^reassignments\.(\d+)\./.exec(detail.field ?? '')?.[1])];
        return file ? [{ name: file.id, errors: [translateKey(detail.message)] }] : [];
      }),
    );
  };
  const submit = (values: Record<string, string | undefined>) => {
    const reassignments = list.map((file) => ({
      fileId: file.id,
      newResponsibleLawyerId: values[file.id] ?? '',
    }));
    deactivate.mutate(
      { id: member.id, body: { reassignments } },
      {
        onSuccess: () => {
          void message.success(t('team.deactivate.done', { name }));
          onClose();
        },
        // The files may have changed meanwhile (VAL-001 on reassignments): show the current list.
        onError: (error) => {
          showOnPickers(error);
          void files.refetch();
        },
      },
    );
  };

  return (
    <Modal
      open
      title={t('team.deactivate.title', { name })}
      onCancel={deactivate.isPending ? undefined : onClose}
      okText={t('team.deactivate.confirm')}
      okButtonProps={{
        danger: true,
        loading: deactivate.isPending,
        disabled: !files.isSuccess,
        'data-testid': 'deactivate-confirm',
      }}
      cancelButtonProps={{ disabled: deactivate.isPending }}
      onOk={() => form.submit()}
      data-testid="deactivate-modal"
    >
      {files.isPending ? <LoadingSkeleton rows={3} /> : null}
      <DeactivateError error={files.error ?? deactivate.error} files={list.length} />
      {files.isSuccess ? (
        <>
          <Typography.Paragraph>
            {t(list.length > 0 ? 'team.deactivate.intro' : 'team.deactivate.noFiles', { name })}
          </Typography.Paragraph>
          <Form form={form} layout="vertical" noValidate requiredMark={false} onFinish={submit}>
            {list.length > 1 ? (
              <Form.Item label={t('team.deactivate.applyAll')}>
                <Select
                  aria-label={t('team.deactivate.applyAll')}
                  options={lawyers}
                  onChange={giveAll}
                  placeholder={t('team.deactivate.pickLawyer')}
                  showSearch={{ optionFilterProp: 'label' }}
                  data-testid="deactivate-all"
                />
              </Form.Item>
            ) : null}
            {list.map((file) => (
              <Form.Item
                key={file.id}
                name={file.id}
                label={
                  <span>
                    <Ltr>{file.fileNumber}</Ltr> · <Bdi>{file.title}</Bdi>
                  </span>
                }
                rules={[{ required: true, message: translateKey('validation.responsibleLawyer') }]}
              >
                <Select
                  aria-label={t('team.deactivate.newLawyer', { file: isolateLtr(file.fileNumber) })}
                  options={lawyers}
                  placeholder={t('team.deactivate.pickLawyer')}
                  showSearch={{ optionFilterProp: 'label' }}
                  data-testid={`deactivate-file-${file.id}`}
                />
              </Form.Item>
            ))}
          </Form>
        </>
      ) : null}
    </Modal>
  );
}

/**
 * A rule about the whole list (`validation.reassignAllFiles`) is said in words, not as the generic VAL-001; errors on a
 * file's picker are shown on the picker.
 */
function DeactivateError({ error, files }: { error: unknown; files: number }): React.JSX.Element {
  const { translateKey } = useApiErrorHandler();
  const listError = isApiError(error)
    ? error.details?.find((detail) => detail.field === 'reassignments')
    : undefined;
  if (listError) {
    return (
      <Alert
        type="error"
        showIcon
        title={translateKey(listError.message)}
        data-testid="deactivate-error"
      />
    );
  }
  const pickers = Array.from(
    { length: files },
    (_, index) => `reassignments.${index}.newResponsibleLawyerId`,
  );
  return <ApiErrorAlert error={error} fields={pickers} testId="deactivate-error" />;
}
