import { Module } from '@nestjs/common';

import { CaseTimeTotalsController, TimeEntriesController } from './time-entries.controller';
import { TimeEntriesService } from './time-entries.service';
import { TimerService } from './time-timer.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** Time tracking (MVP-90, D-152). */
@Module({
  imports: [LegalFilesModule],
  controllers: [TimeEntriesController, CaseTimeTotalsController],
  providers: [TimeEntriesService, TimerService],
})
export class TimeEntriesModule {}
