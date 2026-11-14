import { Injectable } from '@nestjs/common';
import type { AdminPlan, CreatePlanRequest, UpdatePlanRequest } from '@nexlegtiq/shared-contracts';

import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import type { Plan } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { PlatformAuditService } from '../platform-auth/platform-audit.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';

type PlanRow = Plan & { _count: { subscriptions: number } };
const WITH_COUNT = { _count: { select: { subscriptions: true } } } as const;

/** Audit values: the plan's editable fields, money as a decimal string. */
const snapshot = (plan: Plan) => ({
  code: plan.code,
  name: plan.name,
  market: plan.market,
  priceMonthly: plan.priceMonthly.toFixed(2),
  currency: plan.currency,
  maxUsers: plan.maxUsers,
  aiQuotaMonthly: plan.aiQuotaMonthly,
  ocrPagesMonthly: plan.ocrPagesMonthly,
  storageQuotaMb: plan.storageQuotaMb,
  trialDays: plan.trialDays,
  features: plan.features as Record<string, boolean>,
  isActive: plan.isActive,
  sortOrder: plan.sortOrder,
});

const toDto = (plan: PlanRow): AdminPlan => ({
  id: plan.id,
  ...snapshot(plan),
  subscriptionCount: plan._count.subscriptions,
  createdAt: plan.createdAt.toISOString(),
  updatedAt: plan.updatedAt.toISOString(),
});

/** Plans CRUD for the platform admin (MVP-151, D-005, D-173): every change audited, cached entitlements dropped. */
@Injectable()
export class PlatformPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(): Promise<AdminPlan[]> {
    // unscoped: plans are global and only the platform admin edits them (D-080).
    const plans = await this.prisma.unscoped().plan.findMany({
      orderBy: [{ market: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
      include: WITH_COUNT,
    });
    return plans.map(toDto);
  }

  async create(body: CreatePlanRequest, adminId: string, client: ClientInfo): Promise<AdminPlan> {
    // unscoped: see list. A taken code is 409 RES-002 (unique index).
    const plan = await this.prisma.unscoped().$transaction(async (tx) => {
      const created = await tx.plan.create({ data: body, include: WITH_COUNT });
      await this.audit.log(
        {
          adminId,
          action: 'PLAN_CREATED',
          entityType: 'Plan',
          entityId: created.id,
          newValues: snapshot(created),
        },
        client,
        tx,
      );
      return created;
    });
    return toDto(plan);
  }

  async update(
    id: string,
    body: UpdatePlanRequest,
    adminId: string,
    client: ClientInfo,
  ): Promise<AdminPlan> {
    // unscoped: see list.
    const plan = await this.prisma.unscoped().$transaction(async (tx) => {
      const before = await tx.plan.findUnique({ where: { id } });
      if (!before) throw new ResourceNotFoundException();
      const after = await tx.plan.update({ where: { id }, data: body, include: WITH_COUNT });
      await this.audit.log(
        {
          adminId,
          action: 'PLAN_UPDATED',
          entityType: 'Plan',
          entityId: id,
          oldValues: snapshot(before),
          newValues: snapshot(after),
        },
        client,
        tx,
      );
      return after;
    });
    // Every office on this plan sees the new limits at once.
    this.entitlements.invalidateAll();
    return toDto(plan);
  }

  /** Only a plan no subscription ever used: history must keep its plan (deactivate it instead, BIZ-022). */
  async remove(id: string, adminId: string, client: ClientInfo): Promise<void> {
    // unscoped: see list.
    await this.prisma.unscoped().$transaction(async (tx) => {
      const plan = await tx.plan.findUnique({ where: { id }, include: WITH_COUNT });
      if (!plan) throw new ResourceNotFoundException();
      if (plan._count.subscriptions > 0) {
        throw new BusinessRuleException('BIZ-022', 'The plan is in use by a subscription');
      }
      // A subscription created meanwhile makes the delete fail on its foreign key: it never loses its plan.
      await tx.plan.delete({ where: { id } });
      await this.audit.log(
        {
          adminId,
          action: 'PLAN_DELETED',
          entityType: 'Plan',
          entityId: id,
          oldValues: snapshot(plan),
        },
        client,
        tx,
      );
    });
  }
}
