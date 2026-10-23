import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';
import { UnitOfWork } from './unit-of-work';
import { AuditService } from '../common/audit/audit.service';
import { TenantRunner } from '../common/tenancy/tenant-runner';

/**
 * Scoped + unscoped Prisma access, transactions with after-commit work, the tenant job runner and the audit service
 * (D-136), for both processes.
 */
@Global()
@Module({
  providers: [PrismaService, TenantRunner, UnitOfWork, AuditService],
  exports: [PrismaService, TenantRunner, UnitOfWork, AuditService],
})
export class DatabaseModule {}
