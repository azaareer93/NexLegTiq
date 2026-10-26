import { Module } from '@nestjs/common';

import { AiAccess } from './ai-access';
import { AiCache } from './ai-cache';
import { AiCostAlert } from './ai-cost-alert';
import { AiExecutor } from './ai-executor';
import { AiJobRegistry } from './ai-job-registry';
import { AiJobs } from './ai-jobs';
import { AiJobsController } from './ai-jobs.controller';
import { AiProviders } from './ai-providers';
import { AiUsageRecorder } from './ai-usage';
import { AiUsageController } from './ai-usage.controller';
import { PiiRedactor } from './pii-redactor';
import { AI_REDACTOR } from './redaction';

/**
 * The AI foundation (ai-ocr.md, D-130): providers with fallback, the executor every feature calls, jobs and their
 * registry. `AI_REDACTOR` is the `PiiRedactor` (D-131): every text
 * is redacted before a provider sees it. Feature modules import this module, extend `BaseAiService` and register their job handlers.
 */
@Module({
  controllers: [AiJobsController, AiUsageController],
  providers: [
    AiProviders,
    AiAccess,
    AiCache,
    AiUsageRecorder,
    AiExecutor,
    AiJobs,
    AiJobRegistry,
    AiCostAlert,
    { provide: AI_REDACTOR, useClass: PiiRedactor },
  ],
  // AiProviders stays inside: features reach a model only through AiExecutor (redaction, quota, usage).
  exports: [AiExecutor, AiJobs, AiJobRegistry, AiAccess, AiCostAlert],
})
export class AiModule {}
