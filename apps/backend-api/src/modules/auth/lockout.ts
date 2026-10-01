import { LOCKOUT_DURATION_MS, LOCKOUT_MAX_FAILURES } from './auth.constants';

/**
 * D-053: 5 failures for one email + IP lock that pair for 15 minutes, counted from the 5th failure. `recentFailures`
 * are the newest failures since the pair's last success, newest first. The 5 must fall within 15 minutes of each other,
 * and the lock lasts until 15 minutes after the newest of them.
 */
export function lockedUntil(recentFailures: readonly Date[]): Date | null {
  if (recentFailures.length < LOCKOUT_MAX_FAILURES) return null;
  const newest = recentFailures[0] as Date;
  const fifth = recentFailures[LOCKOUT_MAX_FAILURES - 1] as Date;
  if (newest.getTime() - fifth.getTime() > LOCKOUT_DURATION_MS) return null;
  return new Date(newest.getTime() + LOCKOUT_DURATION_MS);
}

export function isLocked(recentFailures: readonly Date[], now: Date): boolean {
  const until = lockedUntil(recentFailures);
  return until !== null && now < until;
}
