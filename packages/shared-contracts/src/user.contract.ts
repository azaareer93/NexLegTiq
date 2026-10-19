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

/** A row of `GET /users` (team management, D-124): every user of the office, active or not. */
export const TeamMemberSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  isActive: z.boolean(),
  /** Live OPEN or SUSPENDED files the user is the responsible lawyer of. */
  openFiles: z.number().int().nonnegative(),
  lastLoginAt: z.iso.datetime().nullable(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

/** `PATCH /users/:id/role`. */
export const ChangeRoleSchema = z.object({ role: z.enum(ROLES) });
export type ChangeRoleRequest = z.infer<typeof ChangeRoleSchema>;

/** A row of `GET /users/:id/open-files`: what the deactivate wizard must reassign. */
export const UserOpenFileSchema = z.object({
  id: z.uuid(),
  fileNumber: z.string(),
  title: z.string(),
});
export type UserOpenFile = z.infer<typeof UserOpenFileSchema>;

/** `POST /users/:id/deactivate`: a new responsible lawyer for every open file of the user (W5). */
export const DeactivateUserSchema = z.object({
  reassignments: z
    .array(z.object({ fileId: z.uuid(), newResponsibleLawyerId: z.uuid() }))
    .max(500)
    .refine(
      (rows) => new Set(rows.map((row) => row.fileId)).size === rows.length,
      'validation.duplicate',
    )
    .default([]),
});
export type DeactivateUserRequest = z.input<typeof DeactivateUserSchema>;
