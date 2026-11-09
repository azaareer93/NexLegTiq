import { CalendarOutlined, CheckSquareOutlined } from '@ant-design/icons';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  DirectionalIcon,
  EmptyState,
  ErrorState,
  isApiError,
  Ltr,
  PageHeader,
  useApiErrorHandler,
  useCan,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { wallClock } from '@nexlegtiq/shared-utils';
import {
  Alert,
  Button,
  Calendar,
  Card,
  Col,
  Flex,
  Grid,
  Row,
  Segmented,
  Select,
  Tag,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { addDays, useCalendar } from './use-calendar';
import type { CalendarEntry, CalendarRange } from './use-calendar';
import { useSession } from '../auth';
import { useCase, useDirectory } from '../cases/api/use-cases';
import { useSessionRights } from '../cases/sessions/session-rights';
import { SessionDrawer } from '../cases/sessions/SessionDrawer';
import { openTaskDrawer } from '../tasks';

type View = 'month' | 'week' | 'agenda';
const AGENDA_DAYS = 30;
// Layout values, not text: a week's seven equal columns, or one day per row.
const WEEK_COLUMN = { flex: '1 1 0' } as const;
const FULL_ROW = { span: 24 } as const;
const DEFAULT_ZONE = 'Asia/Hebron';
const LAWYER_ROLES = new Set(['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER']);

/** The days a view shows around `anchor`; the week starts as the language's locale says (Saturday in Arabic, D-155). */
export function rangeOf(view: View, anchor: Dayjs): CalendarRange {
  const day = (d: Dayjs) => d.format('YYYY-MM-DD');
  if (view === 'month') {
    return {
      first: day(anchor.startOf('month').startOf('week')),
      last: day(anchor.endOf('month').endOf('week')),
    };
  }
  if (view === 'week')
    return { first: day(anchor.startOf('week')), last: day(anchor.endOf('week')) };
  return { first: day(anchor), last: addDays(day(anchor), AGENDA_DAYS - 1) };
}

/** One hearing or task: icon, words and time (never colour alone), opening its drawer. */
function Entry({
  entry,
  onOpen,
}: {
  readonly entry: CalendarEntry;
  readonly onOpen: (e: CalendarEntry) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const testId = `calendar-${entry.kind}-${entry.kind === 'hearing' ? entry.session.id : entry.task.id}`;
  return (
    <Button
      type="text"
      size="small"
      block
      style={{ textAlign: 'start', height: 'auto', whiteSpace: 'normal' }}
      icon={
        entry.kind === 'hearing' ? (
          <CalendarOutlined aria-hidden />
        ) : (
          <CheckSquareOutlined aria-hidden />
        )
      }
      onClick={() => onOpen(entry)}
      data-testid={testId}
    >
      {entry.kind === 'hearing' ? (
        <span>
          {format.time(entry.session.startsAt)}{' '}
          {t(`enums.sessionType.${entry.session.sessionType}`)}{' '}
          <Ltr>{entry.session.file.fileNumber}</Ltr>
        </span>
      ) : (
        <span>
          {t('calendar.legend.task')}: <bdi>{entry.task.title}</bdi>
        </span>
      )}
    </Button>
  );
}

function DayEntries({
  entries,
  onOpen,
}: {
  readonly entries: readonly CalendarEntry[];
  readonly onOpen: (e: CalendarEntry) => void;
}) {
  return (
    <Flex vertical gap={2}>
      {entries.map((entry) => (
        <Entry
          key={entry.kind + (entry.kind === 'hearing' ? entry.session.id : entry.task.id)}
          entry={entry}
          onOpen={onOpen}
        />
      ))}
    </Flex>
  );
}

/** A hearing's drawer needs its file (rights, court defaults): loaded on open. */
function HearingDrawer({
  fileId,
  sessionId,
  onClose,
}: {
  readonly fileId: string;
  readonly sessionId: string;
  readonly onClose: () => void;
}) {
  const user = useSession((state) => state.user);
  const file = useCase(fileId);
  if (!file.data || !user) return null;
  return (
    <LoadedHearingDrawer
      file={file.data}
      userId={user.id}
      sessionId={sessionId}
      onClose={onClose}
    />
  );
}

function LoadedHearingDrawer({
  file,
  userId,
  sessionId,
  onClose,
}: {
  readonly file: NonNullable<ReturnType<typeof useCase>['data']>;
  readonly userId: string;
  readonly sessionId: string;
  readonly onClose: () => void;
}) {
  const rights = useSessionRights(file, userId);
  return <SessionDrawer file={file} sessionId={sessionId} open rights={rights} onClose={onClose} />;
}

/** `/calendar` (MVP-70, D-155): month, week and agenda of hearings and due tasks, in the office's time zone. */
export function CalendarPage() {
  const { t } = useTranslation();
  const format = useFormat();
  const { referenceOf } = useApiErrorHandler();
  const narrow = Grid.useBreakpoint().md === false;
  const timeZone = useSession((state) => state.user?.timeZone) ?? DEFAULT_ZONE;
  const seesAll = useCan('view:all:cases');
  const directory = useDirectory(seesAll);
  const [params, setParams] = useSearchParams();
  const fileId = params.get('fileId') ?? undefined;
  // Until the user picks a view, phones get the agenda (the breakpoint is only known after the first render).
  const [picked, setView] = useState<View | null>(null);
  const view: View = picked ?? (narrow ? 'agenda' : 'month');
  const [anchor, setAnchor] = useState(() => dayjs(wallClock(new Date(), timeZone).date));
  const [lawyerId, setLawyerId] = useState<string | undefined>(undefined);
  const [hearing, setHearing] = useState<{ fileId: string; sessionId: string } | null>(null);
  const range = rangeOf(view, anchor);
  const calendar = useCalendar(range, { lawyerId, fileId }, timeZone);
  const byDay = (day: string) => calendar.entries.filter((entry) => entry.day === day);
  const open = (entry: CalendarEntry) =>
    entry.kind === 'hearing'
      ? setHearing({ fileId: entry.session.file.id, sessionId: entry.session.id })
      : openTaskDrawer({ task: entry.task });
  const step = (direction: 1 | -1) =>
    setAnchor((current) =>
      view === 'agenda'
        ? current.add(direction * AGENDA_DAYS, 'day')
        : current.add(direction, view),
    );

  const toolbar = (
    <Flex gap={8} wrap align="center">
      <Segmented<View>
        value={view}
        onChange={setView}
        options={(['month', 'week', 'agenda'] as const).map((value) => ({
          value,
          label: t(`calendar.views.${value}`),
        }))}
        data-testid="calendar-view"
      />
      <Button
        icon={<DirectionalIcon icon={LeftOutlined} />}
        aria-label={t('calendar.previous')}
        onClick={() => step(-1)}
      />
      <Button onClick={() => setAnchor(dayjs(wallClock(new Date(), timeZone).date))}>
        {t('calendar.today')}
      </Button>
      <Button
        icon={<DirectionalIcon icon={RightOutlined} />}
        aria-label={t('calendar.next')}
        onClick={() => step(1)}
      />
      <Typography.Text strong data-testid="calendar-range">
        {format.date(range.first, 'long')} – {format.date(range.last, 'long')}
      </Typography.Text>
      {seesAll ? (
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          style={{ minWidth: 200 }}
          placeholder={t('calendar.allLawyers')}
          aria-label={t('calendar.lawyer')}
          value={lawyerId}
          onChange={setLawyerId}
          options={(directory.data ?? [])
            .filter((person) => LAWYER_ROLES.has(person.role))
            .map((person) => ({ value: person.id, label: person.fullName }))}
          data-testid="calendar-lawyer"
        />
      ) : null}
      {fileId ? (
        <Tag closable onClose={() => setParams({})}>
          {t('calendar.oneCase')}
        </Tag>
      ) : null}
    </Flex>
  );

  const body = () => {
    if (calendar.error) {
      const error = calendar.error;
      return (
        <ErrorState
          code={isApiError(error) && isErrorCode(error.code) ? error.code : undefined}
          requestId={referenceOf(error)}
          onRetry={calendar.refetch}
        />
      );
    }
    if (view === 'month') {
      return (
        <Calendar
          value={anchor}
          headerRender={() => null}
          onPanelChange={(value) => setAnchor(value)}
          onSelect={(value, info) => info.source === 'date' && setAnchor(value)}
          cellRender={(date, info) =>
            info.type === 'date' ? (
              <DayEntries entries={byDay(date.format('YYYY-MM-DD'))} onOpen={open} />
            ) : null
          }
        />
      );
    }
    const days =
      view === 'week'
        ? Array.from({ length: 7 }, (_, i) => addDays(range.first, i))
        : [...new Set(calendar.entries.map((entry) => entry.day))];
    if (days.length === 0 && !calendar.isPending) {
      return <EmptyState title={t('calendar.empty', { count: AGENDA_DAYS })} />;
    }
    return (
      <Row gutter={[8, 8]}>
        {days.map((day) => (
          // A week on a wide screen: seven equal columns; otherwise one day per row (phones, agenda).
          <Col key={day} {...(view === 'week' && !narrow ? WEEK_COLUMN : FULL_ROW)}>
            <Card size="small" title={format.date(day, 'long')} data-testid={`calendar-day-${day}`}>
              <DayEntries entries={byDay(day)} onOpen={open} />
            </Card>
          </Col>
        ))}
      </Row>
    );
  };

  return (
    <Flex vertical gap={16} component="section" data-testid="page-calendar">
      <PageHeader title={t('calendar.title')} extra={toolbar} />
      <Flex gap={8} wrap aria-label={t('calendar.legend.title')}>
        <Tag icon={<CalendarOutlined aria-hidden />}>{t('calendar.legend.hearing')}</Tag>
        <Tag icon={<CheckSquareOutlined aria-hidden />}>{t('calendar.legend.task')}</Tag>
      </Flex>
      {calendar.truncated ? <Alert type="info" showIcon message={t('calendar.truncated')} /> : null}
      {body()}
      {hearing ? (
        <HearingDrawer
          fileId={hearing.fileId}
          sessionId={hearing.sessionId}
          onClose={() => setHearing(null)}
        />
      ) : null}
    </Flex>
  );
}
