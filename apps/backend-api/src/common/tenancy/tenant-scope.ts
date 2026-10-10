import { visibleWhere, withField } from './tenant-where';
import { TenantContextMissingError, TenantViolationError } from './tenant.errors';

type Json = Record<string, unknown>;

/** model → relation field → target model, from the generated client's runtime data model. */
export type RelationMap = ReadonlyMap<string, ReadonlyMap<string, string>>;

export interface ScopeContext {
  readonly tenantModels: ReadonlySet<string>;
  readonly relations: RelationMap;
  /**
   * Reference models (D-037, D-115): `officeId` null = a platform row every office reads, set = one office's own row.
   * Reads see platform rows and the office's own; writes behave like a tenant model (own rows only).
   */
  readonly referenceModels?: ReadonlySet<string>;
  /**
   * `Model.field` of to-one relations into reference models whose visibility a database trigger guarantees (Prisma
   * accepts no `where` on a to-one include). Any other to-one include into a reference model gets a `where` and Prisma
   * rejects the query: loud, never a silent leak.
   */
  readonly trustedReferenceRelations?: ReadonlySet<string>;
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
 * - reference models (Court, Judge): reads see platform rows (`officeId` null) and the office's own; writes, like a
 *   tenant model, only the office's own rows — platform rows are written with `PrismaService.unscoped()` (the seed);
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
  const reference = ctx.referenceModels?.has(model) ?? false;
  // Reference models write like tenant models (own rows only) and read platform rows too.
  if (ctx.tenantModels.has(model) || (reference && !READS.has(operation)))
    scopeTenantModel(model, operation, scoped, ctx, target);
  else if (reference)
    scoped['where'] = visibleWhere(
      scoped['where'],
      requireOfficeId(ctx.officeId(), target),
      target,
    );
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

/** `where` with the office condition a relation from `model` into `related` needs (unchanged when none). */
function scopeRelated(
  model: string,
  related: string,
  where: unknown,
  ctx: ScopeContext,
  target: string,
): unknown {
  if (ctx.referenceModels?.has(related)) {
    return visibleWhere(where, requireOfficeId(ctx.officeId(), target), target);
  }
  return leaksAcrossOffices(model, related, ctx)
    ? withField(where, 'officeId', requireOfficeId(ctx.officeId(), target), target)
    : where;
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

/** Rows that belong to an office: tenant models, reference models (own rows) and the Office itself. */
function isOfficeBound(model: string, ctx: ScopeContext): boolean {
  return (
    ctx.tenantModels.has(model) || (ctx.referenceModels?.has(model) ?? false) || model === OFFICE
  );
}

function rejectRelationWrites(model: string, data: unknown, ctx: ScopeContext): void {
  if (!isObject(data)) return;
  const relations = ctx.relations.get(model);
  for (const [field, value] of Object.entries(data)) {
    const related = relations?.get(field);
    if (related === undefined || value === undefined) continue;
    if (isOfficeBound(related, ctx)) {
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
  const scope = needsScope(model, related, ctx);
  const target = `${model}.${field}`;
  if (!RELATION_FILTERS.some((op) => op in filter)) {
    // To-one shorthand: `{ user: { email } }` filters the related row directly.
    const inner = scopeWhere(related, filter, ctx);
    return scope ? scopeRelated(model, related, inner, ctx, target) : inner;
  }
  const scoped: Json = { ...filter };
  for (const op of RELATION_FILTERS) {
    if (!(op in filter)) continue;
    const inner = scopeWhere(related, filter[op], ctx);
    if (!scope || inner === null) {
      scoped[op] = inner;
      continue;
    }
    // `every` must only judge the rows the office may see: other rows pass vacuously.
    scoped[op] =
      op === 'every'
        ? { OR: [{ NOT: scopeRelated(model, related, {}, ctx, target) }, inner ?? {}] }
        : scopeRelated(model, related, inner, ctx, target);
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
      if (needsScope(model, related, ctx)) {
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
    scoped[field] = scopeIncluded(model, field, related, value, ctx);
  }
  return scoped;
}

/** One included/selected relation: its own shape scoped, and the office condition when the relation needs it. */
function scopeIncluded(
  model: string,
  field: string,
  related: string,
  value: unknown,
  ctx: ScopeContext,
): Json | true {
  const nested: Json = isObject(value) ? { ...value } : {};
  scopeShape(related, nested, ctx);
  // A trigger-backed to-one relation into a reference model takes no `where` (D-115).
  const trusted = ctx.trustedReferenceRelations?.has(`${model}.${field}`) ?? false;
  if (needsScope(model, related, ctx) && !trusted) {
    nested['where'] = scopeRelated(model, related, nested['where'], ctx, `${model}.${field}`);
  }
  return Object.keys(nested).length > 0 ? nested : true;
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
  if (needsScope(model, related, ctx)) {
    return { where: scopeRelated(model, related, where, ctx, `${model}._count.${field}`) };
  }
  return where === undefined ? current : { where };
}

/** Rows reached from a global or reference model (Plan, Court) into a tenant relation could belong to any office. */
function leaksAcrossOffices(model: string, related: string, ctx: ScopeContext): boolean {
  return ctx.tenantModels.has(related) && !ctx.tenantModels.has(model) && model !== OFFICE;
}

/** Rows of a reference model are limited to the visible ones wherever they are reached from. */
function needsScope(model: string, related: string, ctx: ScopeContext): boolean {
  return (ctx.referenceModels?.has(related) ?? false) || leaksAcrossOffices(model, related, ctx);
}
