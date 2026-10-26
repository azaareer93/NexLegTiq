import { Module } from '@nestjs/common';

import { InvitationsService } from './invitations.service';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { TeamService } from './team.service';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { SessionsModule } from '../sessions/sessions.module';

/** The office's people: the directory for pickers (D-123) and team management (D-124) and invitations (D-134). */
@Module({
  imports: [SessionsModule],
  controllers: [UsersController, ProfileController],
  providers: [UsersRepository, TeamService, InvitationsService, ProfileService],
})
export class UsersModule {}
