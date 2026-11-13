import { Module } from '@nestjs/common';

import { ClientNotesController, NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** Internal notes of files (MVP-65, D-154) and clients (MVP-55, D-168). */
@Module({
  imports: [LegalFilesModule],
  controllers: [NotesController, ClientNotesController],
  providers: [NotesService],
})
export class NotesModule {}
