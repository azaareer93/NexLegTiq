import type { PlanFeature } from '@nexlegtiq/shared-contracts';
import { PLAN_FEATURES } from '@nexlegtiq/shared-contracts';
import type { SubscriptionStatus } from '@nexlegtiq/shared-types';

/** What `resolveEntitlements` needs of a subscription row and its plan. */
export interface SubscriptionRow {
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date | null;
  readonly trialEndsAt: Date | null;
  readonly plan: {
    readonly code: string;
    readonly name: string;
    readonly maxUsers: number | null;
    readonly aiQuotaMonthly: number | null;
    readonly storageQuotaMb: number;
    readonly features: unknown;
  };
}

/** An office's limits and flags from its subscription + plan (D-005, D-122). A `null` limit is unlimited. */
export interface Entitlements {
  readonly plan: { readonly code: string; readonly name: string } | null;
  /** Effective status: a trial or period that has ended is EXPIRED, whatever the row still says. */
  readonly status: SubscriptionStatus;
  /** GETs only: writes are refused with 403 AUTH-104. */
  readonly readOnly: boolean;
  readonly periodEnd: Date | null;
  readonly trialEndsAt: Date | null;
  readonly maxUsers: number | null;
  readonly storageQuotaMb: number;
  readonly aiQuotaMonthly: number | null;
  readonly features: Readonly<Record<PlanFeature, boolean>>;
}

/**
 * A flag a plan's `features` does not set (D-122). AI and the client portal are MVP features of every plan (D-002); the
 * paid Google Vision OCR fallback must be switched on per plan.
 */
export const FEATURE_DEFAULTS: Readonly<Record<PlanFeature, boolean>> = {
  ai: true,
  clientPortal: true,
  googleVisionOcr: false,
};

/** Statuses that keep full access. PAST_DUE is a grace period: the platform admin ends it (EXPIRED or CANCELLED). */
const FULL_ACCESS: ReadonlySet<SubscriptionStatus> = new Set(['TRIALING', 'ACTIVE', 'PAST_DUE']);

/** Without any subscription (never the case after signup) the office is read-only and has nothing. */
const NO_SUBSCRIPTION: Entitlements = {
  plan: null,
  status: 'EXPIRED',
  readOnly: true,
  periodEnd: null,
  trialEndsAt: null,
  maxUsers: 0,
  storageQuotaMb: 0,
  aiQuotaMonthly: 0,
  features: { ai: false, clientPortal: false, googleVisionOcr: false },
};

/**
 * `rows`: the office's subscriptions, newest first. The live one (TRIALING/ACTIVE, at most one — D-079) wins, else the
 * newest, so an ended office still shows its last plan.
 */
export function resolveEntitlements(rows: readonly SubscriptionRow[], now: Date): Entitlements {
  const row = rows.find((r) => r.status === 'TRIALING' || r.status === 'ACTIVE') ?? rows[0];
  if (!row) return NO_SUBSCRIPTION;
  const end =
    row.status === 'TRIALING' ? (row.trialEndsAt ?? row.currentPeriodEnd) : row.currentPeriodEnd;
  const ended =
    (row.status === 'TRIALING' || row.status === 'ACTIVE') && end !== null && end <= now;
  const status = ended ? 'EXPIRED' : row.status;
  return {
    plan: { code: row.plan.code, name: row.plan.name },
    status,
    readOnly: !FULL_ACCESS.has(status),
    periodEnd: row.currentPeriodEnd,
    trialEndsAt: row.trialEndsAt,
    maxUsers: row.plan.maxUsers,
    storageQuotaMb: row.plan.storageQuotaMb,
    aiQuotaMonthly: row.plan.aiQuotaMonthly,
    features: featuresOf(row.plan.features),
  };
}

/** `Plan.features` is admin-edited JSON: only boolean flags count, unknown keys (e.g. `customPricing`) are ignored. */
function featuresOf(raw: unknown): Record<PlanFeature, boolean> {
  const flags = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    PLAN_FEATURES.map((feature) => {
      const value = flags[feature];
      return [feature, typeof value === 'boolean' ? value : FEATURE_DEFAULTS[feature]];
    }),
  ) as Record<PlanFeature, boolean>;
}
