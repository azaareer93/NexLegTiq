import { Injectable } from '@nestjs/common';
import { ProductEventSchema } from '@nexlegtiq/shared-contracts';
import type { ProductEventProps } from '@nexlegtiq/shared-contracts';
import type { ProductEventType } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../database/prisma.service';
import type { RequestContext } from '../context/request-context';

/** Above this many offices the per-process "already active today" memo starts over (it only saves queries). */
const MEMO_LIMIT = 10_000;

/**
 * First-party product analytics (MVP-110, D-215): `track(event, props)` writes one row to `product_events` in our own
 * database — no third party, no cookie, no browser script. The office id is the only identifier; props are checked
 * against the shared allow-list (`ProductEventSchema`). Nothing is recorded when the request carries Do Not Track or
 * Global Privacy Control, or when the office turned analytics off. Never throws: analytics must not fail what the user did.
 */
@Injectable()
export class ProductAnalytics {
  private readonly activeDay = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProductAnalytics.name);
  }

  /**
   * Records `event` for the request's office, or for `officeId` where no tenant context exists yet (signup, guard).
   * Resolves false only when recording failed (a skip by opt-out or DNT counts as done).
   */
  async track<E extends ProductEventType>(
    event: E,
    props: ProductEventProps<E>,
    forOffice?: string,
  ): Promise<boolean> {
    try {
      const officeId = forOffice ?? this.cls.get('officeId');
      if (!officeId || this.cls.get('doNotTrack')) return true;
      const parsed = ProductEventSchema.parse({ event, props });
      // Also called before a tenant context exists (signup, the auth guard); the office id comes from the verified
      // token or the office just created, never from the request.
      // unscoped: writes and reads filtered by that office id only.
      const raw = this.prisma.unscoped();
      const settings = await raw.officeSettings.findUnique({
        where: { officeId },
        select: { enableProductAnalytics: true },
      });
      if (settings?.enableProductAnalytics === false) return true;
      await raw.productEvent.create({
        data: { officeId, event: parsed.event, props: parsed.props },
        select: { id: true },
      });
      return true;
    } catch (error) {
      this.logger.warn({ err: error, event }, 'Could not record a product event');
      return false;
    }
  }

  /**
   * After a case is created: the office's first one records the time since signup, later ones nothing.
   * shortcut: two first cases created at the same instant may both see 2 files and record none; metrics only.
   */
  async firstCase(): Promise<void> {
    try {
      const officeId = this.cls.get('officeId');
      if (!officeId || this.cls.get('doNotTrack')) return;
      // unscoped: counts the office's own files by its id (all of them, closed and deleted included).
      const raw = this.prisma.unscoped();
      const [office, files] = await Promise.all([
        raw.office.findUnique({ where: { id: officeId }, select: { createdAt: true } }),
        raw.legalFile.count({ where: { officeId } }),
      ]);
      if (!office || files !== 1) return;
      const secondsSinceSignup = Math.max(
        0,
        Math.floor((Date.now() - office.createdAt.getTime()) / 1000),
      );
      await this.track('FIRST_CASE_CREATED', { secondsSinceSignup }, officeId);
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not record the first case');
    }
  }

  /**
   * The activity retention is measured with: at most one APP_ACTIVE row per office and UTC day. Called by the auth
   * guard on every authenticated request, so a memo per process skips the query once the day is recorded.
   */
  async active(officeId: string, now = new Date()): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    try {
      if (this.cls.get('doNotTrack') || this.activeDay.get(officeId) === day) return;
      // unscoped: guard-time read before the tenant context exists, filtered by the token's own office.
      const seen = await this.prisma.unscoped().productEvent.findFirst({
        where: {
          officeId,
          event: 'APP_ACTIVE',
          createdAt: { gte: new Date(`${day}T00:00:00.000Z`) },
        },
        select: { id: true },
      });
      // Remembered only once the day is recorded: a failed write is retried on the next request.
      if (seen || (await this.track('APP_ACTIVE', {}, officeId))) {
        if (this.activeDay.size >= MEMO_LIMIT) this.activeDay.clear();
        this.activeDay.set(officeId, day);
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Could not record activity');
    }
  }
}
