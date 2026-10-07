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
const LIST_FILTERS = ['some', 'every', 'none'];
const RELATION_FILTERS = [...LIST_FILTERS, 'is', 'isNot'];
/** The only relation writes allowed into a global model: pointing a foreign key at an existing row. */
const GLOBAL_RELATION_WRITES = new Set(['connect', 'disconnect']);

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function requireOfficeId(officeId: string | undefined, target: string): string {
  if (!officeId) throw new TenantContextMissingError(target);
  return officeId;
}

/**
 * Rewrites the arguments of one Prisma model operation so it cannot leave the current office (D-018, D-080):
 * - tenant models: `officeId` is added to every `where` and every created row; a different `officeId` is rejected;
 * - Office (the tenant root): reads and updates of the current office's row only;
 * - global models (Plan, PlatformAdmin, LoginAttempt): read-only — their writes need `PrismaService.unscoped()`.
 * Relation writes into tenant models or Office are rejected at any depth (tenant rows are written with scalar foreign
 * keys, checked by the composite (…, office_id) FKs, D-079); into global models only connect/disconnect are allowed.
 * Relation filters, orderBy and include/select/_count that reach tenant rows through a global model are scoped too.
 * Unknown operations fail closed.
 */
export function scopeArgs(
  model: string,
  operation: string,
  args: unknown,
  ctx: ScopeContext,
): Json {
  const scoped: Json = isObject(args) ? { ...args } : {};
  const target = `${model}.${operation}`;
  if (ctx.tenantModels.has(model)) scopeTenantModel(model, operation, scoped, ctx, target);
  else if (model === OFFICE) scopeOffice(operation, scoped, ctx, target);
  else if (!READS.has(operation)) {
    throw new TenantViolationError(
      `${target}: global models are read-only on the scoped client; use PrismaService.unscoped()`,
    );
  }
  scopeShape(model, scoped, ctx);
  return scoped;
}

function scopeTenantModel(
  model: string,
  operation: string,
  scoped: Json,
  ctx: ScopeContext,
  target: string,
): void {
  const officeId = requireOfficeId(ctx.officeId(), target);
  if (CREATES.has(operation)) {
    scoped['data'] = mapRows(scoped['data'], target, (row) => createRow(model, row, officeId, ctx));
    return;
  }
  if (
    !READS.has(operation) &&
    !UPDATES.has(operation) &&
    !DELETES.has(operation) &&
    operation !== 'upsert'
  ) {
    throw new TenantViolationError(`${target}: operation not supported by the tenant extension`);
  }
  scoped['where'] = withField(scoped['where'], 'officeId', officeId, target);
  if (UPDATES.has(operation)) scoped['data'] = updateRow(model, scoped['data'], officeId, ctx);
  if (operation === 'upsert') {
    scoped['create'] = createRow(model, scoped['create'], officeId, ctx);
    scoped['update'] = updateRow(model, scoped['update'], officeId, ctx);
  }
}

function scopeOffice(operation: string, scoped: Json, ctx: ScopeContext, target: string): void {
  if (!READS.has(operation) && !UPDATES.has(operation)) {
    throw new TenantViolationError(
      `${target} is not allowed on the scoped client; use PrismaService.unscoped()`,
    );
  }
  scoped['where'] = withField(
    scoped['where'],
    'id',
    requireOfficeId(ctx.officeId(), target),
    target,
  );
  if (UPDATES.has(operation)) rejectRelationWrites(OFFICE, scoped['data'], ctx);
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

function mapRows(data: unknown, target: string, fn: (row: Json) => Json): unknown {
  const toRow = (row: unknown): Json => {
    if (!isObject(row))
      throw new TenantViolationError(`${target}: every data row must be an object`);
    return fn(row);
  };
  return Array.isArray(data) ? data.map(toRow) : toRow(data);
}

function createRow(model: string, data: unknown, officeId: string, ctx: ScopeContext): Json {
  const row: Json = isObject(data) ? { ...data } : {};
  if ('officeId' in row && row['officeId'] !== officeId) {
    throw new TenantViolationError(`${model}: data.officeId names another office`);
  }
  row['officeId'] = officeId;
  rejectRelationWrites(model, row, ctx);
  return row;
}

function updateRow(model: string, data: unknown, officeId: string, ctx: ScopeContext): unknown {
  if (!isObject(data)) return data;
  if ('officeId' in data && data['officeId'] !== officeId) {
    throw new TenantViolationError(`${model}: data.officeId would move the row to another office`);
  }
  rejectRelationWrites(model, data, ctx);
  return data;
}

function rejectRelationWrites(model: string, data: unknown, ctx: ScopeContext): void {
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
    if (!isObject(value) || Object.keys(value).some((op) => !GLOBAL_RELATION_WRITES.has(op))) {
      throw new TenantViolationError(
        `${model}.${field}: only connect/disconnect into global ${related} on the scoped client`,
      );
    }
  }
}

/** Scopes where, orderBy and include/select of one query level, recursing into included relations. */
function scopeShape(model: string, container: Json, ctx: ScopeContext): void {
  if ('where' in container) container['where'] = scopeWhere(model, container['where'], ctx);
  if ('orderBy' in container) assertOrderByScoped(model, container['orderBy'], ctx);
  for (const key of ['include', 'select']) {
    const fields = container[key];
    if (isObject(fields)) container[key] = scopeFields(model, fields, ctx);
  }
}

/** Relation filters (some/every/none/is/isNot) that cross from a global model into tenant rows get the office. */
function scopeWhere(model: string, where: unknown, ctx: ScopeContext): unknown {
  if (Array.isArray(where)) return where.map((item) => scopeWhere(model, item, ctx));
  if (!isObject(where)) return where;
  const relations = ctx.relations.get(model);
  const scoped: Json = {};
  for (const [key, value] of Object.entries(where)) {
    const related = relations?.get(key);
    if (key === 'AND' || key === 'OR' || key === 'NOT') scoped[key] = scopeWhere(model, value, ctx);
    else
      scoped[key] =
        related === undefined ? value : scopeRelationFilter(model, key, related, value, ctx);
  }
  return scoped;
}

function scopeRelationFilter(
  model: string,
  field: string,
  related: string,
  filter: unknown,
  ctx: ScopeContext,
): unknown {
  if (!isObject(filter)) return filter; // e.g. `{ plan: null }`
  const leaks = leaksAcrossOffices(model, related, ctx);
  const target = `${model}.${field}`;
  if (!RELATION_FILTERS.some((op) => op in filter)) {
    // To-one shorthand: `{ user: { email } }` filters the related row directly.
    const inner = scopeWhere(related, filter, ctx);
    return leaks
      ? withField(inner, 'officeId', requireOfficeId(ctx.officeId(), target), target)
      : inner;
  }
  const scoped: Json = { ...filter };
  for (const op of RELATION_FILTERS) {
    if (!(op in filter)) continue;
    const inner = scopeWhere(related, filter[op], ctx);
    if (!leaks || inner === null) {
      scoped[op] = inner;
      continue;
    }
    const officeId = requireOfficeId(ctx.officeId(), target);
    // `every` must only judge the current office's rows: rows of other offices pass vacuously.
    scoped[op] =
      op === 'every'
        ? { OR: [{ NOT: { officeId } }, inner ?? {}] }
        : withField(inner, 'officeId', officeId, target);
  }
  return scoped;
}

/** Ordering a global model by a tenant relation (e.g. `{ subscriptions: { _count } }`) would count every office. */
function assertOrderByScoped(model: string, orderBy: unknown, ctx: ScopeContext): void {
  for (const item of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    if (!isObject(item)) continue;
    for (const [field, value] of Object.entries(item)) {
      const related = ctx.relations.get(model)?.get(field);
      if (related === undefined) continue;
      if (leaksAcrossOffices(model, related, ctx)) {
        throw new TenantViolationError(
          `${model}.orderBy.${field}: ordering by ${related} would count every office`,
        );
      }
      assertOrderByScoped(related, value, ctx);
    }
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
    scopeShape(related, nested, ctx);
    if (leaksAcrossOffices(model, related, ctx)) {
      const target = `${model}.${field}`;
      nested['where'] = withField(
        nested['where'],
        'officeId',
        requireOfficeId(ctx.officeId(), target),
        target,
      );
    }
    scoped[field] = Object.keys(nested).length > 0 ? nested : true;
  }
  return scoped;
}

/** The `_count.select` to scope: `true` counts every relation, `{ select }` the listed ones; anything else is left alone. */
function countSelect(value: unknown, relations: ReadonlyMap<string, string>): Json | null {
  if (value === true)
    return Object.fromEntries([...relations.keys()].map((field) => [field, true]));
  return isObject(value) && isObject(value['select']) ? { ...value['select'] } : null;
}

function scopeCount(model: string, value: unknown, ctx: ScopeContext): unknown {
  if (value === false || value === undefined) return value;
  const relations = ctx.relations.get(model) ?? new Map<string, string>();
  const select = countSelect(value, relations);
  if (!select) return value;
  for (const [field, related] of relations) {
    const current = select[field];
    if (current === undefined || current === false) continue;
    select[field] = scopeCountField(model, field, related, current, ctx);
  }
  return { ...(isObject(value) ? value : {}), select };
}

/** One counted relation: its own filter scoped, and the office added when a global model reaches tenant rows. */
function scopeCountField(
  model: string,
  field: string,
  related: string,
  current: unknown,
  ctx: ScopeContext,
): unknown {
  const where = scopeWhere(related, isObject(current) ? current['where'] : undefined, ctx);
  if (leaksAcrossOffices(model, related, ctx)) {
    const target = `${model}._count.${field}`;
    return { where: withField(where, 'officeId', requireOfficeId(ctx.officeId(), target), target) };
  }
  return where === undefined ? current : { where };
}

/** Rows reached from a global model (Plan, PlatformAdmin) into a tenant relation could belong to any office. */
function leaksAcrossOffices(model: string, related: string, ctx: ScopeContext): boolean {
  return ctx.tenantModels.has(related) && !ctx.tenantModels.has(model) && model !== OFFICE;
}
