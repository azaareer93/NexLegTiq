import { Prisma } from '../../generated/prisma/client';

/**
 * The fields of `data` (undefined = not sent) whose value differs from `before`, as audit old/new values: decimals
 * compare as numbers and are audited with 2 digits, arrays by their items.
 */
export function changes(before: Record<string, unknown>, data: Record<string, unknown>) {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const previous = before[key];
    const decimal = Prisma.Decimal.isDecimal(previous) ? previous : null;
    const same = decimal
      ? value !== null && decimal.equals(value as string)
      : JSON.stringify(previous) === JSON.stringify(value);
    if (!same) {
      old[key] = decimal ? decimal.toFixed(2) : previous;
      next[key] = value;
    }
  }
  return { old, next };
}
