import type { ScopedTransaction } from '../../database/unit-of-work';
import { recipientsWanting } from '../notifications/notification-preferences';

/**
 * The in-app `task.assigned` row for a colleague, unless they turned task notifications off (D-098, D-146); returns its
 * id to push after the commit, or null.
 */
export async function assignedNotification(
  tx: ScopedTransaction,
  officeId: string,
  userId: string,
  task: { readonly id: string; readonly title: string },
): Promise<string | null> {
  const type = 'task.assigned';
  if (!(await recipientsWanting(tx, [userId], type, 'inApp')).has(userId)) return null;
  const { id } = await tx.notification.create({
    data: {
      officeId,
      userId,
      type,
      titleKey: 'common.notifications.taskAssigned',
      params: { taskId: task.id, title: task.title },
    },
    select: { id: true },
  });
  return id;
}
