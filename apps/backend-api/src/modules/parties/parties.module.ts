import { Module } from '@nestjs/common';

import { ConflictsService } from './conflicts.service';
import { ConflictsController, PartiesController } from './parties.controller';
import { PartiesService } from './parties.service';
import { PartyRegistry } from './party-registry';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** Parties of the office and of its files, and conflicts of interest (MVP-62, W9, D-135). */
@Module({
  imports: [LegalFilesModule],
  controllers: [PartiesController, ConflictsController],
  providers: [PartiesService, PartyRegistry, ConflictsService],
})
export class PartiesModule {}
