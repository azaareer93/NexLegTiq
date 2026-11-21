import { Global, Module } from '@nestjs/common';

import { PrismaService } from './prisma.service';
import { UnitOfWork } from './unit-of-work';
import { ProductAnalytics } from '../common/analytics/product-analytics';
import { AuditService } from '../common/audit/audit.service';
import { TenantRunner } from '../common/tenancy/tenant-runner';

/**
 * Scoped + unscoped Prisma access, transactions with after-commit work, the tenant job runner, the audit service
 * (D-136) and product analytics (D-215), for both processes.
 */
@Global()
@Module({
  providers: [PrismaService, TenantRunner, UnitOfWork, AuditService, ProductAnalytics],
  exports: [PrismaService, TenantRunner, UnitOfWork, AuditService, ProductAnalytics],
})
export class DatabaseModule {}
