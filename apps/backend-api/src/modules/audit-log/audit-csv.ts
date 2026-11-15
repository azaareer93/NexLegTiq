import type { AuditEntry } from '@nexlegtiq/shared-contracts';
import { wallClock } from '@nexlegtiq/shared-utils';

/** The byte-order mark Excel needs to read UTF-8 (Arabic) correctly. */
export const BOM = String.fromCharCode(0xfeff);
const HEADER = ['occurredAt', 'actorType', 'actor', 'action', 'entityType', 'entityId', 'changes'];

/**
 * One CSV cell: always quoted, quotes doubled, and a leading `= + - @` (or tab/CR) defused with `'` so a spreadsheet
 * never runs it as a formula (CSV injection).
 */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The audit export (D-180): a UTF-8 BOM (Arabic opens right in Excel), a header row, times as office wall clock. */
export function auditCsv(entries: readonly AuditEntry[], timeZone: string): string {
  const rows = entries.map((e) => {
    const at = wallClock(e.occurredAt, timeZone);
    return [
      `${at.date} ${at.time}`,
      e.actor.type,
      e.actor.name,
      e.action,
      e.entityType,
      e.entityId,
      e.changes.length ? JSON.stringify(e.changes) : '',
    ]
      .map(csvCell)
      .join(',');
  });
  return `${BOM}${[HEADER.map(csvCell).join(','), ...rows].join('\r\n')}\r\n`;
}
