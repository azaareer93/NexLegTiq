import { Global, Module } from '@nestjs/common';

import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** A file's timeline (D-150): `TimelineService.record` is global, so every module writes its events the same way. */
@Global()
@Module({
  imports: [LegalFilesModule],
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}
