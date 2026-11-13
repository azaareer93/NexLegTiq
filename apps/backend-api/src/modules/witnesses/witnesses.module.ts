import { Module } from '@nestjs/common';

import { WitnessesController, WitnessStatementsController } from './witnesses.controller';
import { WitnessesService } from './witnesses.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** A file's witnesses and their statements (MVP-143, D-163). */
@Module({
  imports: [LegalFilesModule],
  controllers: [WitnessesController, WitnessStatementsController],
  providers: [WitnessesService],
})
export class WitnessesModule {}
