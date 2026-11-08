import type { NotificationContent } from '../../notifications/notification-job';

/** "The text of X is ready" for the version's uploader (D-149). */
export const processedNotification = (
  documentId: string,
  name: string,
  fileId: string,
): NotificationContent => ({
  type: 'DOCUMENT_PROCESSED',
  titleKey: 'shell.notifications.documentProcessed',
  params: { documentId, name: name.slice(0, 500) },
  link: `/cases/${fileId}?tab=documents`,
});
