import { z } from 'zod';

export const CREATE_NOTIFICATION_JOB = 'create-notification';

/**
 * An in-app notification for one user of the job's office (`notification` queue). The UI renders `titleKey` (an i18n key)
 * with `params`; `link` is an office-app path.
 */
export const NotificationJobSchema = z.object({
  userId: z.uuid(),
  type: z.string().regex(/^[A-Z][A-Z_]{1,63}$/),
  titleKey: z.string().regex(/^[a-z][A-Za-z0-9.]{1,199}$/),
  params: z.record(z.string(), z.union([z.string().max(500), z.number(), z.null()])),
  link: z
    .string()
    .regex(/^\/[^/\\]/)
    .max(500)
    .nullable(),
});
export type NotificationJob = z.infer<typeof NotificationJobSchema>;
