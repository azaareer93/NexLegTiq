import { z } from 'zod';

import { EmailSchema } from './fields.js';

const PasswordInput = z.string().min(1, 'validation.required').max(256, 'validation.tooLong');
/** A 6-digit code from the authenticator app. */
const TotpCode = z.string().regex(/^\d{6}$/, 'validation.totpCode');
/** A one-time recovery code shown at enrolment: `XXXXX-XXXXX`, case and dash optional when typed. */
const RecoveryCode = z
  .string()
  .regex(/^[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}$/, 'validation.recoveryCode');

/**
 * `POST /admin/auth/login` (D-145): the password and, once enrolled, a code — the authenticator's or a recovery code.
 * Without one: 401 AUTH-008 (an admin who has not enrolled yet gets the detail `mfaEnrollment` and goes to /enroll);
 * a wrong one: 401 AUTH-009.
 */
export const AdminLoginSchema = z
  .object({
    email: EmailSchema,
    password: PasswordInput,
    code: TotpCode.optional(),
    recoveryCode: RecoveryCode.optional(),
  })
  .refine((body) => !(body.code && body.recoveryCode), {
    message: 'validation.oneCode',
    path: ['recoveryCode'],
  });
export type AdminLoginRequest = z.infer<typeof AdminLoginSchema>;

/** `POST /admin/auth/enroll`: the password again, for a not-yet-enrolled admin; answers the secret to scan. */
export const AdminEnrollSchema = z.object({ email: EmailSchema, password: PasswordInput });
export type AdminEnrollRequest = z.infer<typeof AdminEnrollSchema>;

export const AdminEnrollmentSchema = z.object({
  /** `otpauth://totp/…` — the app shows it as a QR code. */
  otpauthUri: z.string(),
  /** The same secret in base32, for typing in by hand. */
  secret: z.string(),
});
export type AdminEnrollment = z.infer<typeof AdminEnrollmentSchema>;

/** `POST /admin/auth/enroll/confirm`: the first code proves the app holds the secret; answers a session + recovery codes. */
export const AdminConfirmEnrollmentSchema = z.object({
  email: EmailSchema,
  password: PasswordInput,
  code: TotpCode,
});
export type AdminConfirmEnrollmentRequest = z.infer<typeof AdminConfirmEnrollmentSchema>;

export const AdminProfileSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  email: z.string(),
});
export type AdminProfile = z.infer<typeof AdminProfileSchema>;

/** A signed-in admin: the access token (memory only, D-050) and, once at enrolment, the recovery codes to keep. */
export const AdminSessionSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  admin: AdminProfileSchema,
  recoveryCodes: z.array(z.string()).optional(),
});
export type AdminSession = z.infer<typeof AdminSessionSchema>;
