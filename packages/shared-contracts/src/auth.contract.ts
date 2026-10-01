import { ACCOUNT_TYPES, JURISDICTIONS, OFFICE_LANGUAGES, PERMISSIONS, ROLES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { NewPasswordSchema, passwordIsNotEmail } from './password.contract.js';

// Normalise first, then validate: users paste emails with spaces and capitals; the column is citext anyway (D-032).
const EmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email('validation.email'));

/** ISO-4217 codes the runtime knows (Node and every supported browser ship the list). */
const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

/**
 * Single-line plain text (names): trimmed, no control characters and no bidi overrides or isolates (U+202A–202E,
 * U+2066–2069), which could reverse how a name displays (D-054). ZWJ/ZWNJ stay allowed: Arabic text uses them.
 */
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'validation.required')
    .max(max, 'validation.tooLong')
    .regex(/^[^\p{Cc}‪-‮⁦-⁩]*$/u, 'validation.invalidCharacters');

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
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .refine((code) => CURRENCIES.has(code), 'validation.currency'),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'validation.phone')
      .optional(),
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
