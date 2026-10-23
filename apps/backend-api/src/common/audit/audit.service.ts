import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { AuditAction, Prisma } from '../../generated/prisma/client';
import type { RequestContext } from '../context/request-context';

/** The user agent stored on audit rows is capped (D-081). */
const MAX_USER_AGENT = 512;
/** One VIEW row per user and entity in this window (MVP-104): reading a file all day is one fact, not hundreds. */
export const VIEW_THROTTLE_MS = 10 * 60_000;

/** Values never written in clear: encrypted identifiers (D-056) and credentials. The log records that they changed. */
const ENCRYPTED_FIELDS = new Set(['nationalId', 'taxId']);
const SECRET_FIELDS = new Set([
  'password',
  'passwordHash',
  'currentPassword',
  'newPassword',
  'token',
  'tokenHash',
  'refreshToken',
  'mfaSecret',
]);

/** Request facts for a row written outside a request (or for another actor): every field overrides the CLS. */
export interface AuditClient {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

export interface AuditEntry {
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly action: AuditAction;
  readonly oldValues?: object | null;
  readonly newValues?: object | null;
  /** Defaults to the request's office. */
  readonly officeId?: string;
  /** Defaults to the request's user; `null` for the system (worker) or before sign-in. */
  readonly userId?: string | null;
}

/** Copies `values` with secrets replaced: `[encrypted]` for encrypted identifiers, `[redacted]` for credentials. */
export function redact(values: object | null | undefined): Prisma.InputJsonObject | undefined {
  if (!values) return undefined;
  const entries = Object.entries(values as Record<string, unknown>).map(
    ([key, value]): [string, unknown] => {
      if (value === null || value === undefined) return [key, null];
      if (ENCRYPTED_FIELDS.has(key)) return [key, '[encrypted]'];
      if (SECRET_FIELDS.has(key)) return [key, '[redacted]'];
      return [key, value];
    },
  );
  // Through JSON: dates become ISO strings and decimals plain values, as stored in a JSON column.
  return JSON.parse(JSON.stringify(Object.fromEntries(entries))) as Prisma.InputJsonObject;
}

/**
 * An audit row with every field resolved (D-136): values redacted, user agent capped, missing request facts null. For
 * code that knows its office and actor (services with their own context, sign-in before a session exists).
 */
export function auditRow(
  entry: AuditEntry & { readonly officeId: string; readonly userId: string | null },
  client: AuditClient,
): Prisma.AuditLogUncheckedCreateInput {
  const oldValues = redact(entry.oldValues);
  const newValues = redact(entry.newValues);
  return {
    officeId: entry.officeId,
    userId: entry.userId,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    action: entry.action,
    ...(oldValues && { oldValues }),
    ...(newValues && { newValues }),
    ipAddress: client.ip ?? null,
    userAgent: client.userAgent ? client.userAgent.slice(0, MAX_USER_AGENT) : null,
    requestId: client.requestId ?? null,
  };
}

/**
 * The one way to write the audit log (MVP-104, D-136): actor, office, IP, user agent and request id come from the request
 * context (an `AuditClient` overrides them), values go through `redact`, and the row is written in the caller's
 * transaction so it commits or rolls back with the change it records. The table is append-only for the app role; only
 * the retention purge (a SECURITY DEFINER function) removes rows.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
  ) {}

  /** The row for `entry`; for callers that batch it with other writes. */
  row(entry: AuditEntry, client: AuditClient = {}): Prisma.AuditLogUncheckedCreateInput {
    const store: Partial<RequestContext> & { requestId?: string } = this.cls.isActive()
      ? { ...this.cls.get(), requestId: this.cls.getId() }
      : {};
    const officeId = entry.officeId ?? store.officeId;
    if (!officeId) throw new Error('No office for the audit row');
    // An explicit value (null included) wins over the request context.
    const or = <T>(given: T | undefined, fallback: T | undefined) =>
      given !== undefined ? given : fallback;
    return auditRow(
      { ...entry, officeId, userId: or(entry.userId, store.userId) ?? null },
      {
        ip: or(client.ip, store.ip),
        userAgent: or(client.userAgent, store.userAgent),
        requestId: or(client.requestId, store.requestId),
      },
    );
  }

  async log(
    tx: Pick<ScopedTransaction, 'auditLog'>,
    entry: AuditEntry,
    client?: AuditClient,
  ): Promise<void> {
    await tx.auditLog.create({ data: this.row(entry, client) });
  }

  /**
   * A VIEW of a legal file or document by the current user, at most once per user and entity every 10 minutes. Not part
   * of a write: a failure is the caller's to swallow or not (reads should not fail because of it).
   */
  async view(entityType: 'LegalFile' | 'Document', entityId: string): Promise<boolean> {
    const userId = this.cls.get('userId');
    if (!userId) return false;
    const recent = await this.prisma.db.auditLog.findFirst({
      where: {
        entityType,
        entityId,
        userId,
        action: 'VIEW',
        occurredAt: { gte: new Date(Date.now() - VIEW_THROTTLE_MS) },
      },
      select: { id: true },
    });
    if (recent) return false;
    await this.log(this.prisma.db, { entityType, entityId, action: 'VIEW' });
    return true;
  }
}
