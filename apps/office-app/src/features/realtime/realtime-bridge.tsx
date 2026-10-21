import { useEffect } from 'react';

import { startRealtime } from './realtime';
import { useInvalidateOn } from './use-realtime';

/**
 * Mounted once inside the signed-in shell: opens the socket and refreshes what each event makes stale, app-wide. Keys are
 * prefixes (a feature's `all` key), so a list or detail cached by any page refetches; nothing cached, nothing fetched.
 */
export function RealtimeBridge(): null {
  useEffect(() => startRealtime(), []);
  useInvalidateOn('task.assigned', () => [['tasks']]);
  useInvalidateOn('task.updated', () => [['tasks']]);
  useInvalidateOn('session.scheduled', ({ fileId }) => [['sessions'], ['cases', 'detail', fileId]]);
  useInvalidateOn('session.reminder', ({ sessionId }) => [['sessions', 'detail', sessionId]]);
  useInvalidateOn('document.processed', ({ fileId }) => [
    ['documents'],
    ['cases', 'detail', fileId],
  ]);
  useInvalidateOn('document.summary.ready', ({ documentId }) => [
    ['documents', 'detail', documentId],
  ]);
  useInvalidateOn('notification', () => [['notifications']]);
  return null;
}
