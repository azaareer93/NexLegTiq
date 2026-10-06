import { Prisma } from '../../generated/prisma/client';
import { assertRawQueryScoped, scopeArgs } from './tenant-scope';
import type { RelationMap, ScopeContext } from './tenant-scope';

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

export interface TenantExtensionOptions {
  readonly models: Readonly<Record<string, RuntimeModel>>;
  readonly tenantModels: readonly string[];
  /** The current office from CLS, or undefined outside a tenant context. */
  readonly officeId: () => string | undefined;
}

/** Prisma client extension enforcing D-018 on every model operation and raw query (rules in tenant-scope.ts). */
export function tenantExtension({ models, tenantModels, officeId }: TenantExtensionOptions) {
  const unknown = tenantModels.filter((model) => !(model in models));
  if (unknown.length > 0)
    throw new Error(`TENANT_MODELS lists unknown models: ${unknown.join(', ')}`);

  const ctx: ScopeContext = {
    tenantModels: new Set(tenantModels),
    relations: relationMap(models),
    officeId,
  };
  const tenantTables = tenantModels.map((model) => models[model]?.dbName ?? model);

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
