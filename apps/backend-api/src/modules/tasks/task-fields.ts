import type { TaskQuery } from '@nexlegtiq/shared-contracts';

import { toDbDate } from './tasks.repository';
import { auditRow } from '../../common/audit/audit.service';
import type { ClientInfo } from '../../common/context/client-info';
import type { Prisma } from '../../generated/prisma/client';

/** `dueFrom`/`dueBefore` as a calendar-date range, both days included (D-155). */
export function dueRange({ dueFrom, dueBefore }: TaskQuery): Prisma.TaskWhereInput {
  if (!dueFrom && !dueBefore) return {};
  return {
    dueDate: {
      ...(dueFrom && { gte: toDbDate(dueFrom) }),
      ...(dueBefore && { lte: toDbDate(dueBefore) }),
    },
  };
}

/** The fields of `wanted` whose value differs from `current` (both plain values: dates as `YYYY-MM-DD`). */
export function changes(current: Record<string, unknown>, wanted: Record<string, unknown>) {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(wanted)) {
    if (value !== undefined && current[key] !== value) {
      old[key] = current[key];
      next[key] = value;
    }
  }
  return { old, next };
}

export const toDbDateOrNull = (value: unknown): Date | null =>
  typeof value === 'string' ? toDbDate(value) : null;

export type AuditChange = [
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  oldValues: object | null,
  newValues: object | null,
];

/** The audit row of a task change by `userId`. */
export function taskAuditRow(
  officeId: string,
  userId: string,
  client: ClientInfo,
  entityId: string,
  ...[action, oldValues, newValues]: AuditChange
) {
  return auditRow(
    { officeId, userId, entityType: 'Task', entityId, action, oldValues, newValues },
    client,
  );
}
