import {
  AuditOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  RobotOutlined,
  ShareAltOutlined,
  SwapOutlined,
  TeamOutlined,
  UserAddOutlined,
  UserDeleteOutlined,
} from '@ant-design/icons';
import type { TimelineEvent } from '@nexlegtiq/shared-contracts';
import { isErrorCode, TIMELINE_EVENT_TYPES } from '@nexlegtiq/shared-types';
import type { TimelineEventType } from '@nexlegtiq/shared-types';
import {
  Bdi,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Button, Card, Flex, List, Select, Tag, Timeline, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { eventSentence } from './timeline-text';
import { useTimeline } from './use-timeline';
import { useFileSessions } from '../sessions/use-sessions';

const ICONS: Readonly<Record<string, React.ReactNode>> = {
  FILE_OPENED: <FolderOpenOutlined />,
  FILE_CLOSED: <FolderOpenOutlined />,
  FILE_REOPENED: <FolderOpenOutlined />,
  FILE_REASSIGNED: <SwapOutlined />,
  SESSION_CREATED: <CalendarOutlined />,
  SESSION_UPDATED: <CalendarOutlined />,
  DOCUMENT_UPLOADED: <FileTextOutlined />,
  DOCUMENT_SHARED: <ShareAltOutlined />,
  TASK_COMPLETED: <CheckCircleOutlined />,
  PARTY_ADDED: <UserAddOutlined />,
  CLIENT_ADDED: <UserAddOutlined />,
  CLIENT_REMOVED: <UserDeleteOutlined />,
  TEAM_MEMBER_ADDED: <TeamOutlined />,
  TEAM_MEMBER_REMOVED: <UserDeleteOutlined />,
  WITNESS_STATEMENT_ADDED: <AuditOutlined />,
  SUMMARY_GENERATED: <RobotOutlined />,
  INVOICE_SENT: <DollarOutlined />,
  INVOICE_PAID: <DollarOutlined />,
};

/** Where an event's "open" goes: a hearing opens its drawer, documents and tasks their tab of the file. */
type Opener = { readonly hearing: (id: string) => void; readonly tab: (key: string) => void };

function sourceAction(event: TimelineEvent, open: Opener): (() => void) | null {
  if (event.sourceType === 'Session' && event.sourceId) {
    const id = event.sourceId;
    return () => open.hearing(id);
  }
  if (event.sourceType === 'Document') return () => open.tab('documents');
  if (event.sourceType === 'Task') return () => open.tab('tasks');
  return null;
}

interface Month {
  readonly key: string;
  readonly label: string;
  readonly events: TimelineEvent[];
}

/** Consecutive events of the same month (in the office's time zone) under one heading; pages are newest first. */
function byMonth(events: readonly TimelineEvent[], month: (value: string) => string): Month[] {
  const months: Month[] = [];
  for (const event of events) {
    const label = month(event.occurredAt);
    const last = months.at(-1);
    if (last?.label === label) last.events.push(event);
    else months.push({ key: `${label}-${event.id}`, label, events: [event] });
  }
  return months;
}

function EventItem({
  event,
  names,
  open,
}: {
  readonly event: TimelineEvent;
  readonly names: Readonly<Record<string, string>>;
  readonly open: Opener;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const action = sourceAction(event, open);
  return (
    <Flex vertical gap={2} data-testid={`timeline-event-${event.id}`}>
      <Typography.Text>{eventSentence(t, format, event, names)}</Typography.Text>
      <Flex gap={8} wrap align="center">
        <Typography.Text type="secondary">
          {event.actor
            ? t('timeline.by', { name: isolate(event.actor.fullName) })
            : t('timeline.bySystem')}
          {t('timeline.separator')}
          <Bdi>{format.dateTime(event.occurredAt)}</Bdi>
        </Typography.Text>
        {event.portalVisible ? <Tag>{t('timeline.portal')}</Tag> : null}
        {action ? (
          <Button
            type="link"
            size="small"
            onClick={action}
            data-testid={`timeline-open-${event.id}`}
          >
            {t('timeline.open')}
          </Button>
        ) : null}
      </Flex>
    </Flex>
  );
}

function History({
  fileId,
  types,
  open,
}: {
  readonly fileId: string;
  readonly types: readonly TimelineEventType[];
  readonly open: Opener;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const { referenceOf } = useApiErrorHandler();
  const history = useTimeline(fileId, types);
  if (history.isError) {
    const { error } = history;
    return (
      <ErrorState
        code={isApiError(error) && isErrorCode(error.code) ? error.code : undefined}
        requestId={referenceOf(error)}
        onRetry={() => void history.refetch()}
      />
    );
  }
  if (!history.data) return <LoadingSkeleton />;
  const { pages } = history.data;
  const names = Object.assign({}, ...pages.map((page) => page.names)) as Record<string, string>;
  const months = byMonth(
    pages.flatMap((page) => page.items),
    format.month,
  );
  if (months.length === 0) {
    return <EmptyState title={t(types.length ? 'timeline.emptyFiltered' : 'timeline.empty')} />;
  }
  return (
    <Flex vertical gap={16} data-testid="timeline-history">
      {months.map((month) => (
        <section key={month.key} aria-label={month.label}>
          <Typography.Title level={2} style={{ fontSize: 16 }}>
            {month.label}
          </Typography.Title>
          <Timeline
            items={month.events.map((event) => ({
              key: event.id,
              // Decorative: the sentence says what happened (an icon's own label is English).
              dot: <span aria-hidden>{ICONS[event.eventType] ?? <ClockCircleOutlined />}</span>,
              children: <EventItem event={event} names={names} open={open} />,
            }))}
          />
        </section>
      ))}
      {history.hasNextPage ? (
        <Button
          onClick={() => void history.fetchNextPage()}
          loading={history.isFetchingNextPage}
          data-testid="timeline-more"
        >
          {t('timeline.loadMore')}
        </Button>
      ) : null}
    </Flex>
  );
}

/** The scheduled hearings ahead (the Hearings tab's upcoming list; cancelled ones left out, D-116). */
function Upcoming({
  fileId,
  onOpen,
}: {
  readonly fileId: string;
  readonly onOpen: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  // The next-hearing card's query (D-127): one request and one cache for both.
  const upcoming = useFileSessions(fileId, { when: 'upcoming', limit: 50 });
  const ahead =
    upcoming.data?.items.filter((session) => session.status === 'SCHEDULED').slice(0, 10) ?? [];
  return (
    <Card title={t('timeline.upcoming')} data-testid="timeline-upcoming">
      {upcoming.data && ahead.length === 0 ? (
        <Typography.Text type="secondary">{t('timeline.noUpcoming')}</Typography.Text>
      ) : (
        <List
          loading={!upcoming.data && upcoming.isPending}
          dataSource={ahead}
          renderItem={(session) => (
            <List.Item key={session.id}>
              <Button
                type="link"
                icon={<CalendarOutlined aria-hidden />}
                onClick={() => onOpen(session.id)}
                data-testid={`timeline-upcoming-${session.id}`}
              >
                {t(`enums.sessionType.${session.sessionType}`)}
                {t('timeline.separator')}
                <Bdi>{format.dateTime(session.startsAt)}</Bdi>
              </Button>
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

/**
 * The file's Timeline tab (D-150): the hearings ahead, then the history newest first, grouped by month in the office's
 * time zone, each event with its icon, its sentence, who did it and when, and a way to its source.
 */
export function TimelineTab({
  fileId,
  onOpenHearing,
  onOpenTab,
}: {
  readonly fileId: string;
  readonly onOpenHearing: (id: string) => void;
  readonly onOpenTab: (key: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [types, setTypes] = useState<TimelineEventType[]>([]);
  return (
    <Flex vertical gap={16} data-testid="timeline-tab">
      <Upcoming fileId={fileId} onOpen={onOpenHearing} />
      <Card
        title={t('timeline.history')}
        extra={
          <Select
            mode="multiple"
            allowClear
            value={types}
            onChange={setTypes}
            placeholder={t('timeline.filter')}
            aria-label={t('timeline.filter')}
            style={{ minInlineSize: 220 }}
            options={TIMELINE_EVENT_TYPES.map((type) => ({
              value: type,
              label: t(`enums.timelineEventType.${type}`),
            }))}
            data-testid="timeline-filter"
          />
        }
      >
        <History fileId={fileId} types={types} open={{ hearing: onOpenHearing, tab: onOpenTab }} />
      </Card>
    </Flex>
  );
}
