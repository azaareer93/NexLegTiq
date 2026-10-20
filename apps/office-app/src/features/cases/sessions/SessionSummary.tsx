import type { Session, SessionListItem } from '@nexlegtiq/shared-contracts';
import { Bdi, StatusTag, useFormat } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Descriptions, Flex, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

const STATUS_TONE = { SCHEDULED: 'info', COMPLETED: 'success', CANCELLED: 'neutral' } as const;
const REMINDER_COLOR = {
  PENDING: 'default',
  SENT: 'success',
  FAILED: 'error',
  CANCELLED: 'default',
} as const;

/** The court's name in the reader's language (Arabic as a fallback). */
export function useCourtName(): (court: SessionListItem['court']) => string | null {
  const { i18n } = useTranslation();
  return (court) =>
    court ? (i18n.language === 'ar' ? court.nameAr : (court.nameEn ?? court.nameAr)) : null;
}

export function SessionStatusTag({
  status,
}: {
  readonly status: SessionListItem['status'];
}): React.JSX.Element {
  const { t } = useTranslation();
  return <StatusTag tone={STATUS_TONE[status]}>{t(`enums.sessionStatus.${status}`)}</StatusTag>;
}

/** What is known about a hearing, its outcome and its reminders with their status (D-117). */
export function SessionSummary({ session }: { readonly session: Session }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const courtName = useCourtName();
  const court = courtName(session.court);
  return (
    <Flex vertical gap={12} data-testid="session-summary">
      <Descriptions column={1} size="small">
        <Descriptions.Item label={t('sessions.fields.type')}>
          <Flex gap={8} wrap>
            {t(`enums.sessionType.${session.sessionType}`)}
            <SessionStatusTag status={session.status} />
          </Flex>
        </Descriptions.Item>
        <Descriptions.Item label={t('sessions.fields.date')}>
          <Bdi>{format.dateTime(session.startsAt)}</Bdi>
        </Descriptions.Item>
        {court ? (
          <Descriptions.Item label={t('sessions.item.court')}>
            <bdi>{court}</bdi>
            {session.courtRoom
              ? `${t('sessions.separator')}${t('sessions.item.room', { room: isolate(session.courtRoom) })}`
              : null}
          </Descriptions.Item>
        ) : null}
        {session.judge ? (
          <Descriptions.Item label={t('sessions.item.judge')}>
            <bdi>{session.judge.fullName}</bdi>
          </Descriptions.Item>
        ) : null}
        <Descriptions.Item label={t('sessions.item.lawyer')}>
          <bdi>{session.attendingLawyer.fullName}</bdi>
        </Descriptions.Item>
        {session.outcome ? (
          <Descriptions.Item label={t('sessions.item.outcome')}>
            {t(`enums.sessionOutcome.${session.outcome}`)}
          </Descriptions.Item>
        ) : null}
        {session.cancellationReason ? (
          <Descriptions.Item label={t('sessions.cancel.reason')}>
            <bdi>{session.cancellationReason}</bdi>
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      {session.reminders.length > 0 ? (
        <section>
          <Typography.Text strong>{t('sessions.reminders.title')}</Typography.Text>
          <Flex
            component="ul"
            vertical
            gap={4}
            style={{ margin: 0, padding: 0, listStyle: 'none' }}
            data-testid="session-reminders-list"
          >
            {session.reminders.map((reminder) => (
              <Flex component="li" key={reminder.id} justify="space-between" gap={8}>
                {t('sessions.reminders.item', {
                  count: reminder.daysBefore,
                  name: isolate(reminder.recipient.fullName),
                })}
                <Tag color={REMINDER_COLOR[reminder.status]}>
                  {t(`enums.reminderStatus.${reminder.status}`)}
                </Tag>
              </Flex>
            ))}
          </Flex>
        </section>
      ) : null}
    </Flex>
  );
}
