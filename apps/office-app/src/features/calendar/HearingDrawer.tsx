import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { useEffect } from 'react';

import { useSession } from '../auth';
import { useCase } from '../cases/api/use-cases';
import { useSessionRights } from '../cases/sessions/session-rights';
import { SessionDrawer } from '../cases/sessions/SessionDrawer';

/** A hearing's drawer needs its file (rights, court defaults): loaded on open. */
export function HearingDrawer({
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
  const { notify } = useApiErrorHandler();
  // A file that cannot be loaded (deleted, no longer visible, offline): say why instead of doing nothing.
  useEffect(() => {
    if (!file.error) return;
    notify(file.error);
    onClose();
  }, [file.error, notify, onClose]);
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
