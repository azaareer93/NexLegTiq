import { Module } from '@nestjs/common';

import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** Reading and exporting the audit log (MVP-105, D-180); writing it stays in `common/audit`. */
@Module({
  imports: [LegalFilesModule],
  controllers: [AuditLogController],
  providers: [AuditLogService],
})
export class AuditLogModule {}
