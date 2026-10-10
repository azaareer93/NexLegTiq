import { assertRawQueryScoped } from './tenant-raw-sql';
import { scopeArgs } from './tenant-scope';
import type { RelationMap, ScopeContext } from './tenant-scope';
import { Prisma } from '../../generated/prisma/client';

interface RuntimeModel {
  readonly dbName: string | null;
  readonly fields: readonly {
    readonly name: string;
    readonly kind: string;
    readonly type: string;
  }[];
}

/**
 * The generated client's runtime data model (models, fields, relation targets, table names).
 * ponytail: `_runtimeDataModel` is internal to Prisma; checked at boot so an upgrade that drops it fails loudly
 * (TenantExtension construction), never silently unscoped. Revisit if Prisma exposes the DMMF publicly again.
 */
export function runtimeModels(client: object): Readonly<Record<string, RuntimeModel>> {
  const models = (client as { _runtimeDataModel?: { models?: Record<string, RuntimeModel> } })
    ._runtimeDataModel?.models;
  if (!models || Object.keys(models).length === 0) {
    throw new Error(
      'Prisma runtime data model not found: the tenant extension cannot scope queries',
    );
  }
  return models;
}

export function relationMap(models: Readonly<Record<string, RuntimeModel>>): RelationMap {
  return new Map(
    Object.entries(models).map(([model, { fields }]) => [
      model,
      new Map(
        fields.filter((field) => field.kind === 'object').map((field) => [field.name, field.type]),
      ),
    ]),
  );
}

/**
 * `Model.field` of the to-one relations: the runtime model has no list flag, so a relation counts as to-one when its
 * model holds the foreign key `<field>Id` (the schema's naming convention).
 * ponytail: a convention, not metadata — a to-one relation named otherwise gets a `where` on include and Prisma rejects
 * the query (loud, not a leak). Revisit if Prisma exposes `isList` at runtime.
 */
export function toOneRelations(models: Readonly<Record<string, RuntimeModel>>): Set<string> {
  const toOne = new Set<string>();
  for (const [model, { fields }] of Object.entries(models)) {
    const scalars = new Set(fields.filter((f) => f.kind === 'scalar').map((f) => f.name));
    for (const field of fields) {
      if (field.kind === 'object' && scalars.has(`${field.name}Id`)) {
        toOne.add(`${model}.${field.name}`);
      }
    }
  }
  return toOne;
}

export interface TenantExtensionOptions {
  readonly models: Readonly<Record<string, RuntimeModel>>;
  readonly tenantModels: readonly string[];
  /** Platform-or-office models (D-037, D-115); see ScopeContext.referenceModels. */
  readonly referenceModels?: readonly string[];
  /** The current office from CLS, or undefined outside a tenant context. */
  readonly officeId: () => string | undefined;
}

/** Prisma client extension enforcing D-018 on every model operation and raw query (rules in tenant-scope.ts). */
export function tenantExtension({
  models,
  tenantModels,
  referenceModels = [],
  officeId,
}: TenantExtensionOptions) {
  const unknown = [...tenantModels, ...referenceModels].filter((model) => !(model in models));
  if (unknown.length > 0)
    throw new Error(`TENANT_MODELS lists unknown models: ${unknown.join(', ')}`);

  const ctx: ScopeContext = {
    tenantModels: new Set(tenantModels),
    referenceModels: new Set(referenceModels),
    toOneRelations: toOneRelations(models),
    relations: relationMap(models),
    officeId,
  };
  // Raw SQL on a reference table must take the officeId too (`office_id IS NULL OR office_id = $1`).
  const tenantTables = [...tenantModels, ...referenceModels].map(
    (model) => models[model]?.dbName ?? model,
  );

  return Prisma.defineExtension({
    name: 'tenant',
    query: {
      $allOperations({ model, operation, args, query }) {
        if (model === undefined) {
          assertRawQueryScoped(operation, args, tenantTables, officeId);
          return query(args);
        }
        return query(scopeArgs(model, operation, args, ctx) as typeof args);
      },
    },
  });
}
