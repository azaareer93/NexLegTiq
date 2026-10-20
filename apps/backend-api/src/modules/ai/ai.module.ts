import { Module } from '@nestjs/common';

import { AiAccess } from './ai-access';
import { AiCache } from './ai-cache';
import { AiExecutor } from './ai-executor';
import { AiJobRegistry } from './ai-job-registry';
import { AiJobs } from './ai-jobs';
import { AiJobsController } from './ai-jobs.controller';
import { AiProviders } from './ai-providers';
import { AiUsageRecorder } from './ai-usage';
import { AI_REDACTOR, PassThroughRedactor } from './redaction';

/**
 * The AI foundation (ai-ocr.md, D-130): providers with fallback, the executor every feature calls, jobs and their
 * registry. `AI_REDACTOR` is a pass-through until the PII redactor story replaces it — real providers refuse to run
 * until then. Feature modules import this module, extend `BaseAiService` and register their job handlers.
 */
@Module({
  controllers: [AiJobsController],
  providers: [
    AiProviders,
    AiAccess,
    AiCache,
    AiUsageRecorder,
    AiExecutor,
    AiJobs,
    AiJobRegistry,
    { provide: AI_REDACTOR, useClass: PassThroughRedactor },
  ],
  exports: [AiExecutor, AiJobs, AiJobRegistry, AiProviders, AiAccess],
})
export class AiModule {}
