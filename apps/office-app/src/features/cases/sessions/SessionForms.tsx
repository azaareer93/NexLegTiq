import type { Case, Session } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, ConfirmModal, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button, Flex, Form, Input } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConflictAlert } from './ConflictAlert';
import { changesOf, conflictsOf, createBody, formValuesOf } from './session-form';
import type { SessionFormValues } from './session-form';
import { SessionFields } from './SessionFields';
import { useCourtName } from './SessionSummary';
import {
  useCancelSession,
  useCreateSession,
  useOfficeTimeZone,
  useUpdateSession,
} from './use-sessions';
import { useSession } from '../../auth';

/** Form fields that the API's VAL-001 details can name. */
const FIELDS = [
  'sessionType',
  'startsAt',
  'endsAt',
  'courtId',
  'judgeId',
  'courtRoom',
  'attendingLawyerId',
  'reminderDays',
];

/** Roles the API accepts as attending lawyer (D-116): the caller by default when they are one, else the file's lawyer. */
const ATTENDING_ROLES = new Set(['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER']);

function Actions({
  pending,
  submitText,
  children,
}: {
  readonly pending: boolean;
  readonly submitText: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <Flex gap={8} justify="space-between" wrap>
      <span>{children}</span>
      <Button type="primary" htmlType="submit" loading={pending} data-testid="session-save">
        {submitText}
      </Button>
    </Flex>
  );
}

/** Schedules a hearing on the file; a 409 BIZ-004 offers "schedule anyway". */
export function CreateSessionForm({
  file,
  onDone,
}: {
  readonly file: Case;
  readonly onDone: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { applyToForm } = useApiErrorHandler();
  const timeZone = useOfficeTimeZone();
  const user = useSession((state) => state.user);
  const [form] = Form.useForm<SessionFormValues>();
  const create = useCreateSession(file.id);
  const conflicts = conflictsOf(create.error);
  const lawyer = user && ATTENDING_ROLES.has(user.role) ? user.id : file.responsibleLawyer.id;

  const send = (values: SessionFormValues, acknowledgeConflict = false) =>
    create.mutate(
      { ...createBody(values, file.id, timeZone), acknowledgeConflict },
      {
        onSuccess: () => {
          void message.success(t('sessions.scheduled'));
          onDone();
        },
        onError: (error) => applyToForm(form, error, FIELDS),
      },
    );

  return (
    <Form<SessionFormValues>
      form={form}
      layout="vertical"
      noValidate
      requiredMark={false}
      initialValues={{ sessionType: 'HEARING', attendingLawyerId: lawyer }}
      onFinish={(values) => send(values)}
      // A changed form makes an earlier conflict or error stale: clear it before "schedule anyway" can resend.
      onValuesChange={() => create.reset()}
      disabled={create.isPending}
      data-testid="session-create-form"
    >
      {conflicts ? (
        <ConflictAlert
          conflicts={conflicts}
          onConfirm={() => void form.validateFields().then((values) => send(values, true))}
        />
      ) : (
        <ApiErrorAlert error={create.error} fields={FIELDS} testId="session-error" />
      )}
      <SessionFields timeZone={timeZone} />
      <Actions pending={create.isPending} submitText={t('sessions.drawer.schedule')} />
    </Form>
  );
}

/** Changes a scheduled hearing (only what changed is sent) or cancels it after a confirmation. */
export function EditSessionForm({
  session,
  onDone,
}: {
  readonly session: Session;
  readonly onDone: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { applyToForm, notify } = useApiErrorHandler();
  const timeZone = useOfficeTimeZone();
  const [form] = Form.useForm<SessionFormValues>();
  const update = useUpdateSession(session.id, session.file.id);
  const cancel = useCancelSession(session.id, session.file.id);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const conflicts = conflictsOf(update.error);
  const courtName = useCourtName()(session.court);
  const initialCourt =
    session.court && courtName ? { value: session.court.id, label: courtName } : undefined;

  const send = (values: SessionFormValues, acknowledgeConflict = false) => {
    const changes = changesOf(session, values, timeZone);
    if (Object.keys(changes).length === 0) {
      onDone();
      return;
    }
    update.mutate(
      { ...changes, acknowledgeConflict },
      {
        onSuccess: () => {
          void message.success(t('common.feedback.saved'));
          onDone();
        },
        onError: (error) => applyToForm(form, error, FIELDS),
      },
    );
  };

  const confirmCancel = () =>
    cancel.mutate(reason.trim() ? { reason: reason.trim() } : {}, {
      onSuccess: () => {
        setConfirming(false);
        void message.success(t('sessions.cancelled'));
        onDone();
      },
      onError: (error) => {
        setConfirming(false);
        notify(error);
      },
    });

  return (
    <Form<SessionFormValues>
      form={form}
      layout="vertical"
      noValidate
      requiredMark={false}
      initialValues={formValuesOf(session, timeZone)}
      onFinish={(values) => send(values)}
      onValuesChange={() => update.reset()}
      disabled={update.isPending}
      data-testid="session-edit-form"
    >
      {conflicts ? (
        <ConflictAlert
          conflicts={conflicts}
          onConfirm={() => void form.validateFields().then((values) => send(values, true))}
        />
      ) : (
        <ApiErrorAlert error={update.error} fields={FIELDS} testId="session-error" />
      )}
      <SessionFields timeZone={timeZone} initialCourt={initialCourt} editing />
      <Actions pending={update.isPending} submitText={t('sessions.drawer.save')}>
        <Button danger onClick={() => setConfirming(true)} data-testid="session-cancel">
          {t('sessions.cancel.action')}
        </Button>
      </Actions>
      <ConfirmModal
        open={confirming}
        danger
        loading={cancel.isPending}
        title={t('sessions.cancel.title')}
        confirmText={t('sessions.cancel.confirm')}
        onConfirm={confirmCancel}
        onCancel={() => setConfirming(false)}
      >
        <Flex vertical gap={8}>
          {t('sessions.cancel.body')}
          <Input
            dir="auto"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('sessions.cancel.reason')}
            aria-label={t('sessions.cancel.reason')}
            data-testid="session-cancel-reason"
          />
        </Flex>
      </ConfirmModal>
    </Form>
  );
}
