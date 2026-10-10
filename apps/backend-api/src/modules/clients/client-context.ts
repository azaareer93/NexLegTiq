import { Injectable } from '@nestjs/common';
import type { UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';

/** Fields never written to the audit log in clear: the log records that they changed, not their value. */
const SECRET_FIELDS = new Set(['nationalId', 'taxId']);

const redact = (values: Record<string, unknown> | null) =>
  values &&
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      SECRET_FIELDS.has(key) && value !== null ? '[encrypted]' : value,
    ]),
  );

/** Caller, office and audit rows for the clients and contacts services (MVP-53). */
@Injectable()
export class ClientContext {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  // A missing caller or office is a programming error (guarded routes always set them): 500 SYS-001.
  actorId(): UserId {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }

  officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }

  /**
   * Locks a live client of the office until the transaction ends (contacts of one client are written one at a time,
   * so "exactly one primary" holds), or 404 RES-001.
   */
  async lockClient(tx: ScopedTransaction, clientId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM clients
      WHERE id = ${clientId}::uuid AND office_id = ${this.officeId()}::uuid AND deleted_at IS NULL
      FOR UPDATE`;
    if (rows.length === 0) throw new ResourceNotFoundException();
  }

  auditRow(
    caller: ClientInfo,
    entityType: 'Client' | 'ContactPerson',
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    oldValues: Record<string, unknown> | null,
    newValues: Record<string, unknown> | null,
  ) {
    const before = redact(oldValues);
    const after = redact(newValues);
    return {
      officeId: this.officeId(),
      userId: this.actorId(),
      entityType,
      entityId,
      action,
      ...(before && { oldValues: JSON.parse(JSON.stringify(before)) as object }),
      ...(after && { newValues: JSON.parse(JSON.stringify(after)) as object }),
      ipAddress: caller.ip,
      userAgent: truncateUserAgent(caller.userAgent),
      requestId: caller.requestId,
    };
  }
}

/** The fields of `data` whose value differs from `before` (undefined = not sent). */
export function changedFields(before: Record<string, unknown>, data: Record<string, unknown>) {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || before[key] === value) continue;
    old[key] = before[key];
    next[key] = value;
  }
  return { old, next };
}
