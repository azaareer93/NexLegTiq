import type {
  CreateWitnessStatementRequest,
  UpdateWitnessStatementRequest,
  WitnessStatement,
} from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler, useFormat } from '@nexlegtiq/shared-ui';
import { Button, Card, Checkbox, DatePicker, Flex, Form, Input, Select } from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useStatementMutations } from './use-witnesses';
import { useFileSessions } from '../sessions/use-sessions';

interface Values {
  readonly statementDate: Dayjs | null;
  readonly text: string;
  readonly isUnderOath: boolean;
  readonly sessionId: string | undefined;
}

const FIELDS = ['statementDate', 'text', 'isUnderOath', 'sessionId'];

function initialValues(statement: WitnessStatement | null): Values {
  return {
    statementDate: statement ? dayjs(statement.statementDate) : dayjs(),
    text: statement?.text ?? '',
    isUnderOath: statement?.isUnderOath ?? false,
    sessionId: statement?.session?.id,
  };
}

function toBody(values: Values): CreateWitnessStatementRequest {
  return {
    statementDate: values.statementDate?.format('YYYY-MM-DD') ?? '',
    text: values.text.trim(),
    isUnderOath: values.isUnderOath,
    ...(values.sessionId && { sessionId: values.sessionId }),
  };
}

/** Only what differs from the stored statement; a hearing taken off is sent as null. */
export function statementChanges(
  body: CreateWitnessStatementRequest,
  statement: WitnessStatement,
): UpdateWitnessStatementRequest {
  const changed: UpdateWitnessStatementRequest = {};
  if (body.statementDate !== statement.statementDate) changed.statementDate = body.statementDate;
  if (body.text !== statement.text) changed.text = body.text;
  if (body.isUnderOath !== statement.isUnderOath) changed.isUnderOath = body.isUnderOath;
  const sessionId = body.sessionId ?? null;
  if (sessionId !== (statement.session?.id ?? null)) changed.sessionId = sessionId;
  return changed;
}

/** Add (statement null) or edit a statement: plain text, its date, oath and the hearing it was given at. */
export function StatementForm({
  fileId,
  witnessId,
  statement,
  onDone,
}: {
  readonly fileId: string;
  readonly witnessId: string;
  readonly statement: WitnessStatement | null;
  readonly onDone: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const { create, update } = useStatementMutations(fileId, witnessId);
  const { applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const [error, setError] = useState<unknown>(null);
  // Testimony is usually given at a hearing already held.
  const hearings = useFileSessions(fileId, { when: 'past', limit: 50 });
  const initial = initialValues(statement);

  const submit = async (values: Values) => {
    setError(null);
    const body = toBody(values);
    try {
      if (!statement) {
        await create.mutateAsync(body);
      } else {
        const changed = statementChanges(body, statement);
        if (Object.keys(changed).length > 0) {
          await update.mutateAsync({ id: statement.id, body: changed });
        }
      }
      onDone();
    } catch (failure) {
      if (!applyToForm(form, failure, FIELDS)) setError(failure);
    }
  };

  return (
    <Card size="small">
      <Form
        form={form}
        layout="vertical"
        noValidate
        initialValues={initial}
        onFinish={(values) => void submit(values)}
      >
        {error ? <ApiErrorAlert error={error} /> : null}
        <Form.Item
          name="statementDate"
          label={t('parties.statements.date')}
          rules={[{ required: true, message: t('validation.required') }]}
        >
          <DatePicker
            format="DD/MM/YYYY"
            allowClear={false}
            disabledDate={(day) => day.isAfter(dayjs(), 'day')}
            style={{ inlineSize: '100%' }}
            data-testid="statement-date"
          />
        </Form.Item>
        <Form.Item name="sessionId" label={t('parties.statements.hearing')}>
          <Select
            allowClear
            loading={hearings.isPending}
            placeholder={t('parties.statements.noHearing')}
            options={(hearings.data?.items ?? []).map((hearing) => ({
              value: hearing.id,
              label: format.dateTime(hearing.startsAt),
            }))}
            data-testid="statement-hearing"
          />
        </Form.Item>
        <Form.Item
          name="text"
          label={t('parties.statements.text')}
          rules={[{ required: true, whitespace: true, message: t('validation.required') }]}
        >
          <Input.TextArea rows={6} maxLength={20_000} data-testid="statement-text" />
        </Form.Item>
        <Form.Item name="isUnderOath" valuePropName="checked">
          <Checkbox data-testid="statement-oath">{t('parties.statements.underOath')}</Checkbox>
        </Form.Item>
        <Flex gap={8} justify="end">
          <Button onClick={onDone}>{t('common.actions.cancel')}</Button>
          <Button
            type="primary"
            htmlType="submit"
            loading={create.isPending || update.isPending}
            data-testid="statement-save"
          >
            {t('common.actions.save')}
          </Button>
        </Flex>
      </Form>
    </Card>
  );
}
