import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';
import { UnitOfWork } from './unit-of-work';
import { TenantRunner } from '../common/tenancy/tenant-runner';

/** Scoped + unscoped Prisma access, transactions with after-commit work and the tenant job runner, for both processes. */
@Global()
@Module({
  providers: [PrismaService, TenantRunner, UnitOfWork],
  exports: [PrismaService, TenantRunner, UnitOfWork],
})
export class DatabaseModule {}
