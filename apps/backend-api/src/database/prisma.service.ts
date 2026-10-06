import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../common/context/request-context';
import { runtimeModels, tenantExtension } from '../common/tenancy/tenant.extension';
import { AppConfig } from '../config/app-config';
import { PrismaClient } from '../generated/prisma/client';
import { ReadinessRegistry } from '../health/readiness.registry';
import { TENANT_MODELS } from './tenant-models';

function createScopedClient(client: PrismaClient, cls: ClsService<RequestContext>) {
  return client.$extends(
    tenantExtension({
      models: runtimeModels(client),
      tenantModels: TENANT_MODELS,
      officeId: () => cls.get('officeId'),
    }),
  );
}

/** The tenant-scoped client (D-018): every query is limited to the office in the request/job context. */
export type ScopedPrismaClient = ReturnType<typeof createScopedClient>;

/**
 * The Prisma client of a process (HTTP API or worker), connected lazily through the `pg` driver adapter. Registers the
 * `db` readiness check, so `/health/ready` returns 503 SYS-002 while the database is unreachable.
 *
 * Repositories use `db`, scoped to the current office (tenant extension, D-018/D-080). `unscoped()` is only for
 * migrations, seeds, signup/login before an office is known, and platform-admin code; lint flags every call and each
 * one needs a `// unscoped: <reason>` comment directly above it (lint rule nexlegtiq/unscoped-needs-reason).
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  // ES private (not TS `private`): `prisma["client"]` must not be a way around unscoped() and its lint rule.
  readonly #client: PrismaClient;
  readonly db: ScopedPrismaClient;

  constructor(
    config: AppConfig,
    private readonly readiness: ReadinessRegistry,
    cls: ClsService<RequestContext>,
  ) {
    this.#client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: config.database.url }),
    });
    this.db = createScopedClient(this.#client, cls);
  }

  /** The raw client: no tenant scoping. See the class comment for the only allowed uses. */
  unscoped(): PrismaClient {
    return this.#client;
  }

  onModuleInit(): void {
    this.readiness.register('db', async () => {
      await this.#client.$queryRaw`SELECT 1`;
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.#client.$disconnect();
  }
}
