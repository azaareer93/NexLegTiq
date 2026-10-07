import { requireOfficeId } from './tenant-scope';
import { TenantViolationError } from './tenant.errors';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Raw SQL bypasses $extends. On the scoped client it is allowed on tenant tables only when the current officeId is one
 * of its parameters (e.g. `WHERE office_id = ${officeId}`); the `*Unsafe` variants and Unicode-escaped identifiers
 * (`U&"…"`, which can spell a table name the check would not see) are never allowed there.
 * ponytail: a guard against developer mistakes, not a parser — it finds tenant tables by name and only checks that the
 * officeId is among the parameters, not where it is used; a view or function reading a tenant table is not seen.
 * Phase 3 RLS is the backstop (D-018).
 */
export function assertRawQueryScoped(
  operation: string,
  args: unknown,
  tenantTables: readonly string[],
  officeId: () => string | undefined,
): void {
  if (operation.endsWith('Unsafe')) {
    throw new TenantViolationError(`${operation} is not allowed on the scoped client`);
  }
  const { text, values } = rawParts(args);
  const lowered = text.toLowerCase();
  if (lowered.includes('u&"')) {
    throw new TenantViolationError(
      `${operation}: Unicode-escaped identifiers are not allowed on the scoped client`,
    );
  }
  const touched = tenantTables.filter((table) =>
    new RegExp(`(^|[^a-z0-9_])${table}($|[^a-z0-9_])`).test(lowered),
  );
  if (touched.length === 0) return;
  const target = `${operation} on ${touched.join(', ')}`;
  const current = requireOfficeId(officeId(), target);
  if (!values.includes(current)) {
    throw new TenantViolationError(`${target} must take the current officeId as a parameter`);
  }
}

function rawParts(args: unknown): { text: string; values: unknown[] } {
  // Prisma.sql / tagged template → { strings, values }; the extension may also see [strings, ...values].
  if (isObject(args) && Array.isArray(args['strings'])) {
    return {
      text: (args['strings'] as string[]).join('?'),
      values: Array.isArray(args['values']) ? args['values'] : [],
    };
  }
  if (Array.isArray(args)) {
    const [strings, ...values] = args as [unknown, ...unknown[]];
    return { text: Array.isArray(strings) ? strings.join('?') : String(strings), values };
  }
  return { text: String(args), values: [] };
}
