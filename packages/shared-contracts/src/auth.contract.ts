import {
  DIGIT_STYLES,
  ACCOUNT_TYPES,
  JURISDICTIONS,
  OFFICE_LANGUAGES,
  PERMISSIONS,
  ROLES,
} from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { CurrencySchema, EmailSchema, PhoneSchema, plainText } from './fields.js';
import { NewPasswordSchema, passwordIsNotEmail } from './password.contract.js';

// Normalise first, then validate: users paste emails with spaces and capitals; the column is citext anyway (D-032).

/**
 * Office login (auth-rbac.md, Flows). Passwords are only length-checked here: a wrong password must look exactly like
 * a wrong email (AUTH-001), so no policy hints leak at login. The password policy applies where passwords are set.
 */
export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, 'validation.required').max(256, 'validation.tooLong'),
  rememberMe: z.boolean().default(false),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Office signup (MVP-39, workflow W1, onboarding steps 1–2). Creates the office, its OFFICE_MANAGER and the free or trial
 * subscription. ToS and Privacy must be accepted; the server records which versions (D-083).
 */
export const RegisterRequestSchema = z
  .object({
    fullName: plainText(120).pipe(z.string().min(2, 'validation.tooShort')),
    email: EmailSchema,
    password: NewPasswordSchema,
    officeName: plainText(200),
    accountType: z.enum(ACCOUNT_TYPES),
    jurisdiction: z.enum(JURISDICTIONS).default('PALESTINE'),
    defaultLanguage: z.enum(OFFICE_LANGUAGES).default('AR'),
    /** ISO-4217 (D-004); ILS, JOD and USD are common in Palestine. */
    currency: CurrencySchema,
    phone: PhoneSchema.optional(),
    acceptTerms: z.literal(true, 'validation.mustAcceptTerms'),
    acceptPrivacy: z.literal(true, 'validation.mustAcceptPrivacy'),
  })
  .refine((body) => passwordIsNotEmail(body.password, body.email), {
    message: 'validation.password.sameAsEmail',
    path: ['password'],
  });
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

/** `POST /auth/verify-email`: the token from the emailed link (D-083). */
export const VerifyEmailRequestSchema = z.object({
  token: z.string().trim().min(16, 'validation.invalidToken').max(128, 'validation.invalidToken'),
});
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

/** `POST /auth/resend-verification`: always 202, whether or not the email has an account (D-085). */
export const ResendVerificationRequestSchema = z.object({ email: EmailSchema });
export type ResendVerificationRequest = z.infer<typeof ResendVerificationRequestSchema>;

/** `POST /auth/forgot-password`: always 200, whether or not the email has an account (auth-rbac.md, D-086). */
export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema });
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

/** `POST /auth/reset-password`: the token from the emailed link and the new password, typed twice (D-086). */
export const ResetPasswordRequestSchema = z
  .object({
    token: z.string().trim().min(16, 'validation.invalidToken').max(128, 'validation.invalidToken'),
    newPassword: NewPasswordSchema,
    confirmPassword: z.string().max(256, 'validation.tooLong'),
  })
  .refine((body) => body.newPassword === body.confirmPassword, {
    message: 'validation.password.mismatch',
    path: ['confirmPassword'],
  });
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

/** `POST /users/me/password`: the current password, then a new one that differs from it (D-086). */
export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1, 'validation.required').max(256, 'validation.tooLong'),
    newPassword: NewPasswordSchema,
  })
  .refine((body) => body.newPassword !== body.currentPassword, {
    message: 'validation.password.unchanged',
    path: ['newPassword'],
  });
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

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
  /** False until the signup email is confirmed: the UI shows a banner (D-083). */
  emailVerified: z.boolean(),
  /** When an unverified account loses access (AUTH-010); null once verified. */
  verifyBy: z.iso.datetime().nullable(),
  /** The office's idle timeout in minutes (D-053, office settings): the UI signs out after it. */
  idleMinutes: z.number().int().min(15).max(120),
  /** The office's IANA time zone (D-125): hearing and deadline times are shown and entered in it (D-127). */
  timeZone: z.string().min(1),
  /** The user's digits on screen (D-092, D-146). */
  digitStyle: z.enum(DIGIT_STYLES),
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

/** The emailed invitation token (D-134): as long as the other account links. */
export const InviteTokenSchema = z
  .string()
  .trim()
  .min(16, 'validation.invalidToken')
  .max(128, 'validation.invalidToken');

/** `POST /auth/invites/preview`: the token in the body, so it never sits in a URL or an access log (D-134). */
export const InvitePreviewRequestSchema = z.object({ token: InviteTokenSchema });
export type InvitePreviewRequest = z.infer<typeof InvitePreviewRequestSchema>;

/** What the accept page shows before the person signs up (410 RES-004 when invalid). */
export const InvitePreviewSchema = z.object({
  officeName: z.string(),
  inviterName: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  fullName: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});
export type InvitePreview = z.infer<typeof InvitePreviewSchema>;

/**
 * `POST /auth/accept-invite`: creates the invited user and signs them in like /auth/login. The email comes from the
 * invitation, so "not the email" is checked by the server (VAL-001 on `password`). Terms and Privacy as at signup (D-083).
 */
export const AcceptInviteRequestSchema = z.object({
  token: InviteTokenSchema,
  fullName: plainText(120).pipe(z.string().min(2, 'validation.tooShort')),
  password: NewPasswordSchema,
  phone: PhoneSchema.optional(),
  acceptTerms: z.literal(true, 'validation.mustAcceptTerms'),
  acceptPrivacy: z.literal(true, 'validation.mustAcceptPrivacy'),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>;
