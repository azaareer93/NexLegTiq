import { Injectable } from '@nestjs/common';
import type {
  AdminOfficeDetail,
  AdminOfficeListItem,
  AdminOfficeQuery,
} from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';

import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { PrismaService } from '../../database/prisma.service';
import type { ClientInfo } from '../auth/client-info';
import { PlatformAuditService } from '../platform-auth/platform-audit.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';

const MIB = 1024n * 1024n;

interface BaseRow {
  id: string;
  name: string;
  jurisdiction: AdminOfficeListItem['jurisdiction'];
  is_active: boolean;
  created_at: Date;
  plan_code: string | null;
  plan_name: string | null;
  sub_status: AdminOfficeListItem['subscriptionStatus'];
  total: bigint;
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The platform admin's view of offices (MVP-102): usage numbers, suspension and reactivation, all audited (D-145). */
@Injectable()
export class PlatformOfficesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(query: AdminOfficeQuery): Promise<PaginatedResult<AdminOfficeListItem>> {
    const offset = (query.page - 1) * query.limit;
    const { rows, total } = await this.base(query, null, query.limit, offset);
    const items = await this.withUsage(rows);
    return PaginatedResult.of(items, { page: query.page, limit: query.limit, total });
  }

  async get(id: string): Promise<AdminOfficeDetail> {
    const { rows } = await this.base({}, id, 1, 0);
    const [item] = await this.withUsage(rows);
    if (!item) throw new ResourceNotFoundException();
    // unscoped: platform admin code reads any office (D-080).
    const raw = this.prisma.unscoped();
    const office = await raw.office.findUniqueOrThrow({ where: { id } });
    const subscriptions = await raw.subscription.findMany({
      where: { officeId: id },
      orderBy: [{ currentPeriodStart: 'desc' }, { id: 'desc' }],
      include: { plan: { select: { code: true, name: true } } },
    });
    const suspended = office.isActive
      ? null
      : await raw.platformAuditLog.findFirst({
          where: { targetOfficeId: id, action: 'OFFICE_SUSPENDED' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
    const reason = (suspended?.newValues as { reason?: unknown } | null)?.reason;
    return {
      ...item,
      accountType: office.accountType,
      email: office.email,
      phone: office.phone,
      currency: office.currency,
      timezone: office.timezone,
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        plan: s.plan,
        status: s.status,
        currentPeriodStart: s.currentPeriodStart.toISOString(),
        // The contract wants a date; an open-ended period falls back to its start.
        currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
        trialEndsAt: s.trialEndsAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
      })),
      suspension: suspended
        ? {
            at: suspended.createdAt.toISOString(),
            reason: typeof reason === 'string' ? reason : '',
          }
        : null,
    };
  }

  /** Blocks every sign-in of the office (D-082) and ends its sessions; suspending a suspended office does nothing. */
  async suspend(
    id: string,
    reason: string,
    adminId: string,
    client: ClientInfo,
  ): Promise<AdminOfficeDetail> {
    await this.setActive(id, false, { reason }, adminId, client);
    return this.get(id);
  }

  async reactivate(
    id: string,
    reason: string | undefined,
    adminId: string,
    client: ClientInfo,
  ): Promise<AdminOfficeDetail> {
    await this.setActive(id, true, reason ? { reason } : {}, adminId, client);
    return this.get(id);
  }

  private async setActive(
    id: string,
    active: boolean,
    values: { reason?: string },
    adminId: string,
    client: ClientInfo,
  ): Promise<void> {
    // unscoped: platform admin code changes any office (D-080).
    const raw = this.prisma.unscoped();
    const changed = await raw.$transaction(async (tx) => {
      // Conditional update: a repeated or racing call changes (and audits) nothing.
      const { count } = await tx.office.updateMany({
        where: { id, isActive: !active },
        data: { isActive: active },
      });
      if (count === 0) return false;
      if (!active) {
        await tx.refreshToken.updateMany({
          where: { officeId: id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      await this.audit.log(
        {
          adminId,
          action: active ? 'OFFICE_REACTIVATED' : 'OFFICE_SUSPENDED',
          entityType: 'Office',
          entityId: id,
          targetOfficeId: id,
          newValues: values,
        },
        client,
        tx,
      );
      return true;
    });
    if (changed) {
      this.entitlements.invalidate(id as OfficeId);
      return;
    }
    // unscoped: see above.
    const exists = await raw.office.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new ResourceNotFoundException();
  }

  /** Offices of one page, with their current subscription (live, else newest: D-122). */
  private async base(
    q: Partial<AdminOfficeQuery>,
    id: string | null,
    limit: number,
    offset: number,
  ): Promise<{ rows: BaseRow[]; total: number }> {
    const search = q.search ? escapeLike(q.search) : null;
    const status = q.status ?? null;
    const plan = q.plan ?? null;
    const jurisdiction = q.jurisdiction ?? null;
    const from = q.createdFrom ?? null;
    const to = q.createdTo ?? null;
    // unscoped: platform admin code reads every office; every value is a bound parameter (D-080).
    const rows = await this.prisma.unscoped().$queryRaw<BaseRow[]>`
      WITH cur AS (
        SELECT DISTINCT ON (s.office_id) s.office_id, p.code, p.name, s.status::text AS status
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        ORDER BY s.office_id, (s.status IN ('TRIALING', 'ACTIVE')) DESC, s.current_period_start DESC, s.id DESC
      )
      SELECT o.id::text AS id, o.name, o.jurisdiction::text AS jurisdiction, o.is_active, o.created_at,
             cur.code AS plan_code, cur.name AS plan_name, cur.status AS sub_status, count(*) OVER () AS total
      FROM offices o LEFT JOIN cur ON cur.office_id = o.id
      WHERE (${id}::text IS NULL OR o.id::text = ${id}::text)
        AND (${search}::text IS NULL OR o.name ILIKE '%' || ${search}::text || '%')
        AND (${plan}::text IS NULL OR cur.code = ${plan}::text)
        AND (${status}::text IS NULL OR o.is_active = (${status}::text = 'ACTIVE'))
        AND (${jurisdiction}::text IS NULL OR o.jurisdiction::text = ${jurisdiction}::text)
        AND (${from}::text IS NULL OR o.created_at >= (${from}::text::date)::timestamp AT TIME ZONE 'UTC')
        AND (${to}::text IS NULL OR o.created_at < ((${to}::text::date) + 1)::timestamp AT TIME ZONE 'UTC')
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT ${limit} OFFSET ${offset}`;
    const total = rows[0] ? Number(rows[0].total) : 0;
    return { rows, total };
  }

  /** Usage for the page's offices in a few grouped queries (no per-row lookups). */
  private async withUsage(rows: BaseRow[]): Promise<AdminOfficeListItem[]> {
    if (rows.length === 0) return [];
    const officeId = { in: rows.map((r) => r.id) };
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    // unscoped: platform admin usage overview across offices (D-080).
    const raw = this.prisma.unscoped();
    const [users, files, bytes, ai, logins] = await Promise.all([
      raw.user.groupBy({
        by: ['officeId'],
        where: { officeId, isActive: true },
        _count: { _all: true },
      }),
      raw.legalFile.groupBy({
        by: ['officeId'],
        where: { officeId, deletedAt: null },
        _count: { _all: true },
      }),
      raw.documentVersion.groupBy({
        by: ['officeId'],
        where: { officeId },
        _sum: { sizeBytes: true },
      }),
      raw.aiUsage.groupBy({
        by: ['officeId'],
        // Same rule as the office's quota (D-144, D-148), with a UTC month.
        where: {
          officeId,
          cached: false,
          succeeded: true,
          partial: false,
          createdAt: { gte: monthStart },
        },
        _count: { _all: true },
      }),
      raw.user.groupBy({ by: ['officeId'], where: { officeId }, _max: { lastLoginAt: true } }),
    ]);
    const u = new Map(users.map((x) => [x.officeId, x._count._all]));
    const f = new Map(files.map((x) => [x.officeId, x._count._all]));
    const b = new Map(bytes.map((x) => [x.officeId, x._sum.sizeBytes ?? 0n]));
    const a = new Map(ai.map((x) => [x.officeId, x._count._all]));
    const l = new Map(logins.map((x) => [x.officeId, x._max.lastLoginAt]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      jurisdiction: r.jurisdiction,
      status: r.is_active ? 'ACTIVE' : 'SUSPENDED',
      createdAt: r.created_at.toISOString(),
      plan: r.plan_code ? { code: r.plan_code, name: r.plan_name ?? r.plan_code } : null,
      subscriptionStatus: r.sub_status,
      usage: {
        activeUsers: u.get(r.id) ?? 0,
        liveFiles: f.get(r.id) ?? 0,
        storageMb: Number(((b.get(r.id) ?? 0n) + MIB - 1n) / MIB),
        aiThisMonth: a.get(r.id) ?? 0,
      },
      lastActivityAt: l.get(r.id)?.toISOString() ?? null,
    }));
  }
}
