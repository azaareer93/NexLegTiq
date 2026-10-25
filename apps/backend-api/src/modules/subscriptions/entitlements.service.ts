import { Injectable } from '@nestjs/common';
import type { PlanFeature } from '@nexlegtiq/shared-contracts';
import type { AiUsageSummary } from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { wallClock, zonedDateTime } from '@nexlegtiq/shared-utils';
import { ClsService } from 'nestjs-cls';

import { resolveEntitlements } from './entitlements';
import type { Entitlements } from './entitlements';
import { StorageUsageService } from './storage-usage.service';
import { SubscriptionsRepository } from './subscriptions.repository';
import type { RequestContext } from '../../common/context/request-context';
import { AppException, BusinessRuleException } from '../../common/errors/app.exception';

const CACHE_MS = 30_000;
const MIB = 1024n * 1024n;

/**
 * Plan limits and feature flags of an office (D-005, D-122), resolved from its subscription + plan, and the quota checks
 * features call before they add users, bytes or AI requests.
 */
@Injectable()
export class EntitlementsService {
  // shortcut: per-process cache (one API container, D-020) without invalidation from other processes; a plan change
  // applies within 30 s. Move to Redis (`o:{officeId}:entitlements`, D-058) when the admin panel edits plans or a second
  // API instance runs.
  private readonly cache = new Map<string, { value: Entitlements; until: number }>();

  constructor(
    private readonly subscriptions: SubscriptionsRepository,
    private readonly cls: ClsService<RequestContext>,
    private readonly storage: StorageUsageService,
  ) {}

  /** Also used by the subscription guard, which runs before the request's tenant context exists. */
  async forOffice(officeId: OfficeId): Promise<Entitlements> {
    const now = Date.now();
    const hit = this.cache.get(officeId);
    if (hit && hit.until > now) return hit.value;
    this.cache.delete(officeId);
    const rows = await this.subscriptions.subscriptionOf(officeId);
    const value = resolveEntitlements(rows, new Date(now));
    this.cache.set(officeId, { value, until: now + CACHE_MS });
    return value;
  }

  /** Drops the cached entitlements, e.g. after the office's subscription changed in this process. */
  invalidate(officeId: OfficeId): void {
    this.cache.delete(officeId);
  }

  current(): Promise<Entitlements> {
    return this.forOffice(this.officeId());
  }

  /** 403 AUTH-102 unless the office's plan includes the feature. */
  async assertFeature(feature: PlanFeature): Promise<void> {
    if (!(await this.current()).features[feature]) {
      throw new AppException('AUTH-102', `Plan does not include ${feature}`);
    }
  }

  /** 422 BIZ-008 when adding a user (an invitation) would exceed `maxUsers`; pending invitations count as seats. */
  async assertUserSlot(): Promise<void> {
    const { maxUsers } = await this.current();
    if (maxUsers === null) return;
    if ((await this.seatsTaken()) >= maxUsers) {
      throw new BusinessRuleException('BIZ-008', 'User limit of the plan reached');
    }
  }

  /** 403 AUTH-103 when storing `bytes` more would exceed the plan's storage quota. */
  async assertStorageFor(bytes: bigint): Promise<void> {
    const { storageQuotaMb } = await this.current();
    if ((await this.storage.usedBytes()) + bytes > BigInt(storageQuotaMb) * MIB) {
      throw new AppException('AUTH-103', 'Storage quota of the plan reached');
    }
  }

  /**
   * 403 AUTH-103 when the office has used its monthly AI operations (D-130, D-144); the detail says none remain and when
   * the quota resets, so the app can tell the user.
   */
  async assertAiQuota(): Promise<void> {
    const usage = await this.aiUsage();
    if (usage.remaining === 0) {
      throw new AppException('AUTH-103', 'Monthly AI quota of the plan reached', [
        {
          field: 'aiQuota',
          message: 'validation.aiQuotaReached',
          params: { remaining: '0', quota: String(usage.quota), resetsAt: usage.resetsAt },
        },
      ]);
    }
  }

  /** This month's AI use against the plan (D-144): `quota`/`remaining` null = unlimited. */
  async aiUsage(now = new Date()): Promise<AiUsageSummary> {
    const [{ aiQuotaMonthly: quota }, month] = await Promise.all([
      this.current(),
      this.aiMonth(now),
    ]);
    const used = await this.subscriptions.aiCallsSince(month.start);
    return {
      used,
      quota,
      remaining: quota === null ? null : Math.max(0, quota - used),
      resetsAt: month.resetsAt.toISOString(),
    };
  }

  /** The office's calendar month around `now`, in its own time zone (D-092, D-144). */
  async aiMonth(now = new Date()): Promise<{ readonly start: Date; readonly resetsAt: Date }> {
    const zone = await this.subscriptions.officeTimeZone();
    const [year = 0, month = 1] = wallClock(now, zone).date.split('-').map(Number);
    const first = (y: number, m: number) =>
      new Date(zonedDateTime(`${y}-${String(m).padStart(2, '0')}-01`, '00:00', zone));
    return {
      start: first(year, month),
      resetsAt: month === 12 ? first(year + 1, 1) : first(year, month + 1),
    };
  }

  /** Active users, for the usage view. */
  activeUsers(): Promise<number> {
    return this.subscriptions.activeUsers();
  }

  /** Successful AI operations this month (office time zone), for the quota and the usage view. */
  async aiCallsThisMonth(now = new Date()): Promise<number> {
    return this.subscriptions.aiCallsSince((await this.aiMonth(now)).start);
  }

  /** Storage used in whole MiB, rounded up (a 1-byte file counts as 1 MB). */
  async storageMb(): Promise<number> {
    const used = await this.storage.usedBytes();
    return Number((used + MIB - 1n) / MIB);
  }

  private async seatsTaken(): Promise<number> {
    const [users, invitations] = await Promise.all([
      this.activeUsers(),
      this.subscriptions.pendingInvitations(new Date()),
    ]);
    return users + invitations;
  }

  // A missing office is a programming error (guarded routes always set it): 500 SYS-001.
  private officeId(): OfficeId {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}
