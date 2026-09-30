import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { AppConfig } from '../config/app-config';
import { PrismaClient } from '../generated/prisma/client';
import { ReadinessRegistry } from '../health/readiness.registry';

/**
 * The single Prisma client of a process (HTTP API or worker). Connects lazily through the `pg` driver adapter and
 * registers the `db` readiness check, so `/health/ready` returns 503 SYS-002 while the database is unreachable.
 * Tenant-scoped access goes through the tenant extension (MVP-37), not this raw client.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(
    config: AppConfig,
    private readonly readiness: ReadinessRegistry,
  ) {
    super({ adapter: new PrismaPg({ connectionString: config.database.url }) });
  }

  onModuleInit(): void {
    this.readiness.register('db', async () => {
      await this.$queryRaw`SELECT 1`;
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
