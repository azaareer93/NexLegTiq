import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { FUNNEL_EVENTS } from '@nexlegtiq/shared-contracts';
import type {
  AdminAnalytics,
  AdminAuditEntry,
  AdminAuditExportQuery,
  AdminAuditPage,
  AdminAuditQuery,
  AdminQueue,
  AdminUsage,
} from '@nexlegtiq/shared-contracts';
import { ONBOARDING_STEPS } from '@nexlegtiq/shared-types';

import { BusinessRuleException } from '../../common/errors/app.exception';
import { getQueue, QUEUE_NAMES } from '../../common/queue/queues';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { BOM, csvCell } from '../audit-log/audit-csv';
import { EXPORT_MAX_ROWS } from '../audit-log/audit-log.service';

const DAY_MS = 86_400_000;
const TOP = 20;
const NO_COHORT = { offices: 0, retained: 0 };
type Filters = Omit<AdminAuditQuery, 'cursor' | 'limit'>;

const ROW_SELECT = {
  id: true,
  createdAt: true,
  action: true,
  entityType: true,
  entityId: true,
  targetOfficeId: true,
  oldValues: true,
  newValues: true,
  admin: { select: { id: true, fullName: true } },
} as const;
type Row = Prisma.PlatformAuditLogGetPayload<{ select: typeof ROW_SELECT }>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function toAdminEntry(row: Row, offices: Map<string, string>): AdminAuditEntry {
  const before = isRecord(row.oldValues) ? row.oldValues : {};
  const after = isRecord(row.newValues) ? row.newValues : {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return {
    id: row.id,
    occurredAt: row.createdAt.toISOString(),
    admin: row.admin ? { id: row.admin.id, name: row.admin.fullName } : null,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    office: row.targetOfficeId
      ? { id: row.targetOfficeId, name: offices.get(row.targetOfficeId) ?? '' }
      : null,
    changes: fields.map((field) => ({
      field,
      old: before[field] ?? null,
      new: after[field] ?? null,
    })),
  };
}

const CSV_HEADER = ['occurredAt', 'admin', 'action', 'office', 'entityType', 'entityId', 'changes'];

/**
 * Platform usage and health (MVP-103, D-183), read across offices on the raw client by the platform realm (D-145):
 * counts and sums only, never office content.
 */
@Injectable()
export class PlatformUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async usage(days: number, now = new Date()): Promise<AdminUsage> {
    // unscoped: the platform realm reads across offices (D-145), counts and admin rows only.
    const raw = this.prisma.unscoped();
    const since = new Date(now.getTime() - days * DAY_MS);
    const [byDay, byOffice, storage, daily, weekly, offices] = await Promise.all([
      raw.$queryRaw<{ date: string; cost: string; ops: number }[]>`
        SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               sum(cost_usd)::text AS cost, count(*)::int AS ops
        FROM ai_usages WHERE created_at >= ${since} GROUP BY 1 ORDER BY 1`,
      raw.aiUsage.groupBy({
        by: ['officeId', 'model'],
        where: { createdAt: { gte: since } },
        _sum: { costUsd: true },
        _count: { _all: true },
        orderBy: { _sum: { costUsd: 'desc' } },
        take: TOP,
      }),
      raw.documentVersion.groupBy({
        by: ['officeId'],
        _sum: { sizeBytes: true },
        orderBy: { _sum: { sizeBytes: 'desc' } },
        take: TOP,
      }),
      raw.user.count({
        where: { isActive: true, lastLoginAt: { gte: new Date(now.getTime() - DAY_MS) } },
      }),
      raw.user.count({
        where: { isActive: true, lastLoginAt: { gte: new Date(now.getTime() - 7 * DAY_MS) } },
      }),
      raw.office.findMany({ where: { createdAt: { gte: since } }, select: { id: true } }),
    ]);
    const ids = offices.map((o) => o.id);
    const [verified, withCase] = ids.length
      ? await Promise.all([
          raw.office.count({
            where: {
              id: { in: ids },
              users: { some: { role: 'OFFICE_MANAGER', emailVerifiedAt: { not: null } } },
            },
          }),
          raw.office.count({ where: { id: { in: ids }, legalFiles: { some: {} } } }),
        ])
      : [0, 0];
    const names = await this.officeNames([
      ...byOffice.map((r) => r.officeId),
      ...storage.map((r) => r.officeId),
    ]);
    return {
      since: since.toISOString().slice(0, 10),
      aiCostByDay: byDay.map((r) => ({ date: r.date, costUsd: r.cost, operations: r.ops })),
      aiCostByOffice: byOffice.map((r) => ({
        officeId: r.officeId,
        officeName: names.get(r.officeId) ?? '',
        model: r.model,
        costUsd: (r._sum.costUsd ?? 0).toString(),
        operations: r._count._all,
      })),
      storageByOffice: storage.map((r) => ({
        officeId: r.officeId,
        officeName: names.get(r.officeId) ?? '',
        bytes: (r._sum.sizeBytes ?? 0n).toString(),
      })),
      activeUsers: { daily, weekly },
      signups: { offices: ids.length, verified, withCase },
    };
  }

  /**
   * Onboarding funnel and retention (D-215) of the offices whose first SIGNUP_COMPLETED falls in the last `days` days:
   * offices per funnel event and per onboarding step, the median time to the first case, and D7/D30 retention (any
   * APP_ACTIVE on days 7–13 / 30–36 after signup, counted only once that window has ended).
   */
  async analytics(days: number, now = new Date()): Promise<AdminAnalytics> {
    const since = new Date(now.getTime() - days * DAY_MS);
    const cohort = Prisma.sql`
      SELECT office_id, min(created_at) AS signed_up FROM product_events
      WHERE event = 'SIGNUP_COMPLETED' GROUP BY office_id HAVING min(created_at) >= ${since}`;
    // unscoped: the platform realm reads across offices (D-145), counts only.
    const raw = this.prisma.unscoped();
    const [events, steps, [median], [retention]] = await Promise.all([
      raw.$queryRaw<{ event: string; offices: number }[]>`
        WITH c AS (${cohort})
        SELECT e.event::text AS event, count(DISTINCT e.office_id)::int AS offices
        FROM product_events e JOIN c ON c.office_id = e.office_id GROUP BY 1`,
      raw.$queryRaw<{ step: string; offices: number }[]>`
        WITH c AS (${cohort})
        SELECT e.props->>'step' AS step, count(DISTINCT e.office_id)::int AS offices
        FROM product_events e JOIN c ON c.office_id = e.office_id
        WHERE e.event = 'ONBOARDING_STEP_COMPLETED' GROUP BY 1`,
      raw.$queryRaw<{ seconds: number | null }[]>`
        WITH c AS (${cohort})
        SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (e.props->>'secondsSinceSignup')::int))::int AS seconds
        FROM product_events e JOIN c ON c.office_id = e.office_id WHERE e.event = 'FIRST_CASE_CREATED'`,
      raw.$queryRaw<AdminAnalytics['retention'][]>`
        WITH c AS (${cohort}), r AS (
          SELECT c.signed_up,
            EXISTS (SELECT 1 FROM product_events a WHERE a.office_id = c.office_id AND a.event = 'APP_ACTIVE'
              AND a.created_at >= c.signed_up + interval '7 days' AND a.created_at < c.signed_up + interval '14 days') AS w7,
            EXISTS (SELECT 1 FROM product_events a WHERE a.office_id = c.office_id AND a.event = 'APP_ACTIVE'
              AND a.created_at >= c.signed_up + interval '30 days' AND a.created_at < c.signed_up + interval '37 days') AS w30
          FROM c)
        SELECT json_build_object(
            'offices', count(*) FILTER (WHERE signed_up <= ${now}::timestamptz - interval '14 days'),
            'retained', count(*) FILTER (WHERE signed_up <= ${now}::timestamptz - interval '14 days' AND w7)) AS d7,
          json_build_object(
            'offices', count(*) FILTER (WHERE signed_up <= ${now}::timestamptz - interval '37 days'),
            'retained', count(*) FILTER (WHERE signed_up <= ${now}::timestamptz - interval '37 days' AND w30)) AS d30
        FROM r`,
    ]);
    const offices = new Map(events.map((r) => [r.event, r.offices]));
    const byStep = new Map(steps.map((r) => [r.step, r.offices]));
    return {
      since: since.toISOString().slice(0, 10),
      funnel: FUNNEL_EVENTS.map((event) => ({ event, offices: offices.get(event) ?? 0 })),
      onboardingSteps: ONBOARDING_STEPS.map((step) => ({ step, offices: byStep.get(step) ?? 0 })),
      // Aggregates without GROUP BY always return one row.
      medianSecondsToFirstCase: median?.seconds ?? null,
      retention: retention ?? { d7: NO_COHORT, d30: NO_COHORT },
    };
  }

  /** Job counts per queue; a queue Redis cannot answer for shows zeros rather than failing the page. */
  async queues(): Promise<AdminQueue[]> {
    return Promise.all(
      QUEUE_NAMES.map(async (name) => {
        const counts = await getQueue(this.moduleRef, name)
          .getJobCounts('waiting', 'active', 'delayed', 'failed')
          .catch(() => ({}) as Record<string, number>);
        return {
          name,
          waiting: counts['waiting'] ?? 0,
          active: counts['active'] ?? 0,
          delayed: counts['delayed'] ?? 0,
          failed: counts['failed'] ?? 0,
        };
      }),
    );
  }

  /** The platform audit log (what platform staff did, sign-ins included), newest first. */
  async audit(query: AdminAuditQuery): Promise<AdminAuditPage> {
    // unscoped: the platform realm reads across offices (D-145), counts and admin rows only.
    const rows = await this.prisma.unscoped().platformAuditLog.findMany({
      where: this.where(query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: ROW_SELECT,
    });
    const page = rows.slice(0, query.limit);
    const offices = await this.officeNames(
      page.flatMap((r) => (r.targetOfficeId ? [r.targetOfficeId] : [])),
    );
    return {
      items: page.map((row) => toAdminEntry(row, offices)),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** The platform audit as CSV (UTC times; at most 10,000 rows, else 422 BIZ-025). */
  async exportCsv(query: AdminAuditExportQuery): Promise<string> {
    // unscoped: the platform realm reads across offices (D-145), counts and admin rows only.
    const rows = await this.prisma.unscoped().platformAuditLog.findMany({
      where: this.where(query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: EXPORT_MAX_ROWS + 1,
      select: ROW_SELECT,
    });
    if (rows.length > EXPORT_MAX_ROWS) {
      throw new BusinessRuleException('BIZ-025', 'Too many audit rows for one export');
    }
    const offices = await this.officeNames(
      rows.flatMap((r) => (r.targetOfficeId ? [r.targetOfficeId] : [])),
    );
    const lines = rows.map((row) => {
      const e = toAdminEntry(row, offices);
      return [
        e.occurredAt.replace('T', ' ').slice(0, 16),
        e.admin?.name,
        e.action,
        e.office?.name,
        e.entityType,
        e.entityId,
        e.changes.length ? JSON.stringify(e.changes) : '',
      ]
        .map(csvCell)
        .join(',');
    });
    const crlf = String.fromCharCode(13, 10);
    return `${BOM}${[CSV_HEADER.map(csvCell).join(','), ...lines].join(crlf)}${crlf}`;
  }

  private where({
    officeId,
    adminId,
    action,
    from,
    to,
  }: Filters): Prisma.PlatformAuditLogWhereInput {
    return {
      ...(officeId ? { targetOfficeId: officeId } : {}),
      ...(adminId ? { adminId } : {}),
      ...(action ? { action } : {}),
      // UTC days: the platform spans offices in several zones.
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
              ...(to ? { lt: new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS) } : {}),
            },
          }
        : {}),
    };
  }

  private async officeNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    // unscoped: the platform realm reads across offices (D-145), counts and admin rows only.
    const rows = await this.prisma.unscoped().office.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((o) => [o.id, o.name]));
  }
}
