import { Module } from '@nestjs/common';

import { DataExportController } from './data-export.controller';
import { DataExportService } from './data-export.service';

/** Data exports (D-184): asked for here; the worker module provides `OfficeExportBuilder`, run by the report queue. */
@Module({
  controllers: [DataExportController],
  providers: [DataExportService],
})
export class DataExportModule {}
