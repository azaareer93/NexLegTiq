import { RobotOutlined } from '@ant-design/icons';
import type { Session } from '@nexlegtiq/shared-contracts';
import { SESSION_OUTCOMES } from '@nexlegtiq/shared-types';
import type { SessionOutcome } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { zonedDateTime } from '@nexlegtiq/shared-utils';
import {
  App,
  Button,
  Checkbox,
  DatePicker,
  Divider,
  Flex,
  Form,
  Input,
  Select,
  TimePicker,
  Tooltip,
  Typography,
} from 'antd';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

import { ConflictAlert } from './ConflictAlert';
import { conflictsOf } from './session-form';
import { useRecordOutcome } from './use-sessions';

interface OutcomeValues {
  outcome?: SessionOutcome;
  minutes?: string;
  scheduleNext?: boolean;
  nextDate?: Dayjs | null;
  nextStart?: Dayjs | null;
}

const FIELDS = ['outcome', 'minutes'];

/**
 * Outcome and minutes of a hearing that has started (D-116): may be recorded again to correct them; "schedule the next
 * hearing" adjourns to a new one with the same court, room and lawyer (once). The AI summary waits for the AI features.
 */
export function OutcomeSection({
  session,
  timeZone,
  canScheduleNext,
}: {
  readonly session: Session;
  readonly timeZone: string;
  /** Scheduling the next hearing also needs `create:session` (D-116). */
  readonly canScheduleNext: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<OutcomeValues>();
  const record = useRecordOutcome(session.id, session.file.id);
  const scheduleNext = Form.useWatch('scheduleNext', form);
  const required = [{ required: true, message: translateKey('validation.required') }];
  const conflicts = conflictsOf(record.error);

  const submit = (values: OutcomeValues, acknowledgeConflict = false) => {
    const next =
      values.scheduleNext && values.nextDate && values.nextStart
        ? {
            nextSession: {
              startsAt: zonedDateTime(
                values.nextDate.format('YYYY-MM-DD'),
                values.nextStart.format('HH:mm'),
                timeZone,
              ),
              acknowledgeConflict,
            },
          }
        : {};
    const minutes = values.minutes?.trim();
    record.mutate(
      { outcome: values.outcome as SessionOutcome, ...(minutes ? { minutes } : {}), ...next },
      {
        onSuccess: () => void message.success(t('common.feedback.saved')),
        onError: (error) => applyToForm(form, error, FIELDS),
      },
    );
  };

  return (
    <section data-testid="session-outcome">
      <Divider />
      <Typography.Text strong>{t('sessions.outcome.title')}</Typography.Text>
      <Form<OutcomeValues>
        form={form}
        layout="vertical"
        noValidate
        requiredMark={false}
        initialValues={{
          outcome: session.outcome ?? undefined,
          minutes: session.minutes ?? '',
          scheduleNext: false,
        }}
        onFinish={(values) => submit(values)}
        onValuesChange={() => record.reset()}
        disabled={record.isPending}
      >
        {conflicts ? (
          <ConflictAlert
            conflicts={conflicts}
            onConfirm={() => void form.validateFields().then((values) => submit(values, true))}
          />
        ) : (
          <ApiErrorAlert error={record.error} fields={FIELDS} testId="session-outcome-error" />
        )}
        <Form.Item name="outcome" label={t('sessions.fields.outcome')} rules={required}>
          <Select
            options={SESSION_OUTCOMES.map((value) => ({
              value,
              label: t(`enums.sessionOutcome.${value}`),
            }))}
            data-testid="session-outcome-select"
          />
        </Form.Item>
        <Form.Item name="minutes" label={t('sessions.fields.minutes')}>
          <Input.TextArea dir="auto" rows={5} maxLength={20_000} data-testid="session-minutes" />
        </Form.Item>
        {session.nextSessionId || !canScheduleNext ? null : (
          <Form.Item name="scheduleNext" valuePropName="checked">
            <Checkbox data-testid="session-schedule-next">
              {t('sessions.fields.scheduleNext')}
            </Checkbox>
          </Form.Item>
        )}
        {scheduleNext ? (
          <Flex gap={12} wrap>
            <Form.Item name="nextDate" label={t('sessions.fields.nextDate')} rules={required}>
              <DatePicker format="DD/MM/YYYY" data-testid="session-next-date" />
            </Form.Item>
            <Form.Item name="nextStart" label={t('sessions.fields.nextStart')} rules={required}>
              <TimePicker format="HH:mm" minuteStep={5} data-testid="session-next-start" />
            </Form.Item>
          </Flex>
        ) : null}
        <Flex gap={8} justify="space-between" wrap>
          <Tooltip title={t('sessions.outcome.aiSoon')}>
            <Button icon={<RobotOutlined />} disabled data-testid="session-ai-summary">
              {t('sessions.outcome.aiSummary')}
            </Button>
          </Tooltip>
          <Button
            type="primary"
            htmlType="submit"
            loading={record.isPending}
            data-testid="session-outcome-save"
          >
            {t('sessions.outcome.save')}
          </Button>
        </Flex>
      </Form>
    </section>
  );
}
