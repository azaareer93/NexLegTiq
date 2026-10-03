const DAY_MS = 86_400_000;
const COOLDOWN_MS = 60_000;
export const MAX_LINKS_PER_DAY = 5;

/** Since when to load a user's recent links for `mayIssueLink` (newest first, at most MAX_LINKS_PER_DAY). */
export function linkWindowStart(now: Date): Date {
  return new Date(now.getTime() - DAY_MS);
}

/**
 * Emailed account links (verification, password reset; D-085, D-086): at most one a minute per user — a retry of the same
 * job is exempt, its first link may never have been sent — and five a day, whatever the number of IPs asking. Nobody can
 * flood an inbox or keep killing the link the user just received. `recent` is newest first.
 */
export function mayIssueLink(recent: readonly Date[], now: Date, retry: boolean): boolean {
  if (recent.length >= MAX_LINKS_PER_DAY) return false;
  const newest = recent[0];
  return retry || !newest || now.getTime() - newest.getTime() >= COOLDOWN_MS;
}
