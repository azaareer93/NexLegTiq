import { EmptyState, useCan } from '@nexlegtiq/shared-ui';
import { Button, Flex } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { HowItWorksLink } from '../help';

/** Nothing in the range: hearings are scheduled from a case's Sessions tab, so the way forward is the cases list. */
export function CalendarEmpty() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const canSchedule = useCan('create:session');
  return (
    <EmptyState
      illustration="calendar"
      title={t('calendar.empty')}
      description={canSchedule ? t('calendar.emptyHint') : undefined}
      action={
        <Flex vertical align="center" gap={4}>
          {canSchedule ? (
            <Button
              type="primary"
              onClick={() => void navigate('/cases')}
              data-testid="calendar-empty-schedule"
            >
              {t('calendar.emptyAction')}
            </Button>
          ) : null}
          <HowItWorksLink slug="hearings" />
        </Flex>
      }
    />
  );
}
