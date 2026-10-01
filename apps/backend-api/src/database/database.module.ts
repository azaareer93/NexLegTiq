import { Global, Module } from '@nestjs/common';

import { TenantRunner } from '../common/tenancy/tenant-runner';
import { PrismaService } from './prisma.service';

/** Scoped + unscoped Prisma access and the tenant job runner, for both the HTTP API and the worker. */
@Global()
@Module({
  providers: [PrismaService, TenantRunner],
  exports: [PrismaService, TenantRunner],
})
export class DatabaseModule {}
