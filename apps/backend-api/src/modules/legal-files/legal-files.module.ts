import { Module } from '@nestjs/common';

import { CaseAccessService } from './case-access.service';
import { CasesController } from './cases.controller';
import { CasesRepository } from './cases.repository';
import { CasesService } from './cases.service';
import { FileNumberService } from './file-number.service';

/** Legal files (cases). CaseAccessService is exported for the routes of other features on a file (D-081). */
@Module({
  controllers: [CasesController],
  providers: [CasesService, CasesRepository, CaseAccessService, FileNumberService],
  exports: [CaseAccessService],
})
export class LegalFilesModule {}
