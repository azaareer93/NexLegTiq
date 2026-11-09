import { Module } from '@nestjs/common';

import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** A file's internal notes (MVP-65, D-154). */
@Module({
  imports: [LegalFilesModule],
  controllers: [NotesController],
  providers: [NotesService],
})
export class NotesModule {}
