import type { Job } from 'bullmq';

import { FAN_OUT_NOTIFICATION_JOB } from '../notification-job';

/** The single-user job name before D-149. */
export const LEGACY_NOTIFICATION_JOB = 'create-notification';

/** Types written before D-149 (the migration renames the stored rows the same way). */
const LEGACY_TYPES: Readonly<Record<string, string>> = {
  SESSION_REMINDER: 'HEARING_REMINDER',
  'task.assigned': 'TASK_ASSIGNED',
  'file.reassigned': 'FILE_REASSIGNED',
  'file.teamAdded': 'FILE_TEAM_ADDED',
  'invitation.accepted': 'INVITE_ACCEPTED',
};

/**
 * A `create-notification` job queued by the previous release (one `userId`, old type names) as the fan-out job it now is,
 * so a deploy loses no notification still waiting in Redis. Anything else is returned unchanged.
 * shortcut: kept for one release after D-149; remove once no such job can still be queued.
 */
export function upgradeLegacyJob<T>(job: Job<T>): Job<T> {
  if (job.name !== LEGACY_NOTIFICATION_JOB) return job;
  const data = job.data as Record<string, unknown>;
  const { userId, type, ...rest } = data;
  job.name = FAN_OUT_NOTIFICATION_JOB;
  job.data = {
    ...rest,
    userIds: typeof userId === 'string' ? [userId] : [],
    type: typeof type === 'string' ? (LEGACY_TYPES[type] ?? type) : type,
  } as T;
  return job;
}
