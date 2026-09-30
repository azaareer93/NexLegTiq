import { TenantContextMissingError, TenantViolationError } from './tenant.errors';

type Json = Record<string, unknown>;

/** model → relation field → target model, from the generated client's runtime data model. */
export type RelationMap = ReadonlyMap<string, ReadonlyMap<string, string>>;

export interface ScopeContext {
  readonly tenantModels: ReadonlySet<string>;
  readonly relations: RelationMap;
  /** The current office, or undefined outside a tenant context. */
  readonly officeId: () => string | undefined;
}

/** The tenant root: office users may only see and update their own row. */
const OFFICE = 'Office';

const READS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);
const UPDATES = new Set(['update', 'updateMany', 'updateManyAndReturn']);
const DELETES = new Set(['delete', 'deleteMany']);

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function requireOfficeId(officeId: string | undefined, target: string): string {
  if (!officeId) throw new TenantContextMissingError(target);
  return officeId;
}

/**
 * Rewrites the arguments of one Prisma model operation so it cannot leave the current office (D-018, D-080):
 * - tenant models: `officeId` is added to every `where` and every created row; a different `officeId` is rejected;
 * - Office: reads and updates are limited to the current office's row; create/delete/upsert need the unscoped client;
 * - global models (Plan, PlatformAdmin, LoginAttempt): untouched, except relations into tenant models.
 * Relation writes into tenant models (nested create/connect/upsert/…) are rejected at any depth: tenant rows are
 * written with scalar foreign keys, which the composite (user_id, office_id) FKs check (D-079).
 * Includes/selects/_count of tenant lists reached from a global model get the same `officeId` filter.
 */
export function scopeArgs(model: string, operation: string, args: unknown, ctx: ScopeContext): Json {
  const scoped: Json = isObject(args) ? { ...args } : {};
  const target = `${model}.${operation}`;

  if (ctx.tenantModels.has(model)) {
    const officeId = requireOfficeId(ctx.officeId(), target);
    if (READS.has(operation) || UPDATES.has(operation) || DELETES.has(operation) || operation === 'upsert') {
      scoped['where'] = withField(scoped['where'], 'officeId', officeId, target);
    }
    if (CREATES.has(operation)) scoped['data'] = mapRows(scoped['data'], (row) => createRow(model, row, officeId, ctx));
    if (UPDATES.has(operation)) scoped['data'] = updateRow(model, scoped['data'], officeId, ctx);
    if (operation === 'upsert') {
      scoped['create'] = createRow(model, scoped['create'], officeId, ctx);
      scoped['update'] = updateRow(model, scoped['update'], officeId, ctx);
    }
  } else if (model === OFFICE) {
    if (CREATES.has(operation) || DELETES.has(operation) || operation === 'upsert') {
      throw new TenantViolationError(`${target} is not allowed on the scoped client; use PrismaService.unscoped()`);
    }
    scoped['where'] = withField(scoped['where'], 'id', requireOfficeId(ctx.officeId(), target), target);
    if (UPDATES.has(operation)) rejectTenantRelationWrites(model, scoped['data'], ctx);
  } else {
    for (const key of ['data', 'create', 'update']) {
      if (key in scoped) mapRows(scoped[key], (row) => (rejectTenantRelationWrites(model, row, ctx), row));
    }
  }

  scopeProjection(model, scoped, ctx);
  return scoped;
}

/** `where.<field> = value`; a caller-supplied different value (or filter object) is a violation, never overridden. */
function withField(where: unknown, field: string, value: string, target: string): Json {
  const scoped: Json = isObject(where) ? { ...where } : {};
  if (field in scoped && scoped[field] !== value) {
    throw new TenantViolationError(`${target}: where.${field} does not match the current office`);
  }
  scoped[field] = value;
  return scoped;
}

function mapRows(data: unknown, fn: (row: Json) => Json): unknown {
  if (Array.isArray(data)) return data.map((row) => fn(isObject(row) ? row : {}));
  return isObject(data) ? fn(data) : data;
}

function createRow(model: string, data: unknown, officeId: string, ctx: ScopeContext): Json {
  const row: Json = isObject(data) ? { ...data } : {};
  if ('officeId' in row && row['officeId'] !== officeId) {
    throw new TenantViolationError(`${model}: data.officeId names another office`);
  }
  row['officeId'] = officeId;
  rejectTenantRelationWrites(model, row, ctx);
  return row;
}

function updateRow(model: string, data: unknown, officeId: string, ctx: ScopeContext): unknown {
  if (!isObject(data)) return data;
  if ('officeId' in data && data['officeId'] !== officeId) {
    throw new TenantViolationError(`${model}: data.officeId would move the row to another office`);
  }
  rejectTenantRelationWrites(model, data, ctx);
  return data;
}

const NESTED_PAYLOAD_KEYS = ['create', 'createMany', 'connectOrCreate', 'upsert', 'update', 'updateMany', 'data'];

/** Throws on any relation write that reaches a tenant model (or the Office relation of a tenant row). */
function rejectTenantRelationWrites(model: string, data: unknown, ctx: ScopeContext): void {
  if (!isObject(data)) return;
  const relations = ctx.relations.get(model);
  for (const [field, value] of Object.entries(data)) {
    const related = relations?.get(field);
    if (related === undefined || value === undefined) continue;
    if (ctx.tenantModels.has(related) || related === OFFICE) {
      throw new TenantViolationError(
        `${model}.${field}: relation writes into ${related} are not allowed on the scoped client; ` +
          'write the row with scalar foreign keys',
      );
    }
    walkNestedPayload(related, value, ctx);
  }
}

/** Descends through nested-write payloads of a global model to find tenant writes deeper down. */
function walkNestedPayload(model: string, value: unknown, ctx: ScopeContext): void {
  if (Array.isArray(value)) {
    for (const item of value) walkNestedPayload(model, item, ctx);
    return;
  }
  if (!isObject(value)) return;
  rejectTenantRelationWrites(model, value, ctx);
  for (const key of NESTED_PAYLOAD_KEYS) {
    if (key in value) walkNestedPayload(model, value[key], ctx);
  }
}

/** Scopes include/select/_count of tenant relations reached from a global model, at any depth. */
function scopeProjection(model: string, container: Json, ctx: ScopeContext): void {
  for (const key of ['include', 'select']) {
    const fields = container[key];
    if (isObject(fields)) container[key] = scopeFields(model, fields, ctx);
  }
}

function scopeFields(model: string, fields: Json, ctx: ScopeContext): Json {
  const scoped: Json = { ...fields };
  const relations = ctx.relations.get(model) ?? new Map<string, string>();
  for (const [field, value] of Object.entries(fields)) {
    if (field === '_count') {
      scoped[field] = scopeCount(model, value, ctx);
      continue;
    }
    const related = relations.get(field);
    if (related === undefined || value === false || value === undefined) continue;
    const nested: Json = isObject(value) ? { ...value } : {};
    if (leaksAcrossOffices(model, related, ctx)) {
      const target = `${model}.${field}`;
      nested['where'] = withField(nested['where'], 'officeId', requireOfficeId(ctx.officeId(), target), target);
    }
    scopeProjection(related, nested, ctx);
    scoped[field] = Object.keys(nested).length > 0 ? nested : true;
  }
  return scoped;
}

function scopeCount(model: string, value: unknown, ctx: ScopeContext): unknown {
  const relations = ctx.relations.get(model) ?? new Map<string, string>();
  const tenantRelations = [...relations].filter(([, related]) => leaksAcrossOffices(model, related, ctx));
  if (tenantRelations.length === 0 || value === false || value === undefined) return value;
  // `_count: true` counts every relation; expand it so the tenant ones can be filtered.
  const select: Json =
    value === true
      ? Object.fromEntries([...relations.keys()].map((field) => [field, true]))
      : isObject(value) && isObject(value['select'])
        ? { ...value['select'] }
        : {};
  for (const [field] of tenantRelations) {
    const current = select[field];
    if (current === undefined || current === false) continue;
    const target = `${model}._count.${field}`;
    const where = isObject(current) ? current['where'] : undefined;
    select[field] = { where: withField(where, 'officeId', requireOfficeId(ctx.officeId(), target), target) };
  }
  return { ...(isObject(value) ? value : {}), select };
}

/** Rows reached from a global model (Plan, PlatformAdmin) into a tenant list could belong to any office. */
function leaksAcrossOffices(model: string, related: string, ctx: ScopeContext): boolean {
  return ctx.tenantModels.has(related) && !ctx.tenantModels.has(model) && model !== OFFICE;
}

/**
 * Raw SQL bypasses $extends. On the scoped client it is allowed on tenant tables only when the current officeId is one
 * of its parameters (e.g. `WHERE office_id = ${officeId}`); the `*Unsafe` variants are never allowed there.
 * ponytail: finds tenant tables by name in the SQL text; a name that also appears in a string literal is caught too
 * (fails closed). Whether the officeId parameter is used in the right place is left to review.
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
  const touched = tenantTables.filter((table) => new RegExp(`(^|[^a-z0-9_])${table}($|[^a-z0-9_])`).test(lowered));
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
    return { text: (args['strings'] as string[]).join('?'), values: Array.isArray(args['values']) ? args['values'] : [] };
  }
  if (Array.isArray(args)) {
    const [strings, ...values] = args as [unknown, ...unknown[]];
    return { text: Array.isArray(strings) ? strings.join('?') : String(strings), values };
  }
  return { text: String(args), values: [] };
}
