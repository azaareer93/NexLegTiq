import { ROLES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { EmailSchema, longText, plainText } from './fields.js';

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

/** Roles an invitation may give: every role but OFFICE_MANAGER (a manager is made by changing a member's role, W2). */
export const INVITABLE_ROLES = ROLES.filter(
  (role): role is Exclude<(typeof ROLES)[number], 'OFFICE_MANAGER'> => role !== 'OFFICE_MANAGER',
);

/** `POST /users/invite` (W2, D-134): one person per call; the team page sends one call per row. */
export const InviteUserSchema = z.object({
  email: EmailSchema,
  role: z.enum(INVITABLE_ROLES, 'validation.inviteRole'),
  fullName: plainText(120).optional(),
  /** A note shown in the invitation email. */
  message: longText(500).optional(),
});
export type InviteUserRequest = z.infer<typeof InviteUserSchema>;

/** A row of `GET /users/invitations`: pending invitations, EXPIRED once their link has lapsed (resend renews it). */
export const InvitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: z.enum(ROLES),
  fullName: z.string().nullable(),
  status: z.enum(['PENDING', 'EXPIRED']),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  invitedBy: z.object({ id: z.uuid(), fullName: z.string() }),
});
export type Invitation = z.infer<typeof InvitationSchema>;
