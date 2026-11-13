import { Module } from '@nestjs/common';

import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { DocumentsModule } from '../documents/documents.module';
import { LegalFilesModule } from '../legal-files/legal-files.module';
import { TasksModule } from '../tasks/tasks.module';

/** `GET /search` (MVP-81, D-167). */
@Module({
  imports: [LegalFilesModule, DocumentsModule, TasksModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
