import { Module } from '@nestjs/common';

import { LegalResearchController } from './legal-research.controller';
import { LegalResearchService } from './legal-research.service';
import { AiModule } from '../ai/ai.module';

/**
 * Legal research (D-256): asked for here. The worker module provides `LegalResearcher`, which registers the
 * `legal-research` job handler (D-130), so only the worker calls the provider.
 */
@Module({
  imports: [AiModule],
  controllers: [LegalResearchController],
  providers: [LegalResearchService],
})
export class AiResearchModule {}
