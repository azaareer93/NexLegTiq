import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { LOCKOUT_DURATION_MS, LOCKOUT_MAX_FAILURES } from './auth.constants';

/**
 * LoginAttempt rows (D-053). The table is global and written before an office is known, so every access here uses
 * the raw client (D-079, D-080).
 */
@Injectable()
export class LoginAttemptRepository {
  constructor(private readonly prisma: PrismaService) {}

  record(email: string, ipAddress: string, success: boolean): Promise<unknown> {
    // unscoped: LoginAttempt is global and written before any office is known (D-079).
    return this.prisma.unscoped().loginAttempt.create({ data: { email, ipAddress, success } });
  }

  /** The newest failures (up to the lockout threshold) since this pair's last success, newest first. */
  async recentFailures(email: string, ipAddress: string, now: Date): Promise<Date[]> {
    // Two windows back is enough to see any lock that can still be active now.
    const horizon = new Date(now.getTime() - 2 * LOCKOUT_DURATION_MS);
    // unscoped: see record().
    const attempts = this.prisma.unscoped().loginAttempt;
    const lastSuccess = await attempts.findFirst({
      where: { email, ipAddress, success: true, attemptedAt: { gte: horizon } },
      orderBy: { attemptedAt: 'desc' },
      select: { attemptedAt: true },
    });
    const failures = await attempts.findMany({
      where: { email, ipAddress, success: false, attemptedAt: { gt: lastSuccess?.attemptedAt ?? horizon } },
      orderBy: { attemptedAt: 'desc' },
      take: LOCKOUT_MAX_FAILURES,
      select: { attemptedAt: true },
    });
    return failures.map((failure) => failure.attemptedAt);
  }
}
