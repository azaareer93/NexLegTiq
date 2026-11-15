/**
 * One CSV cell: always quoted, quotes doubled, a leading `= + - @` (or tab/CR) defused with `'` so a spreadsheet never
 * runs it as a formula. Dates as ISO text, objects as JSON.
 */
export function csvCell(value: unknown): string {
  let text: string;
  if (value === null || value === undefined) text = '';
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object' && !('toFixed' in value)) text = JSON.stringify(value);
  else text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

const BOM = String.fromCharCode(0xfeff);
const CRLF = String.fromCharCode(13, 10);

/** A CSV of `rows` with `columns` in that order, a UTF-8 BOM first (Excel reads Arabic as UTF-8). */
export function csvTable(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string {
  const lines = [
    columns.map(csvCell).join(','),
    ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(',')),
  ];
  return `${BOM}${lines.join(CRLF)}${CRLF}`;
}
