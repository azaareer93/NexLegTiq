import { SESSION_TYPES } from '@nexlegtiq/shared-types';
import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { DatePicker, Flex, Form, Input, Select, TimePicker, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { REMINDER_DAY_OPTIONS } from './session-form';
import { useDirectory } from '../api/use-cases';
import { lawyersOf } from '../case-form';
import { CourtFields } from '../components/QuickCreateFields';

const TIME_FORMAT = 'HH:mm';

/**
 * The fields of a hearing (D-116, D-127): type, the date and times on the office's clock, court and judge (with inline
 * add), courtroom, the attending lawyer (who the API accepts: OM, SL, L) and reminder days (empty = the office's default).
 */
export function SessionFields({
  timeZone,
  initialCourt,
}: {
  readonly timeZone: string;
  /** An edited hearing's court, which a court search may not list. */
  readonly initialCourt?: { readonly value: string; readonly label: string };
}): React.JSX.Element {
  const { t } = useTranslation();
  const { translateKey } = useApiErrorHandler();
  const directory = useDirectory();
  const required = [{ required: true, message: translateKey('validation.required') }];
  return (
    <>
      <Form.Item name="sessionType" label={t('sessions.fields.type')}>
        <Select
          options={SESSION_TYPES.map((value) => ({
            value,
            label: t(`enums.sessionType.${value}`),
          }))}
          data-testid="session-type"
        />
      </Form.Item>
      <Form.Item name="date" label={t('sessions.fields.date')} rules={required}>
        <DatePicker format="DD/MM/YYYY" style={{ inlineSize: '100%' }} data-testid="session-date" />
      </Form.Item>
      <Flex gap={12}>
        <Form.Item name="startsAt" label={t('sessions.fields.start')} rules={required}>
          <TimePicker format={TIME_FORMAT} minuteStep={5} data-testid="session-start" />
        </Form.Item>
        <Form.Item name="endsAt" label={t('sessions.fields.end')}>
          <TimePicker format={TIME_FORMAT} minuteStep={5} data-testid="session-end" />
        </Form.Item>
      </Flex>
      <Typography.Text type="secondary" data-testid="session-time-zone">
        {t('sessions.timeZone', { zone: timeZone })}
      </Typography.Text>
      <CourtFields initialCourt={initialCourt} />
      <Form.Item name="courtRoom" label={t('sessions.fields.room')}>
        <Input dir="auto" maxLength={100} data-testid="session-room" />
      </Form.Item>
      <Form.Item name="attendingLawyerId" label={t('sessions.fields.lawyer')} rules={required}>
        <Select
          showSearch={{ optionFilterProp: 'label' }}
          loading={directory.isPending}
          options={lawyersOf(directory.data ?? []).map((person) => ({
            value: person.id,
            label: isolate(person.fullName),
          }))}
          data-testid="session-lawyer"
        />
      </Form.Item>
      <Form.Item name="reminderDays" label={t('sessions.fields.reminderDays')}>
        <Select
          mode="multiple"
          allowClear
          placeholder={t('sessions.fields.reminderDaysDefault')}
          options={REMINDER_DAY_OPTIONS.map((days) => ({ value: days, label: String(days) }))}
          data-testid="session-reminders"
        />
      </Form.Item>
    </>
  );
}
