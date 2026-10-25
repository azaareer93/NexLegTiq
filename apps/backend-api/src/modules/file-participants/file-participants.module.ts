import { Module } from '@nestjs/common';

import { FileClientsService } from './file-clients.service';
import { FileParticipantsController } from './file-participants.controller';
import { FileTeamService } from './file-team.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';
import { SessionsModule } from '../sessions/sessions.module';

/** Clients and team of a file (D-140); its own module because a new responsible lawyer resets hearing reminders. */
@Module({
  imports: [LegalFilesModule, SessionsModule],
  controllers: [FileParticipantsController],
  providers: [FileClientsService, FileTeamService],
})
export class FileParticipantsModule {}
