import { EmptyState, useFormat } from '@nexlegtiq/shared-ui';
import { Button, Card, Descriptions, Skeleton } from 'antd';
import { useTranslation } from 'react-i18next';

import { useCourtName } from './SessionSummary';
import { useFileSessions } from './use-sessions';

/**
 * The file's next scheduled hearing (Details tab). It shares the Hearings tab's cache key, so scheduling, moving or
 * cancelling a hearing refreshes it at once.
 */
export function NextHearingCard({
  fileId,
  onOpen,
}: {
  readonly fileId: string;
  readonly onOpen: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const courtName = useCourtName();
  // Upcoming lists include cancelled hearings (D-116): the first scheduled one is the next hearing.
  const upcoming = useFileSessions(fileId, { when: 'upcoming', limit: 10 });
  const next = upcoming.data?.items.find((session) => session.status === 'SCHEDULED');
  const court = next ? courtName(next.court) : null;
  return (
    <Card title={t('cases.file.cards.nextHearing')} data-testid="case-card-next-hearing">
      {!upcoming.data && upcoming.isPending ? (
        <Skeleton active title={false} paragraph={{ rows: 2 }} />
      ) : null}
      {upcoming.data && !next ? <EmptyState title={t('cases.file.nextHearing.none')} /> : null}
      {next ? (
        <>
          <Descriptions column={1} size="small">
            <Descriptions.Item label={t('sessions.fields.date')}>
              {format.dateTime(next.startsAt)}
            </Descriptions.Item>
            <Descriptions.Item label={t('sessions.fields.type')}>
              {t(`enums.sessionType.${next.sessionType}`)}
            </Descriptions.Item>
            {court ? (
              <Descriptions.Item label={t('sessions.item.court')}>
                <bdi>{court}</bdi>
              </Descriptions.Item>
            ) : null}
            <Descriptions.Item label={t('sessions.item.lawyer')}>
              <bdi>{next.attendingLawyer.fullName}</bdi>
            </Descriptions.Item>
          </Descriptions>
          <Button onClick={() => onOpen(next.id)} data-testid="next-hearing-open">
            {t('cases.file.nextHearing.open')}
          </Button>
        </>
      ) : null}
    </Card>
  );
}
