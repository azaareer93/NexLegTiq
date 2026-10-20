import { PlusOutlined } from '@ant-design/icons';
import type { SessionListItem } from '@nexlegtiq/shared-contracts';
import { Bdi, EmptyState, ErrorState, LoadingSkeleton, useFormat } from '@nexlegtiq/shared-ui';
import { isolate, isolateLtr } from '@nexlegtiq/shared-utils';
import { Button, Card, Flex, Pagination, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { hasStarted } from './session-form';
import { SessionStatusTag, useCourtName } from './SessionSummary';
import { useFileSessions } from './use-sessions';

const PAGE_SIZE = 10;

/** Court, room and judge of a hearing, as far as they are known. */
function WhereLine({ session }: { readonly session: SessionListItem }): React.JSX.Element | null {
  const { t } = useTranslation();
  const court = useCourtName()(session.court);
  const parts = [
    court ? <bdi key="court">{court}</bdi> : null,
    session.courtRoom ? t('sessions.item.room', { room: isolate(session.courtRoom) }) : null,
    session.judge ? t('sessions.item.judgeOf', { name: isolate(session.judge.fullName) }) : null,
  ].filter((part) => part !== null);
  if (parts.length === 0) return null;
  return (
    <Typography.Text type="secondary">
      {parts.flatMap((part, index) => (index === 0 ? [part] : [t('sessions.separator'), part]))}
    </Typography.Text>
  );
}

/** One hearing: type, time on the office clock, court and room, judge, lawyer, reminders and outcome. */
function SessionRow({
  session,
  onOpen,
}: {
  readonly session: SessionListItem;
  readonly onOpen: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const when = format.dateTime(session.startsAt);
  const needsOutcome = session.status === 'SCHEDULED' && hasStarted(session);
  return (
    <Card
      size="small"
      hoverable
      role="button"
      tabIndex={0}
      aria-label={t('sessions.item.open', { when: isolate(when) })}
      onClick={() => onOpen(session.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(session.id);
        }
      }}
      data-testid={`session-row-${session.id}`}
    >
      <Flex vertical gap={4}>
        <Flex gap={8} wrap align="center">
          <Typography.Text strong>{t(`enums.sessionType.${session.sessionType}`)}</Typography.Text>
          <Typography.Text>
            <Bdi>{when}</Bdi>
          </Typography.Text>
          <SessionStatusTag status={session.status} />
          {session.outcome ? <Tag>{t(`enums.sessionOutcome.${session.outcome}`)}</Tag> : null}
          {needsOutcome ? <Tag color="warning">{t('sessions.item.needsOutcome')}</Tag> : null}
        </Flex>
        <WhereLine session={session} />
        <Typography.Text type="secondary">
          {t('sessions.item.lawyerOf', { name: isolate(session.attendingLawyer.fullName) })}
          {t('sessions.separator')}
          {session.reminderDays.length > 0
            ? t('sessions.item.reminders', {
                days: session.reminderDays.join(t('sessions.listSeparator')),
              })
            : t('sessions.item.noReminders')}
        </Typography.Text>
      </Flex>
    </Card>
  );
}

function SessionSection({
  fileId,
  when,
  onOpen,
}: {
  readonly fileId: string;
  readonly when: 'upcoming' | 'past';
  readonly onOpen: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const list = useFileSessions(fileId, { when, page, limit: PAGE_SIZE });
  const items = list.data?.items ?? [];
  const body = () => {
    if (list.isError && !list.data) {
      return <ErrorState onRetry={() => void list.refetch()} />;
    }
    if (!list.data) return <LoadingSkeleton rows={3} />;
    if (items.length === 0) {
      return (
        <EmptyState
          title={when === 'upcoming' ? t('sessions.tab.noUpcoming') : t('sessions.tab.noPast')}
        />
      );
    }
    return (
      <Flex vertical gap={8}>
        {items.map((session) => (
          <SessionRow key={session.id} session={session} onOpen={onOpen} />
        ))}
        {list.data.pagination.totalPages > 1 ? (
          <Pagination
            simple
            current={page}
            pageSize={PAGE_SIZE}
            total={list.data.pagination.total}
            onChange={setPage}
          />
        ) : null}
      </Flex>
    );
  };
  return (
    <Card
      title={when === 'upcoming' ? t('sessions.tab.upcoming') : t('sessions.tab.past')}
      data-testid={`sessions-${when}`}
    >
      {body()}
    </Card>
  );
}

/** The Hearings tab of a file (frontend.md, MVP-69): upcoming soonest first, past latest first; a row opens the drawer. */
export function SessionsTab({
  fileId,
  canCreate,
  onOpen,
}: {
  readonly fileId: string;
  readonly canCreate: boolean;
  readonly onOpen: (id: string | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Flex vertical gap={16} data-testid="case-sessions">
      {canCreate ? (
        <Flex gap={8} align="center" wrap>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => onOpen(null)}
            data-testid="session-new"
          >
            {t('sessions.tab.schedule')}
          </Button>
          <Typography.Text type="secondary">
            {t('sessions.tab.shortcut', { keys: isolateLtr('Ctrl+Alt+H') })}
          </Typography.Text>
        </Flex>
      ) : null}
      <SessionSection fileId={fileId} when="upcoming" onOpen={onOpen} />
      <SessionSection fileId={fileId} when="past" onOpen={onOpen} />
    </Flex>
  );
}
