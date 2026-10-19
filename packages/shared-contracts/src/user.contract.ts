import { ROLES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/**
 * A row of `GET /users/directory` (D-123): an active colleague, for pickers (responsible lawyer, paralegal, assignee).
 * Name and role only — the team-management list adds emails and statuses.
 */
export const DirectoryUserSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  role: z.enum(ROLES),
});
export type DirectoryUser = z.infer<typeof DirectoryUserSchema>;
