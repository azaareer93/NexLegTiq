import { z } from 'zod';

import { EmailSchema } from './fields.js';

/** Office side of the client portal (D-157): who a client has invited, and what they may see. */

/** `POST /clients/:id/portal-invitations` */
export const CreatePortalInvitationSchema = z.object({
  email: EmailSchema,
  /** The client's contact person this address belongs to, when it is one. */
  contactPersonId: z.uuid().optional(),
});
export type CreatePortalInvitationRequest = z.infer<typeof CreatePortalInvitationSchema>;

export const PortalInvitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  contactPersonId: z.uuid().nullable(),
  /** PENDING, or EXPIRED once the link lapsed. */
  status: z.enum(['PENDING', 'EXPIRED']),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type PortalInvitation = z.infer<typeof PortalInvitationSchema>;

/** A portal account with live access to the client. */
export const PortalAccessSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  fullName: z.string(),
  contactPersonId: z.uuid().nullable(),
  grantedAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
});
export type PortalAccess = z.infer<typeof PortalAccessSchema>;

/** `GET /clients/:id/portal-users` */
export const PortalUsersSchema = z.object({
  users: z.array(PortalAccessSchema),
  invitations: z.array(PortalInvitationSchema),
});
export type PortalUsers = z.infer<typeof PortalUsersSchema>;
