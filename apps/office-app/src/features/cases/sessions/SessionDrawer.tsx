import type { Case, Session } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { Alert, Divider, Drawer, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { OutcomeSection } from './OutcomeSection';
import { hasStarted } from './session-form';
import type { SessionRights } from './session-rights';
import { CreateSessionForm, EditSessionForm } from './SessionForms';
import { SessionSummary } from './SessionSummary';
import { useHearing, useOfficeTimeZone } from './use-sessions';

function ExistingSession({
  session,
  rights,
  onDone,
}: {
  readonly session: Session;
  readonly rights: SessionRights;
  readonly onDone: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const timeZone = useOfficeTimeZone();
  const started = hasStarted(session);
  const scheduled = session.status === 'SCHEDULED';
  if (!rights.edit || session.status === 'CANCELLED') {
    return (
      <>
        <SessionSummary session={session} />
        {rights.edit ? (
          <Alert
            type="info"
            showIcon
            title={t('sessions.readOnly')}
            data-testid="session-read-only"
          />
        ) : null}
      </>
    );
  }
  return (
    <>
      <SessionSummary session={session} />
      {scheduled ? (
        <>
          <Divider />
          <EditSessionForm key={session.updatedAt} session={session} onDone={onDone} />
        </>
      ) : null}
      {started ? (
        <OutcomeSection
          key={session.updatedAt}
          session={session}
          timeZone={timeZone}
          canScheduleNext={rights.create}
        />
      ) : (
        <Typography.Paragraph type="secondary" data-testid="session-not-started">
          {t('sessions.outcome.notStarted')}
        </Typography.Paragraph>
      )}
    </>
  );
}

/**
 * The hearing drawer of a file (MVP-69, D-127): schedule a new one (`sessionId` null), or open one — its summary and
 * reminders, the edit form and cancel while scheduled, outcome and minutes once it has started.
 */
export function SessionDrawer({
  file,
  sessionId,
  open,
  rights,
  onClose,
}: {
  readonly file: Case;
  readonly sessionId: string | null;
  readonly open: boolean;
  readonly rights: SessionRights;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const hearing = useHearing(open ? sessionId : null);
  const body = () => {
    if (sessionId === null) return <CreateSessionForm file={file} onDone={onClose} />;
    if (hearing.data) {
      return <ExistingSession session={hearing.data} rights={rights} onDone={onClose} />;
    }
    if (hearing.isError) return <ApiErrorAlert error={hearing.error} testId="session-load-error" />;
    return <LoadingSkeleton rows={6} />;
  };
  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="large"
      destroyOnHidden
      title={sessionId === null ? t('sessions.drawer.createTitle') : t('sessions.drawer.title')}
      data-testid="session-drawer"
    >
      {open ? body() : null}
    </Drawer>
  );
}
