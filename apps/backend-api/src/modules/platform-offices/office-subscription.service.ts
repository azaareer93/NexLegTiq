import { Injectable } from '@nestjs/common';
import type { SubscriptionActionRequest } from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { zonedDateTime } from '@nexlegtiq/shared-utils';

import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma, Subscription } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { PlatformAuditService } from '../platform-auth/platform-audit.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';

const DAY_MS = 86_400_000;
/** A typo such as 9999-12-31 must not grant access for good. */
const MAX_YEARS_AHEAD = 5;
/** Rows that still carry the office's access: they are changed in place; an ended one is followed by a new row. */
const CONTINUING = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE']);

/** The instant after the last day `until` (inclusive) in the office's time zone. */
export function endOfDay(until: string, timeZone: string): Date {
  const next = new Date(Date.parse(`${until}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  return new Date(zonedDateTime(next, '00:00', timeZone));
}

const AUDIT_ACTION = {
  CHANGE_PLAN: 'SUBSCRIPTION_PLAN_CHANGED',
  EXTEND_PERIOD: 'SUBSCRIPTION_EXTENDED',
  SET_TRIAL: 'SUBSCRIPTION_TRIAL_SET',
} as const;

const facts = (s: Subscription) => ({
  id: s.id,
  planId: s.planId,
  status: s.status,
  currentPeriodStart: s.currentPeriodStart.toISOString(),
  currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
  trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
});

/**
 * The platform admin's subscription actions (MVP-151, D-173) on the office's current subscription (the live one, else
 * the newest — D-122): change plan, extend the paid period, start or extend a trial. Payments never run these (owner,
 * 2026-11-14): the admin does, after recording one.
 */
@Injectable()
export class OfficeSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async apply(
    officeId: string,
    body: SubscriptionActionRequest,
    adminId: string,
    client: ClientInfo,
  ): Promise<void> {
    // unscoped: platform admin code changes any office's subscription (D-080).
    const changed = await this.prisma.unscoped().$transaction(async (tx) => {
      // The office row lock serialises two admins acting on one office (the partial unique index is the backstop).
      const [office] = await tx.$queryRaw<{ timezone: string }[]>`
        SELECT timezone FROM offices WHERE id = ${officeId}::uuid FOR UPDATE`;
      if (!office) throw new ResourceNotFoundException();
      const rows = await tx.subscription.findMany({
        where: { officeId },
        orderBy: [{ currentPeriodStart: 'desc' }, { id: 'desc' }],
      });
      const current = rows.find((r) => r.status === 'TRIALING' || r.status === 'ACTIVE') ?? rows[0];
      // Signup always creates one; an office without any has nothing to act on.
      if (!current) throw new ResourceNotFoundException();
      const after = await this.change(tx, current, body, office.timezone);
      if (!after) return false;
      await this.audit.log(
        {
          adminId,
          action: AUDIT_ACTION[body.action],
          entityType: 'Subscription',
          entityId: after.id,
          targetOfficeId: officeId,
          oldValues: facts(current),
          newValues: { ...facts(after), ...(body.reason ? { reason: body.reason.trim() } : {}) },
        },
        client,
        tx,
      );
      return true;
    });
    // shortcut: a request that read the old row just before the commit may cache it again for up to 30 s; move the
    // cache to Redis with versioned keys when a second API instance runs (see EntitlementsService).
    if (changed) this.entitlements.invalidate(officeId as OfficeId);
  }

  /** The row after the action, or null when nothing changes (the same plan again). */
  private async change(
    tx: Prisma.TransactionClient,
    current: Subscription,
    body: SubscriptionActionRequest,
    timeZone: string,
  ): Promise<Subscription | null> {
    if (body.action === 'CHANGE_PLAN') return this.changePlan(tx, current, body.planId);
    const limit = new Date();
    limit.setUTCFullYear(limit.getUTCFullYear() + MAX_YEARS_AHEAD);
    // Compared as dates before any conversion: a year such as 9999 has no next day to convert to.
    if (body.until > limit.toISOString().slice(0, 10)) {
      throw new ValidationException([{ field: 'until', message: 'validation.tooFar' }]);
    }
    const end = endOfDay(body.until, timeZone);
    if (end <= new Date()) {
      throw new ValidationException([{ field: 'until', message: 'validation.notPast' }]);
    }
    return body.action === 'EXTEND_PERIOD'
      ? this.extend(tx, current, end)
      : this.trial(tx, current, end);
  }

  private async changePlan(
    tx: Prisma.TransactionClient,
    current: Subscription,
    planId: string,
  ): Promise<Subscription | null> {
    if (planId === current.planId) return null;
    const plan = await tx.plan.findUnique({ where: { id: planId } });
    if (!plan?.isActive) {
      throw new ValidationException([{ field: 'planId', message: 'validation.planInactive' }]);
    }
    return tx.subscription.update({ where: { id: current.id }, data: { planId: plan.id } });
  }

  /** A row still marked live whose trial or period has already ended (nothing writes EXPIRED: D-122 derives it). */
  private lapsed(row: Subscription): boolean {
    const end =
      row.status === 'TRIALING' ? (row.trialEndsAt ?? row.currentPeriodEnd) : row.currentPeriodEnd;
    return (
      (row.status === 'TRIALING' || row.status === 'ACTIVE') && end !== null && end <= new Date()
    );
  }

  /** Paid until `end`: a trial turning paid or a lapsed period starts again now; a running paid one keeps its start. */
  private extend(
    tx: Prisma.TransactionClient,
    current: Subscription,
    end: Date,
  ): Promise<Subscription> {
    const now = new Date();
    const data = { status: 'ACTIVE' as const, currentPeriodEnd: end };
    if (!CONTINUING.has(current.status)) {
      return tx.subscription.create({
        data: {
          ...data,
          officeId: current.officeId,
          planId: current.planId,
          currentPeriodStart: now,
        },
      });
    }
    return tx.subscription.update({
      where: { id: current.id },
      data:
        current.status === 'TRIALING' || this.lapsed(current)
          ? { ...data, currentPeriodStart: now }
          : data,
    });
  }

  /** A trial until `end`: extends a running one, starts a new one after an ended subscription, never on a paid one. */
  private trial(
    tx: Prisma.TransactionClient,
    current: Subscription,
    end: Date,
  ): Promise<Subscription> {
    if (current.status === 'TRIALING') {
      return tx.subscription.update({ where: { id: current.id }, data: { trialEndsAt: end } });
    }
    if (this.lapsed(current)) {
      // The row is still marked live (partial unique index): it becomes the new trial in place.
      return tx.subscription.update({
        where: { id: current.id },
        data: {
          status: 'TRIALING',
          currentPeriodStart: new Date(),
          currentPeriodEnd: null,
          trialEndsAt: end,
        },
      });
    }
    if (CONTINUING.has(current.status)) {
      throw new BusinessRuleException('BIZ-023', 'A paid subscription cannot be put on trial');
    }
    return tx.subscription.create({
      data: {
        officeId: current.officeId,
        planId: current.planId,
        status: 'TRIALING',
        currentPeriodStart: new Date(),
        trialEndsAt: end,
      },
    });
  }
}
