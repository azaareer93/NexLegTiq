import { Module } from '@nestjs/common';

import { CourtReportsController } from './court-reports.controller';
import { CourtReportsService } from './court-reports.service';
import { CourtsController } from './courts.controller';
import { CourtsService } from './courts.service';
import { PlatformCourtReportsService } from './platform-court-reports.service';
import { PlatformCourtsController } from './platform-courts.controller';
import { PlatformCourtsService } from './platform-courts.service';
import { ProsecutorsController } from './prosecutors.controller';
import { ProsecutorsService } from './prosecutors.service';
import { ReferenceContext } from './reference-context';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';

/**
 * Courts, judges and public prosecutors (MVP-66, D-115); platform courts per country, offices' legacy courts and
 * missing-court reports for the platform admin (MVP-167, D-266).
 */
@Module({
  imports: [PlatformAuthModule],
  controllers: [
    CourtsController,
    CourtReportsController,
    ProsecutorsController,
    PlatformCourtsController,
  ],
  providers: [
    CourtsService,
    CourtReportsService,
    ProsecutorsService,
    ReferenceContext,
    PlatformCourtsService,
    PlatformCourtReportsService,
  ],
})
export class CourtsModule {}
