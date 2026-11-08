import { Global, Module } from '@nestjs/common';

import { TimelineController } from './timeline.controller';
import { TimelineService } from './timeline.service';
import { DocumentAccessService } from '../documents/document-access.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** A file's timeline (D-150): `TimelineService.record` is global, so every module writes its events the same way. */
@Global()
@Module({
  imports: [LegalFilesModule],
  controllers: [TimelineController],
  // DocumentAccessService is stateless; providing it here avoids importing the whole documents module.
  providers: [TimelineService, DocumentAccessService],
  exports: [TimelineService],
})
export class TimelineModule {}
