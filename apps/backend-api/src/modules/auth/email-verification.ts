/** Signup email verification (auth-rbac.md, Flows; D-083): the link lasts as long as the grace period. */
export const VERIFY_EMAIL_WITHIN_DAYS = 7;
const WINDOW_MS = VERIFY_EMAIL_WITHIN_DAYS * 86_400_000;

interface VerificationState {
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
}

/** When an unverified account loses access; null once verified. */
export function verifyBy(user: VerificationState): Date | null {
  return user.emailVerifiedAt ? null : new Date(user.createdAt.getTime() + WINDOW_MS);
}

/** True when the grace period is over and the email is still unverified (→ 403 AUTH-010). */
export function isVerificationOverdue(user: VerificationState, now: Date): boolean {
  const deadline = verifyBy(user);
  return deadline !== null && now >= deadline;
}

export function verificationLinkExpiry(now: Date): Date {
  return new Date(now.getTime() + WINDOW_MS);
}
