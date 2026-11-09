import { z } from 'zod';

import { InviteTokenSchema } from './auth.contract.js';
import { EmailSchema, plainText } from './fields.js';
import { NewPasswordSchema } from './password.contract.js';

/**
 * The client-portal realm (D-157). One portal account per person; what it may see is granted per office (one grant per
 * invited client). Forgot and reset password reuse the office contracts (`ForgotPasswordRequestSchema`,
 * `ResetPasswordRequestSchema`).
 */

/** `POST /portal/auth/login`: passwords are only length-checked here, as for office sign-in. */
export const PortalLoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, 'validation.required').max(256, 'validation.tooLong'),
});
export type PortalLoginRequest = z.infer<typeof PortalLoginRequestSchema>;

/** One office the account may enter, as which client. */
export const PortalOfficeAccessSchema = z.object({
  officeId: z.uuid(),
  officeName: z.string(),
  clientId: z.uuid(),
  clientName: z.string(),
});
export type PortalOfficeAccess = z.infer<typeof PortalOfficeAccessSchema>;

export const PortalUserSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  offices: z.array(PortalOfficeAccessSchema),
});
export type PortalUser = z.infer<typeof PortalUserSchema>;

/** Body of portal login, accept-invite and refresh. The refresh token travels only in the `nlq_prt` cookie. */
export const PortalSessionSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  user: PortalUserSchema,
});
export type PortalSession = z.infer<typeof PortalSessionSchema>;

/** `POST /portal/auth/invites/preview`: the token in the body, never in a URL. */
export const PortalInvitePreviewRequestSchema = z.object({ token: InviteTokenSchema });
export type PortalInvitePreviewRequest = z.infer<typeof PortalInvitePreviewRequestSchema>;

export const PortalInvitePreviewSchema = z.object({
  officeName: z.string(),
  clientName: z.string(),
  email: z.string(),
  /** True when the address already has a portal account: accepting then asks for its existing password. */
  accountExists: z.boolean(),
  expiresAt: z.iso.datetime(),
});
export type PortalInvitePreview = z.infer<typeof PortalInvitePreviewSchema>;

/**
 * `POST /portal/auth/accept-invite`. New address: creates the account with `password` and `fullName`. Existing account:
 * `password` must be its current password (the name is ignored) and the office is added to it.
 */
export const PortalAcceptInviteRequestSchema = z.object({
  token: InviteTokenSchema,
  fullName: plainText(120).pipe(z.string().min(2, 'validation.tooShort')),
  password: NewPasswordSchema,
  acceptTerms: z.literal(true, 'validation.mustAcceptTerms'),
  acceptPrivacy: z.literal(true, 'validation.mustAcceptPrivacy'),
});
export type PortalAcceptInviteRequest = z.infer<typeof PortalAcceptInviteRequestSchema>;
