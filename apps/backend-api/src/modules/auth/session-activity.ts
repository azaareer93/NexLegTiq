import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { RefreshTokenRepository } from './refresh-token.repository';

/** A session's activity is written at most this often (MVP-168): the idle limit is in minutes, not seconds. */
export const ACTIVITY_WRITE_MS = 60_000;
/** Above this many tracked sessions the per-process memo starts over (it only saves queries). */
const MEMO_LIMIT = 10_000;

/**
 * Records that a session is in use (MVP-168, amends D-082/D-090): every authenticated request calls `touch`, which bumps
 * the session's `lastActivityAt` at most once a minute — a memo per process skips the query in between, and the update
 * itself only matches a row older than a minute (several API processes). A failure is logged, never fails the request:
 * the worst case is a session signed out a little early.
 */
@Injectable()
export class SessionActivity {
  private readonly lastWrite = new Map<string, number>();

  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SessionActivity.name);
  }

  async touch(officeId: string, familyId: string, now = new Date()): Promise<void> {
    const at = now.getTime();
    if (at - (this.lastWrite.get(familyId) ?? 0) < ACTIVITY_WRITE_MS) return;
    if (this.lastWrite.size >= MEMO_LIMIT) this.lastWrite.clear();
    this.lastWrite.set(familyId, at);
    try {
      await this.refreshTokens.touch(officeId, familyId, now, ACTIVITY_WRITE_MS);
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not record session activity');
    }
  }
}
