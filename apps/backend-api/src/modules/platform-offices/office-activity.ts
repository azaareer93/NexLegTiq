const DAY_MS = 24 * 60 * 60 * 1000;

/** Writes = actions that change office data; views, downloads and sign-ins are not work done (D-164). */
export const WRITE_ACTIONS = ['CREATE', 'UPDATE', 'DELETE', 'SHARE'] as const;
/** Window of the detail page's "30d" counts. */
export const STATS_WINDOW_DAYS = 30;
/** An office is at risk once it has gone this long without a write (and is at least this old). */
export const AT_RISK_QUIET_DAYS = 14;

export const daysAgo = (days: number, now = new Date()): Date =>
  new Date(now.getTime() - days * DAY_MS);

/** D-164: an active office older than 14 days whose last write (if any) is older than 14 days. */
export function isAtRisk(
  office: { isActive: boolean; createdAt: Date; lastWriteAt: Date | null },
  now = new Date(),
): boolean {
  const cutoff = daysAgo(AT_RISK_QUIET_DAYS, now);
  if (!office.isActive || office.createdAt > cutoff) return false;
  return office.lastWriteAt === null || office.lastWriteAt < cutoff;
}
