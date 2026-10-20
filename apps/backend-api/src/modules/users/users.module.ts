import { Module } from '@nestjs/common';

import { TeamService } from './team.service';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { SessionsModule } from '../sessions/sessions.module';

/** The office's people: the directory for pickers (D-123) and team management (D-124). */
@Module({
  imports: [SessionsModule],
  controllers: [UsersController],
  providers: [UsersRepository, TeamService],
})
export class UsersModule {}
