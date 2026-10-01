import { PERMISSIONS, ROLES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/**
 * Office login (auth-rbac.md, Flows). Passwords are only length-checked here: a wrong password must look exactly like
 * a wrong email (AUTH-001), so no policy hints leak at login. The password policy applies where passwords are set.
 */
export const LoginRequestSchema = z.object({
  // Normalise first, then validate: users paste emails with spaces and capitals; the column is citext anyway (D-032).
  email: z.string().trim().toLowerCase().max(254).pipe(z.email('validation.email')),
  password: z.string().min(1, 'validation.required').max(256, 'validation.tooLong'),
  rememberMe: z.boolean().default(false),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthUserSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  email: z.email(),
  role: z.enum(ROLES),
  officeId: z.uuid(),
  officeName: z.string(),
  /** Prisma `UiLanguage` (the UI maps it to the `ar`/`en` locale). */
  uiLanguage: z.enum(['AR', 'EN']),
  permissions: z.array(z.enum(PERMISSIONS)),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

/** Body of login and refresh. The refresh token travels only in the httpOnly `nlq_rt` cookie, never in JSON (D-050). */
export const AuthSessionSchema = z.object({
  accessToken: z.string(),
  /** Seconds until the access token expires (900). */
  expiresIn: z.number().int().positive(),
  user: AuthUserSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;
