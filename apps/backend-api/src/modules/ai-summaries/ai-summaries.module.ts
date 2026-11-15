import { Module } from '@nestjs/common';

import { AiSummariesController } from './ai-summaries.controller';
import { AiSummariesService } from './ai-summaries.service';
import { SessionSummariesService } from './session-summaries.service';
import { AiModule } from '../ai/ai.module';
import { DocumentsModule } from '../documents/documents.module';
import { LegalFilesModule } from '../legal-files/legal-files.module';
import { TasksModule } from '../tasks/tasks.module';

/**
 * Document summaries (D-148): asked for here. The worker module provides `DocumentSummarizer`, which registers the
 * `summarize-document` job handler (D-130), so only the worker runs it.
 */
@Module({
  imports: [AiModule, DocumentsModule, LegalFilesModule, TasksModule],
  controllers: [AiSummariesController],
  providers: [AiSummariesService, SessionSummariesService],
})
export class AiSummariesModule {}
