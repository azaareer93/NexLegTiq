import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 10;

// ponytail: a short list of passwords that pass the character rules but top every breach list; a full breached-password
// check (k-anonymity range API or a bundled top-100k list) can replace it if signups ever need it.
const COMMON_PASSWORDS = new Set([
  'password123',
  'password1234',
  'passw0rd123',
  'p@ssw0rd123',
  'qwerty12345',
  'qwerty123456',
  'qwertyuiop1',
  'welcome123',
  'welcome1234',
  'letmein1234',
  'abc1234567',
  'abcd123456',
  'admin12345',
  'administrator1',
  'iloveyou123',
  'football123',
  'monkey12345',
  'dragon12345',
  'sunshine123',
  'princess123',
  'changeme123',
  'trustno1234',
  'master12345',
  'superman123',
  'baseball123',
  'starwars123',
  'login12345',
  'test123456',
  'nexlegtiq123',
  'palestine123',
  'ramallah123',
  'lawyer12345',
  'lawoffice123',
]);

/**
 * A password being set (signup, reset, change, invite acceptance) — auth-rbac.md password policy: at least 10 characters
 * with upper, lower and a digit, and not a well-known password. "Not equal to the email" needs the email, so forms that
 * have one check it with `passwordIsNotEmail`.
 */
export const NewPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, 'validation.password.tooShort')
  .max(256, 'validation.tooLong')
  .refine(
    (value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value),
    'validation.password.weak',
  )
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), 'validation.password.common');

/** False when the password is the email (or its local part), ignoring case. */
export function passwordIsNotEmail(password: string, email: string): boolean {
  const lowered = password.toLowerCase();
  const address = email.toLowerCase();
  return lowered !== address && lowered !== address.split('@')[0];
}
